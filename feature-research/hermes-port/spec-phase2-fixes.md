# Spec: Phase 2 fix pass — implement stubbed methods + 2 confirmed bugs

## Goal
Complete the HermesAgentBackend: the six-plus stubbed `call3()` methods are
really implemented (CLI-argv based), the session-sync cursor stops permanently
skipping sessions after first sync, and the workspace read path cannot serve
secrets from a Hermes home. Branch `hermes-port-phase2` (head 0c013e0).
Context: spec-phase2.md (design rules are BINDING), hermes-mapping.md (CLI verbs
and paths), and the phase-2 review findings summarized below.

## Files touched
- src/lib/backend/hermesAgent.ts
- src/lib/backend/hermesAgent.test.ts
- feature-research/hermes-port/fixtures/gen-hermes-home.mjs
- feature-research/hermes-port/fixtures/hermes-bin/hermes  (stub CLI: record argv, emit canned output)
- feature-research/hermes-port/golden/baseline-hermes/**   (ONLY if a check proves regeneration needed — otherwise untouched; any diff must be explained)
- feature-research/hermes-port/audit-phase2.md             (append "Fix pass")
HARD BOUNDARY: nothing else. No route/component edits.

## B1 — Implement the stubbed methods (blocker)
`call3()` at hermesAgent.ts:402 and every caller (writeCronJobs:585,
upsertCronJob:590, toggleCronJob:596, sendAgentMessage:875,
sendOrchestratorMessage:881, validateConfig:885, writeHealthPolicy:919,
createWorkspaceFile:1051, updateWorkspaceFile:1062, deleteWorkspaceFile:1068).
Delete `call3` entirely when done — no stub helper may remain.

Implement per spec-phase2.md's method mapping + hermes-mapping.md:
- Cron mutations → `hermes -p <profile> cron create|edit|pause|resume|remove`
  (mapping doc has exact flags). After EVERY mutation, re-read jobs.json to
  verify and to return fresh state. Never write jobs.json directly.
- `sendAgentMessage` → `hermes -p <profile> -z <msg> --usage-file <tmpfile>`,
  10-min timeout, parse the usage JSON (keys listed in mapping doc), return
  `{response: stdout, sessionId: usage.session_id, ...}`. Always clean up the
  tmpfile. `sendOrchestratorMessage` = same path (document as alias).
- `validateConfig` → `hermes -p <profile> doctor` with stdin /dev/null; parse
  ✓/⚠/✗ glyphs into {ok, warnings[], errors[]}; degrade to exit-code-only if
  parsing fails; cache 60s.
- `writeHealthPolicy` → no Hermes equivalent: throw the SAME typed
  "writes disabled/unsupported" error shape the OpenClaw backend uses when its
  policy-write flag is off (so routes produce the existing 403-style response,
  not a 500). Document the choice.
- Workspace create/update/delete → real fs writes under the resolved root, with
  the SAME guards the OpenClaw backend applies (write-allowed flag, path
  allowlist, traversal rejection, max size) — reuse its helpers.

**SECURITY (non-negotiable):** every CLI invocation uses an argv ARRAY with
`shell: false`. No string interpolation into a shell, ever. Job names, prompts,
schedules and messages are user-controlled.

## B2 — Session sync cursor unit mismatch (blocker)
hermesAgent.ts:709-731: `SessionFileRef.size` is fabricated as
`Buffer.byteLength(id + name)` (tiny constant) while `readSessionEntries`
returns `nextOffset` = a `messages.id` rowid (large, growing). The sync route
(src/app/api/chat/sync-sessions/route.ts:47-56) skips when
`ref.size <= lastOffset`, so after the first sync every session is skipped
forever and new messages never import.
FIX: make `size` the same unit as the cursor — set `size` = the session's
current MAX(messages.id) (0 when no messages). Then `size <= lastOffset`
correctly means "nothing new since last sync". Keep `nextOffset` as MAX(id)
consumed. Verify the route's skip/import logic end-to-end in a test that syncs
twice with a message inserted between runs: run 1 imports N, run 2 imports only
the new one (not zero, not duplicates).

## B3 — Workspace secrets exposure (blocker)
hermesAgent.ts:946-1033: roots derive from `sessions.cwd`/`git_repo_root`
(uncurated) and `shouldHideWorkspaceEntry` (line ~355) is applied ONLY in
directory listing, not on the direct single-file read path — so
`readWorkspace(root, ".env")` / `"auth.json"` can return raw secrets, and a root
may even BE the Hermes home.
FIX (both layers):
1. Root curation: exclude any candidate root that is the Hermes home itself or
   any ancestor/descendant of it (realpath-normalized comparison), for every
   root source.
2. Read path: apply the same hidden/secret-entry filter to single-file reads —
   a request for a filtered path returns the same not-found/forbidden response
   the listing path implies. Filter must cover at minimum: dotfiles,
   `auth.json`, `*.env`, `config.yaml`, `state.db*`, `token*`, `*credential*`.
Tests: fixture home whose sessions.cwd points AT the Hermes home; assert the
root is excluded AND that direct reads of `.env`/`auth.json` are refused.

## N1 — Cron↔session join bound (non-blocking, do it)
hermesAgent.ts:599-624: nearest-in-time match with no max distance means one
session's cost can be attributed to many runs. Add a bound (session start within
±10 minutes of the run's claimed_at) and attribute nothing when outside it.
Test with two runs + one session.

## N2 — Injection test scaffolding (required alongside B1)
Fixture jobs/prompts must include adversarial strings (`; rm -rf /`, backticks,
`$(id)`, quotes, newlines). Stub CLI records argv to a file; tests assert the
adversarial string arrives as ONE argv element, unmodified, and that no shell
metacharacter is interpreted. A test must fail if someone switches to shell:true
or string concatenation.

## Acceptance checks
1. `pnpm typecheck` clean; `pnpm test` all pass, including new tests for B1
   (each implemented method exercised against the stub CLI), B2 (double-sync),
   B3 (root exclusion + refused secret read), N1, N2 (argv integrity).
2. `grep -rn "call3\|implemented in call" src/lib/backend/` → ZERO matches.
3. Hermes golden `--backend hermes --check` — passes (twice). OpenClaw golden
   `--check` — passes.
4. LIVE READ-ONLY smoke against /Users/alexfinley/.hermes unchanged and still
   passing (reads only — NO cron mutations, NO `-z`, no writes of any kind).
   Paste output.
5. `git diff hermes-port-phase1 -- src/app/api` → empty.
6. Anti-vacuity: for B2 and B3, show each new test FAILING when its fix is
   reverted (paste both outputs).

## Constraints
Design rules from spec-phase2.md remain binding (read-only sqlite, missing
store ⇒ empty, loud on unknown schema, secret whitelisting, no `HERMES_*` app
env reads in the adapter). No pushes. Checkpoint commit on green. No new deps.
The live Hermes home is READ-ONLY for the entire pass — all mutation testing
goes through fixtures + the stub CLI.

## Output contract
Append "Fix pass (post-review)" to audit-phase2.md: finding→fix mapping, the
argv-safety approach, all six acceptance outputs, deviations, and an explicit
corrected statement of what phase 2 now delivers.
