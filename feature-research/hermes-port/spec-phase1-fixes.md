# Spec: Phase 1 fix pass — reconciled dual-review findings

## Goal
Close every confirmed behavior divergence from the Codex + Grok blind reviews so
phase 1 is a true no-behavior-change extraction, and harden the test net where
both reviews showed it was blind (write paths, error paths, dual-schema). Branch
`hermes-port-phase1`, repo `/Users/alexfinley/Documents/GitHub/marketing-dashboard`.
Reviews are authoritative context: read this file fully; original spec
`spec-phase1.md` still governs anything not amended here.

## Files touched
- src/lib/backend/openclaw.ts
- src/lib/backend/types.ts
- src/lib/backend/index.ts
- src/lib/backend/openclaw.test.ts
- src/lib/agent-config.ts (deprecation comment fix only)
- src/app/api/hud/route.ts (only if needed to restore tolerant counting)
- feature-research/hermes-port/fixtures/openclaw-home/** (additions)
- feature-research/hermes-port/fixtures/openclaw-home-arrayform/** (new fixture tree)
- feature-research/hermes-port/golden/capture.mjs (compare mode + marker fix)
- package.json (add golden:check script only)
HARD BOUNDARY unchanged: nothing else.

## Fixes (each maps to review findings)

### F1 — Restore the divergent openclaw.json parsers (BLOCKING, found by both)
`configuredAgentList()` (openclaw.ts:243) must be split back into two readings:
- Agent-config path (`listConfiguredAgents`, feeding /api/agents, automations,
  chat/messages allowlist, chat/sync-sessions, mission-control/chat): accepts
  ONLY `config.agents.list` (pre-refactor agent-config.ts:252 semantics).
- Workspace-roots path (`listWorkspaceRoots`): additionally accepts top-level
  `agents: [...]` array (pre-refactor workspace-roots readAgentList semantics).
Also restore the dropped `!entry` guard (grok c1#1): null/undefined entries in
`agents.list` are SKIPPED, never thrown on (pre-refactor agent-config guard).

### F2 — Restore HUD's tolerant cron counting (BLOCKING, Codex)
hud/route.ts previously counted jobs with its own raw tolerant parse (any array
element via isRecord/enabled/state.lastStatus checks, no normalization).
Restore exactly that tolerance — either a `readCronJobsTolerantCounts()` backend
method with the old inline logic verbatim, or reinstate the inline parse in the
route reading via a raw-file accessor. Malformed/partial entries count as before.

### F3 — Restore original error semantics (BLOCKING, Codex + grok c1#5)
- openclaw.ts:902 (readCronRuns for automations): non-ENOENT run-file read errors
  → swallowed to empty list (old behavior), not propagated.
- openclaw.ts:946 (session dir enumeration for sync-sessions): enumeration
  errors → THROW (old behavior errored the route), not silent empty.
- openclaw.ts:1130 (readAuditLog for memory-effect): only missing-file errors
  swallowed; other read failures bubble so the route 500s as before.
- readCronNotificationJobs (openclaw.ts:860): non-array `jobs` value → iterate
  as old `data.jobs || []` for-of did (a string iterates characters); never
  throw TypeError.

### F4 — /api/agents model-routing alias semantics (grok c2#1)
Restore keyed lookup equivalent to old `list.find(a => a.id === agentId)` on the
normalized id; an aliased id that misses falls back exactly as pre-refactor
(defaults), not to the agent's resolved model. Verify against `git show
96700db:src/app/api/agents/route.ts` and preserve its exact precedence.

### F5 — Workspace write guards into the backend (both reviews, hygiene)
`createWorkspaceFile`/`updateWorkspaceFile`/`deleteWorkspaceFile` internally
call `assertWorkspaceWriteAllowed()` AND apply the same path-allowlist and
max-size checks the route enforces (duplicated defense; route behavior/messages
unchanged — assert identical route responses via tests).

### F6 — Interface polish (grok c1 #6/#7)
`sendOrchestratorMessage` regains optional `sessionId` param. Note (no code
change needed) in types.ts docblock that sendAgentMessage returns CommandResult
superset of old `{response, sessionId?}` — callers unaffected.

### F7 — Fix misleading deprecation comment (grok c1#3)
agent-config.ts deprecation comment must point to `listConfiguredAgents()` (the
no-change equivalent), NOT `listAgents()` (which merges filesystem discovery).

### F8 — Test-net hardening (grok c3 blockers/majors — the minimum set)
- New fixture tree `openclaw-home-arrayform/` with top-level `agents: [...]`
  form; unit tests asserting: agent-config path sees ZERO configured agents,
  workspace-roots path sees them. This locks F1's divergence permanently.
- Unit tests for F2 (malformed job entry counted tolerantly by HUD path) and
  each F3 semantic (use chmod-000 / corrupt-file fixtures).
- Write-path tests with flags ENABLED (temp dir): writeCronJobs produces `.bak`
  rotation + atomic write; workspace create/update/delete respect path
  allowlist + size caps; traversal attempts (`../`, absolute) rejected.
- capture.mjs: add `--check` mode (re-capture + diff against baseline,
  nonzero exit on any difference); create the missing `bin/golden-deploy-marker`
  fixture; add `"golden:check"` script to package.json. (Full write-path golden
  coverage is explicitly deferred — unit tests above cover it.)

### Explicitly NOT changed (reviewed, accepted)
- `kind: 'hermes'` throwing "phase 2" — spec-sanctioned, stands.
- memory-policy sanitize ownership moving into backend — noted for phase 2.
- Promise.all enrichment in /api/agents — accepted (stable-FS equivalent).
- Backend cache stickiness — accepted until phase 2 introduces live kinds.

## Acceptance checks
1. `pnpm typecheck` clean.
2. `pnpm test` all pass, including every new F8 test (each new test must FAIL
   against commit 7e544dc — spot-verify at least the arrayform divergence test
   and one F3 test by running them on that commit before fixing).
3. `node feature-research/hermes-port/golden/capture.mjs --check` → exit 0
   (byte-identical to the existing committed baseline — fixes must not change
   happy-path reads).
4. Greps from original spec still zero (no fs/spawn in routes; no
   resolveOpenClawPaths in routes).
5. `git diff 96700db -- src/app/api` reviewed: hud/route.ts is the ONLY route
   with new logic vs the reviewed head, and only for F2.

## Constraints
Original spec constraints stand. Checkpoint-commit when acceptance goes green.
No pushes.

## Output contract
Append a "Fix pass" section to feature-research/hermes-port/audit-phase1.md:
finding→fix mapping, test evidence (command outputs), anything consciously
deferred.
