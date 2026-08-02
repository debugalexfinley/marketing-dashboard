# Spec: Phase 2 — HermesAgentBackend adapter (+ persona rename)

## Goal
After this change, a `HermesInstance` with `kind: 'hermes'` and a `homeDir`
serves the entire dashboard from a live Hermes Agent home: agents page shows the
profile with real model/gateway state, sessions sync from `state.db` with real
token/cost data, cron jobs display from `jobs.json` (including delivery-error
warnings) with runs from `executions.db`, and mutations/messaging go through the
`hermes` CLI. OpenClaw instances keep working byte-identically. The app's
marketing persona is renamed "Maven" so "Hermes" unambiguously means the agent
platform. Authoritative contract: `feature-research/hermes-port/hermes-mapping.md`
— READ IT FULLY FIRST; every path, schema, CLI verb, and risk decision below
references it. Branch: `hermes-port-phase2` off `hermes-port-phase1` (5054ca7).

## Files touched
New:
- src/lib/backend/hermesAgent.ts        (the adapter — class HermesAgentBackend)
- src/lib/backend/hermesAgent.test.ts
- feature-research/hermes-port/fixtures/gen-hermes-home.mjs   (fixture generator)
- feature-research/hermes-port/fixtures/hermes-bin/hermes     (stub CLI for tests)
- feature-research/hermes-port/golden/baseline-hermes/*.json  (new baseline)
Modified:
- src/lib/backend/index.ts     (resolveBackend: kind 'hermes' → HermesAgentBackend)
- src/lib/backend/types.ts     (additive only: optional fields the adapter needs)
- src/lib/instances.ts         (parse `homeDir` + optional `profile` per instance)
- src/lib/agent-config.ts      (persona rename ONLY — see F-rename)
- feature-research/hermes-port/golden/capture.mjs  (add --backend hermes mode)
- package.json                 (only if a script entry is needed)
HARD BOUNDARY: no route files, no components, nothing else. If a route needs a
change to work with the hermes backend, STOP and report — that means the
interface abstraction failed and we need to know, not patch around it.

## Design rules (from hermes-mapping.md "Risks & decisions" — binding)
- Reads = files/SQLite directly. Writes + agent messaging = `hermes` CLI only.
  Never write `cron/jobs.json` directly.
- `state.db` opened read-only `mode=ro` via better-sqlite3; never `immutable`.
- Every optional store missing ⇒ empty result, never an error (`projects.db`,
  `executions.db`, `cron/output/`, even `state.db` in a bare profile).
- Unknown jobs.json fields: tolerate AND preserve (round-trip safe).
- Timestamps normalized to epoch-ms at the adapter boundary (jobs/executions =
  ISO w/ local offset; state.db = epoch seconds; heartbeats = UTC ISO).
- Fail LOUD (typed error, surfaces as 500) on unrecognized `state.db`
  schema_version — never silently empty. Record the seen version in the error.
- Secrets: whitelist-extract from config.yaml (model.*, agent.reasoning_effort,
  gateway booleans). NEVER return raw config, `system_prompt`, `origin_json`,
  or `.env`/`auth.json` content through any interface method.
- Adapter code names: `HermesAgentBackend`, `hermesAgent*`. The adapter must not
  read the app's own `HERMES_*` env vars.

## Method mapping (details in hermes-mapping.md — implement to that doc)
- listAgents: the instance's homeDir IS one profile → one AgentDefinition:
  name (instance `profile` or basename/`default`), description (profile.yaml),
  model (config.yaml model.default whitelist), gatewayRunning (state/
  gateway.heartbeat pid + staleness <120s).
- readModelRouting: `{default:{provider,model}, fallbacks:[], moa?, cronOverrides[]}`
  from config.yaml (+ per-job model/provider pins from jobs.json).
- listCronJobs: parse jobs.json; map to interface CronJob shape; expose
  `last_delivery_error` as a distinct `deliveryError` warning field (risk #11 —
  job ok + delivery failed is real and must be visible).
- writeCronJobs/upsert/toggle: shell to `hermes -p <profile> cron
  create/edit/pause/resume/remove` (binary path: instance-configurable, default
  `hermes` on PATH); verify each mutation by re-reading jobs.json.
- readCronRuns: executions.db `SELECT ... WHERE job_id=? ORDER BY claimed_at
  DESC LIMIT ?`; enrich with cost by joining state.db sessions on the
  `cron_<jobid>_<ts>` id prefix (risk #9 — heuristic, MUST have a fixture test
  so a Hermes rename breaks CI not prod).
- tailCronLog: newest files from cron/output/<id>/ + last_error/
  last_delivery_error/last_status headline from jobs.json.
- readSessions/readSessionEntries/readSessionUsage: state.db sessions/messages/
  session_model_usage; session "ref" = session id + message-rowid cursor
  (fabricate the interface's file-shaped fields deterministically); usage totals
  include cache/reasoning tokens + estimated/actual USD with
  `cost_status` passthrough ("may be zero/unknown under subscription billing").
- sendAgentMessage: `hermes -p <profile> -z "<msg>" --usage-file <tmp>` —
  10-min timeout, always parse the usage file (schema in mapping doc), return
  response text + sessionId from the usage report. sendOrchestratorMessage:
  same (no separate orchestrator concept; document as alias).
- validateConfig: `hermes -p <profile> doctor < /dev/null`; parse ✓/⚠/✗ glyph
  markers into {ok, warnings[], errors[]}; degrade to exit-code-only if the
  format changed. Cache for 60s.
- readHealthReport: memory-* kinds → null (stub, UI tolerates). Implement
  'gateway' kind from state/gateway.heartbeat + gateway.lifecycle.json +
  gateway_state.json (per-platform connectivity).
- readAuditLog / readDeployLogs: empty results (no Hermes equivalent).
- listWorkspaceRoots/resolveWorkspacePath: projects.db project_folders +
  discovered_repos + distinct sessions.cwd/git_repo_root, deduped; same
  traversal guards as the OpenClaw impl (reuse its guard helpers).

## F-rename (persona)
In agent-config.ts only: static persona display name "Hermes — Marketing
Engine" → "Maven — Marketing Engine" (and any adjacent "Hermes" display
strings for that persona). Agent IDS and ACTION_TO_AGENT keys UNCHANGED —
display names only. This may change OpenClaw golden output: regenerate the
OpenClaw baseline ONLY IF the diff contains nothing but the persona name
strings — include that diff verbatim in the audit. Any other diff = stop.

## Fixtures & tests
- gen-hermes-home.mjs builds TWO fixture homes into a temp dir at test time
  (deterministic: fixed timestamps, TZ-independent): `full` (config.yaml with
  model+moa+a basic_auth.password_hash SECRET SENTINEL string, profile.yaml,
  state.db with 3 sessions incl one `cron_<jobid>_<ts>` + messages + usage rows,
  cron/jobs.json with agent job + no_agent script job + one job with
  last_delivery_error set + unknown extra field, executions.db, cron/output
  files, heartbeat/lifecycle/gateway_state JSONs, projects.db) and `bare`
  (config.yaml only — exercises every missing-store path).
- hermes-bin/hermes stub: records argv to a log, emits canned outputs —
  `-z` prints a fixed reply + writes a valid usage-file; `cron create/edit/...`
  mutate the fixture jobs.json the way real Hermes would (minimal); `doctor`
  prints a canned ✓/⚠ report. Unit tests point the adapter's binary path at it.
- Unit tests must cover: every method against `full` AND `bare`; unknown-field
  round-trip preservation; schema_version mismatch → loud typed error;
  timestamp normalization (feed all three formats); cron↔session join guard;
  deliveryError surfacing; secrets non-leak (the SENTINEL string appears in NO
  method result — iterate all read methods and JSON.stringify-scan).
- Golden: `capture.mjs --backend hermes` boots the app with one hermes-kind
  instance pointed at the generated `full` fixture (TZ pinned) and captures the
  same 19 routes → commit `baseline-hermes/`; `--check` mode covers both
  baselines from now on.

## Acceptance checks
1. `pnpm typecheck` clean.
2. `pnpm test` all pass (existing 45 + new hermesAgent tests; new tests
   obviously fail before the adapter exists — no spot-verify needed, but the
   secrets-sentinel and join-guard tests must be shown failing if the guard
   condition is deliberately broken, to prove they bite).
3. OpenClaw golden `--check`: byte-identical, OR persona-rename-only diff
   handled per F-rename with the diff in the audit.
4. Hermes golden `--backend hermes --check`: exit 0 against the committed new
   baseline, run twice to prove determinism.
5. better-sqlite3 bundled SQLite version printed and asserted ≥ 3.50.7
   (WAL-reset bug — risk #2); include the actual version in the audit.
6. Live read-only smoke on this Mac (run directly, NOT via fixtures): a small
   script (may live in scratchpad, not committed) that instantiates
   HermesAgentBackend with homeDir=/Users/alexfinley/.hermes and calls
   listAgents, listCronJobs, readSessions, readHealthReport('gateway') —
   prints summaries. MUST be strictly read-only: no CLI mutations, no `-z`
   (no spend), sqlite mode=ro. Paste the output in the audit. Expected:
   default profile w/ model grok-4.5, ≥5 cron jobs incl one with a
   last_delivery_error, ≥50 sessions, gateway running.
7. `git diff hermes-port-phase1 -- src/app/api` → empty (hard boundary held).

## Constraints
Original phase-1 constraints stand (no pushes, checkpoint commit on green,
match style, no new deps beyond what's already in package.json — better-sqlite3
is already there). The live smoke (check 6) is the ONLY thing allowed to touch
/Users/alexfinley/.hermes and it is read-only.

## Output contract
Audit at feature-research/hermes-port/audit-phase2.md: files changed, method-by-
method conformance notes vs hermes-mapping.md, the F-rename golden diff, all
seven acceptance outputs, deviations, open risks for phase 3.
