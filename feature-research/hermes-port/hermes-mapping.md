# Hermes Agent ↔ AgentBackend contract mapping (Phase 2.0)

Verified 2026-08-01 against the LIVE install on the Mac Mini:
- Hermes Agent **0.19.1** (`hermes doctor`), config version **33**, binary `~/.local/bin/hermes`
- Home `~/.hermes`, source `~/.hermes/hermes-agent`, docs `~/.hermes/hermes-agent/website/docs/`
- Live profiles at time of writing: `default` (root home), `realtor`, `sarah`

All examples below are from real files/commands on this machine with identifiers,
hashes, and message content redacted or replaced by `<placeholders>`. Nothing was
mutated: only `--help`, `list`/`status`/`doctor`/`check` reads, read-only SQLite,
and one `sessions export` to stdout were run.

---

## Ground truth: the Hermes home layout (everything keys off this)

A "Hermes home" is one directory. The default is `~/.hermes`; **every named
profile is a complete replica of the same layout** at
`~/.hermes/profiles/<name>/`. `HERMES_HOME` env var overrides the home entirely
(documented in `website/docs/reference/environment-variables.md`; resolved in
`hermes_constants.py`). This is the whole multi-tenancy story.

```
<HOME>/
  config.yaml            # model, agent, gateway, platform config (YAML)
  .env                   # provider API keys (secret — never read into the UI)
  auth.json              # OAuth credential store (secret)
  profile.yaml           # (profile homes only) description for the profile
  state.db (+ -wal/-shm) # SQLite: sessions, messages, per-model usage  ← transcripts live HERE
  sessions/
    sessions.json        # LEGACY mirror of gateway routing — NOT the session list
    request_dump_*.json  # debug request dumps — ignore
  cron/
    jobs.json            # job definitions (flock via .jobs.lock)
    executions.db        # SQLite: durable run attempts
    output/<job_id>/<ts>.md   # one markdown file per run (the "cron log")
    ticker_heartbeat     # scheduler liveness (epoch text)
  state/
    gateway.heartbeat        # {"pid","updated_at","monotonic","start_time"}
    gateway.lifecycle.json   # {"phase","pid","start_time","started_at"}
  gateway_state.json     # per-platform connection state (see readHealthReport)
  projects.db            # named multi-folder workspaces (lazily created)
  logs/                  # gateway.log, agent.log, errors.log, ...
  skills/ memories/ workspace/ scripts/ monitors/ ...
```

**Adapter rule:** `HermesInstance` carries a single `homeDir`; every path below
is `join(homeDir, ...)`. `kind: 'hermes'` + `homeDir` is the entire config.

---

## listAgents → Hermes profiles

**Source of truth (files):** enumerate `~/.hermes/profiles/*/` directories, plus
the root home itself as the `default` profile. Each profile dir may contain
`profile.yaml`:

```yaml
# ~/.hermes/profiles/sarah/profile.yaml (real)
description: Senior developer agent on Codex gpt-5.6-sol (medium). Plans, builds,
  dispatches fable-planner/reviewer + codex/grok builders + scouts. Subscription-priced.
description_auto: false
```

**CLI:** `hermes profile list` — human table only, **no JSON mode**:

```
 Profile      Model        Gateway   Alias     Distribution
 ◆default     grok-4.5     running   —         —
  realtor     grok-4-5     stopped   realtor   realtor@0.1.0
  sarah       gpt-5.6-sol  running   sarah     —
```

Per-profile gateway run-state also via `hermes gateway status` (shows launchd
supervision + "Other profiles: sarah — PID <n>").

**Data shape (adapter):** `{ name, description?, model (from that home's
config.yaml model.default), gatewayRunning (from state/gateway.heartbeat pid
liveness), distribution? (hermes profile info) }`.

**Gaps:** no JSON output; parse the filesystem, not the table. Profile aliases
are wrapper scripts in `~/.local/bin/<alias>` containing
`exec hermes -p <name> "$@"` — useful to know, not needed by the adapter.

**Multi-profile:** this method IS the tenant enumerator. In the single-tenant
dashboard container each `HermesInstance` = one profile home, so `listAgents`
usually returns exactly one entry (plus subagents are NOT separate profiles —
Hermes "personalities" in config.yaml are prompt presets, not agents).

---

## readModelRouting

**Sources (all inside the profile home):**
1. `config.yaml` → `model.default`, `model.provider`, `model.base_url`,
   `agent.reasoning_effort`. Real example (root profile):
   ```yaml
   model:
     default: grok-4.5
     provider: xai-oauth
     base_url: https://api.x.ai/v1
   agent:
     reasoning_effort: medium
   ```
   Per-profile differs (sarah: `gpt-5.6-sol` / `openai-codex`; realtor:
   `grok-4-5` / custom `providers.kie` block).
2. Fallback chain: `hermes fallback list` / `fallback:` key in config.yaml
   (absent on this machine = no chain).
3. MoA (mixture-of-agents) routing: `moa:` block in config.yaml —
   `reference_models[] {provider, model}` + `aggregator {provider, model}` +
   `enabled`. This machine fans out to gpt-5.6-sol + grok-4.5 + claude-fable-5,
   aggregated by grok-4.5.
4. Per-cron-job pins: `cron/jobs.json` fields `model`, `provider`, and the
   audit trail `model_snapshot` / `provider_snapshot`.

**CLI:** `hermes config get model.default` prints a single resolved value —
handy for smoke tests. `hermes model` is interactive-only (do not shell out).

**Gaps:** OpenClaw's per-agent routing table collapses to "one profile, one
default model + fallback chain + MoA". Represent routing as
`{ default: {provider, model}, fallbacks: [], moa?: {...}, cronOverrides: [] }`.

**Multi-profile:** read `<profileHome>/config.yaml` — each tenant has fully
independent routing.

---

## listCronJobs

**File:** `<HOME>/cron/jobs.json`. Top level: `{ "jobs": [...], "updated_at": <ts> }`
(`updated_at` is a cheap cache-invalidation key). Real job (redacted):

```json
{
  "id": "a9ce2d311889",
  "name": "balance-watch",
  "prompt": "",
  "skills": [], "skill": null,
  "model": null, "provider": null,
  "provider_snapshot": null, "model_snapshot": null, "base_url": null,
  "script": "balance-check.py",
  "no_agent": true,
  "context_from": null,
  "schedule": { "kind": "cron", "expr": "0 9 * * *", "display": "0 9 * * *" },
  "schedule_display": "0 9 * * *",
  "repeat": { "times": null, "completed": 20 },
  "enabled": true,
  "state": "scheduled",
  "paused_at": null, "paused_reason": null,
  "created_at": "2026-07-12T20:42:58.388824-05:00",
  "next_run_at": "2026-08-02T09:00:00-05:00",
  "last_run_at": "2026-08-01T09:00:16.101364-05:00",
  "last_status": "ok",
  "last_error": null,
  "last_delivery_error": "no delivery target resolved for deliver=telegram",
  "deliver": "telegram",
  "origin": null, "enabled_toolsets": null, "workdir": null, "fire_claim": null
}
```

Interval schedules look like `{"kind":"interval","minutes":60,"display":"every 60m"}`.
Two job modes: agent jobs (`prompt` + optional `skills`, LLM runs) and
`no_agent: true` script jobs (script stdout delivered verbatim). Full field list
verified on-disk: `base_url, context_from, created_at, deliver, enabled,
enabled_toolsets, fire_claim, id, last_delivery_error, last_error, last_run_at,
last_status, model, model_snapshot, name, next_run_at, no_agent, origin,
paused_at, paused_reason, prompt, provider, provider_snapshot, repeat, schedule,
schedule_display, script, skill, skills, state, workdir`.

**CLI:** `hermes cron list [--all]` — human-readable card layout, **no JSON**.
Parse `jobs.json` directly.

**Gaps:** none material. The `EXPERIMENT_CONTRACT:` text convention lives in the
`prompt` string and survives round-trips untouched. Job `id` is 12-hex and is
the primary key (names are not unique).

**Multi-profile:** `<profileHome>/cron/jobs.json` (verified: `profiles/sarah/cron/`
exists with its own ticker heartbeat + output dir).

---

## writeCronJobs

**Recommended path: shell out to the CLI**, never hand-write `jobs.json`:
- `hermes cron create '<schedule>' '<prompt>' --name N [--deliver T] [--skill S]
  [--script F] [--no-agent] [--workdir D] [--model M --provider P]`
- `hermes cron edit <job_id> [--schedule ...] [--prompt ...] [--name ...]
  [--deliver ...] [--skill/--add-skill/--remove-skill/--clear-skills] ...`
- `hermes cron pause|resume|remove <job_id>`, `hermes cron run <job_id>`
  (fire on next tick).
- Per-profile: prefix with `-p <profile>` (e.g. `hermes -p sarah cron list`).

**Why not direct file writes:** the store is guarded by a **cross-process
`flock` on `cron/.jobs.lock`** (see `hermes-agent/cron/jobs.py`; 30s bounded
wait, gateway ticker holds it during mutations). The CLI honors the lock and the
scheduler picks changes up on the next tick. If the adapter ever must write the
file (bulk import), it MUST take the same flock and preserve unknown fields.

**Gaps:** CLI mutations print human text with exit codes, no JSON — verify by
re-reading `jobs.json` after the call (the same pattern the OpenClaw impl used).

---

## readCronRuns(jobId)

**File:** `<HOME>/cron/executions.db` (SQLite, WAL off). Single `executions`
table — schema verified:

```sql
CREATE TABLE executions (
  id TEXT PRIMARY KEY,            -- 32-hex run id
  job_id TEXT NOT NULL,
  source TEXT NOT NULL,           -- 'builtin' on this machine
  process_id TEXT NOT NULL, pid INTEGER NOT NULL, process_started_at INTEGER,
  status TEXT NOT NULL CHECK(status IN
    ('claimed','running','completed','failed','unknown')),
  claimed_at TEXT NOT NULL,       -- ISO with local tz offset
  started_at TEXT, finished_at TEXT,
  error TEXT
);
```

Real row: `8243e33d…| 8671f8cf16b8 | builtin | … | completed |
2026-08-01T18:48:55.161770-05:00 | …55.481585… | …56.733275… | (null)`.

**CLI:** `hermes cron runs [job_id] --limit N` (N 1–500) — text lines, no JSON.
Query the DB read-only instead: `SELECT ... WHERE job_id=? ORDER BY claimed_at DESC`.

**Gaps:** no per-run token/cost here — but agent-mode runs create sessions in
`state.db` with ids like `cron_<job_id>_<YYYYMMDD_HHMMSS>` (verified:
`cron_03bb9da5cbf5_20260801_030037` with full token/cost rows). Join on that
prefix to give cron runs real cost data — **something OpenClaw never had**.

---

## tailCronLog(jobId)

**Files:** `<HOME>/cron/output/<job_id>/<YYYY-MM-DD_HH-MM-SS>.md` — one
Markdown file per run, newest = lexicographically last. Verified shape:

```markdown
# Cron Job: site-health

**Job ID:** 95f6886aa96d
**Run Time:** 2026-07-30 16:47:39
**Mode:** no_agent (script)

---

<run output — script stdout or the agent's final response>
```

**Adapter:** `tailCronLog(jobId)` = read the latest N files from that dir
(sorted desc), plus `last_error` / `last_delivery_error` / `last_status` from
`jobs.json` for the failure headline. Scheduler liveness: `cron/ticker_heartbeat`
(epoch seconds text) and `hermes cron status`.

**Gaps:** these are per-run outputs, not streaming logs; there is no live tail
of an in-flight agent run (gateway's `logs/gateway.log` is global, unstructured).
Acceptable: OpenClaw's tail was also post-hoc.

---

## readSessions(agentId) — the biggest divergence from OpenClaw

**There is no transcript JSONL on disk.** Sessions and full transcripts live in
**SQLite: `<HOME>/state.db`** (WAL mode). `sessions/sessions.json` is explicitly
a *legacy mirror of the gateway routing index* (its own `_README` says so — "This
is NOT the session list. ALL sessions … live in ~/.hermes/state.db"); the
`request_dump_*.json` files beside it are debug dumps. Ignore both.

**Tables (schema verified):**
- `sessions` — one row per session. Key columns: `id` (e.g.
  `20260801_114252_bc75d004` or `cron_<jobid>_<ts>`), `source`
  (cli|discord|telegram|…), `user_id, session_key, chat_id, chat_type,
  thread_id, display_name, origin_json`, `model, model_config, system_prompt`,
  `parent_session_id`, `started_at/ended_at` (REAL epoch), `end_reason`,
  `message_count, tool_call_count`, **`input_tokens, output_tokens,
  cache_read_tokens, cache_write_tokens, reasoning_tokens`**,
  `cwd, git_branch, git_repo_root`, `billing_provider/base_url/mode`,
  **`estimated_cost_usd, actual_cost_usd, cost_status, cost_source,
  pricing_version`**, `title, api_call_count`, `archived, pinned, profile_name`.
- `messages` — one row per transcript message: `id, session_id, role
  (user|assistant|tool|session_meta), content, tool_call_id, tool_calls,
  tool_name, timestamp (REAL epoch), token_count, finish_reason, reasoning,
  reasoning_content, reasoning_details, codex_reasoning_items,
  codex_message_items, platform_message_id, active, compacted, api_content,
  display_kind, display_metadata`.
- `session_model_usage` — **per-model cost breakdown per session**:
  `(session_id, model, billing_provider, billing_base_url, billing_mode, task)`
  PK + `api_call_count, input/output/cache_read/cache_write/reasoning_tokens,
  estimated_cost_usd, actual_cost_usd, cost_status, cost_source,
  first_seen, last_seen`.
- `messages_fts` / `messages_fts_trigram` — FTS5 full-text index over messages.

Real (redacted) session row: `20260801_114252_bc75d004 | discord | group |
grok-4.5 | … | 9 msgs | 4 tool calls | in=28057 out=409 cache_read=53632
reasoning=148 | est_cost=0.0 cost_status=unknown cost_source=none | title="…"`.

**Token/cost answer:** per-message `token_count` exists but is sparsely
populated; per-session totals and per-(session, model) usage are reliably
populated, including cache and reasoning tokens and estimated/actual USD.
OAuth-subscription runs show `estimated_cost_usd = 0.0, cost_status=unknown` —
treat cost as "may be zero/unknown under subscription billing".

**JSONL, if wanted:** `hermes sessions export --format jsonl --session-id <id> -`
emits **one JSON object per SESSION** (not per message): all `sessions` columns
plus a `messages: [...]` array whose elements carry all `messages` columns.
Rich filters exist (`--source --newer-than --min-cost --min-tokens …`). Also
`--format trace` emits Claude-Code-style JSONL.

**CLI list:** `hermes sessions list [--source S] [--limit N] [--workspace NEEDLE]`
— human table only.

**Adapter recommendation:** open `state.db` **read-only** (`mode=ro`, do NOT use
`immutable=1` — the DB is WAL and actively written) and query directly; fall
back to `sessions export --format jsonl` for bulk sync. The dashboard's
sync-sessions job maps 1:1: `SELECT` from `sessions`/`messages` newer than a
cursor on `started_at`/`timestamp`.

**Multi-profile:** `<profileHome>/state.db` — verified `profiles/sarah/state.db`
has the identical table set. Note `sessions.profile_name` also exists inside
each DB but per-home DBs are the real isolation boundary.

---

## sendAgentMessage

Two different Hermes verbs — do not confuse them:

1. **Talk TO the agent** (the OpenClaw `openclaw agent --message` replacement):
   ```
   hermes -p <profile> -z "<prompt>" --usage-file /tmp/usage.json
   ```
   `-z/--oneshot`: sends one prompt through the FULL agent (tools, memory, skills)
   and prints **only the final response text** to stdout — no banner, no spinner,
   no session line. `--usage-file` (one-shot only) writes a JSON report even on
   failure, with exactly these keys (verified in `hermes_cli/oneshot.py`):
   `estimated_cost_usd, cost_status, cost_source, input_tokens, output_tokens,
   cache_read_tokens, cache_write_tokens, reasoning_tokens, total_tokens,
   api_calls, model, provider, session_id, completed, failed, service_tier
   [, failure]`.
   The `session_id` in that report is how the dashboard links the exchange back
   to `state.db`. Interactive/programmatic alternative: `hermes chat -q "<prompt>" -Q`
   (quiet mode), `--resume <session_id>` to continue a session.
2. **Deliver a notification to a messaging platform** (no LLM):
   ```
   hermes send --to discord:#ops --json "text"
   ```
   `hermes send` has a real `--json` output mode and `--list` for targets; exit
   codes 0 ok / 1 delivery error / 2 usage error. This is the analogue for the
   dashboard's "notify" paths, not for chatting with the agent.

**Gaps:** `-z` has no JSON envelope for the response itself (stdout = text).
That matches the interface (it returns the reply string). A `-z` run is a full
agent loop — it can take minutes and spend tokens; the 2.1 impl should run it
with a generous timeout and always pass `--usage-file`.

**Multi-profile:** `-p <profile>` flag (verified: the `~/.local/bin/sarah`
wrapper is literally `exec hermes -p sarah "$@"`); equivalently
`HERMES_HOME=<profileHome> hermes -z …`.

---

## validateConfig

**CLI (both human-text, no JSON):**
- `hermes doctor` — full diagnostic: security advisories, MCP audit, Python/
  SQLite versions, package presence, config file existence + version, deprecated
  keys, auth provider login state, directory structure, session count.
  `--fix` exists (never run it from the dashboard). Exit-code + section parse.
- `hermes config check` — narrower: config `_config_version` vs current (33) and
  required/optional env keys (`✓`/`○` per key).
- `hermes status [--all --deep]` — component status, "redacted for sharing".

**Adapter recommendation:** `validateConfig` = run `hermes -p <profile> doctor
< /dev/null`, capture exit code + text, and grep the `✓/⚠/✗` markers into a
structured `{ok, warnings[], errors[]}`. It is slower than OpenClaw's
`config validate` (~seconds) — cache the result.

**Gap:** no machine-readable output. Text-marker parsing is version-fragile;
pin on the glyphs (`✓`, `⚠`, `✗`) and section headers (`◆ …`), and degrade to
"exit code only" if parsing fails.

---

## readHealthReport(kind)

**OpenClaw's memory-health/drift/alert cluster has NO Hermes equivalent → stub**
(return 404/empty; the plan already says the UI tolerates this). Hermes memory
is a different system (`memories/` + hindsight provider) with no health JSON.

**What Hermes DOES have (new gauges the dashboard can surface):**
- `<HOME>/state/gateway.heartbeat` — real content:
  `{"pid": <n>, "updated_at": "2026-08-02T00:03:22.317866+00:00",
    "monotonic": 86194.865, "start_time": 1785626313.736}` (staleness check).
- `<HOME>/state/gateway.lifecycle.json` — `{"phase": "running", "pid": <n>, ...}`.
- `<HOME>/gateway_state.json` — per-platform connectivity:
  `{"gateway_state":"running","active_agents":0,"platforms":{"telegram":
  {"state":"connected","error_code":null,"error_message":null,"updated_at":…},
  "discord":{…}},…}`.
- `<HOME>/cron/ticker_heartbeat` — cron scheduler liveness.
- `hermes gateway status`, `hermes monitoring status` (OTLP metrics config,
  content-free by construction), `hermes insights --days N` (usage analytics).

**Recommendation:** implement `readHealthReport('gateway')` from those three
JSON files (they are trivially parseable) and stub the memory-* kinds.

---

## listWorkspaceRoots

**File:** `<HOME>/projects.db` (SQLite). Schema verified:

```sql
projects(id, slug, name, description, icon, color, board_slug,
         primary_path, created_at, archived)
project_folders(project_id, path, label, is_primary, added_at)
discovered_repos(root, label, last_seen)
```

**CLI:** `hermes project list` (per-profile state, per its own help text).

**Adapter:** union of `project_folders.path` + `discovered_repos.root`, plus
distinct `sessions.cwd` / `sessions.git_repo_root` from `state.db` for roots the
agent actually worked in. **`projects.db` is created lazily** — sarah's profile
home has none yet; missing file must mean "empty", not an error (general rule
for every store in this doc).

---

## Hermes capabilities OpenClaw never had (future dashboard leverage)

1. **Real cost/token accounting** — per session, per model, per task
   (`session_model_usage`), plus `hermes insights`. A spend panel is nearly free.
2. **Full-text search over all transcripts** (`messages_fts` + trigram FTS5) —
   dashboard search without building an index.
3. **`hermes serve`** — a JSON-RPC/WebSocket backend (default 127.0.0.1:9119; the
   desktop app's API) and `hermes dashboard` web UI with basic-auth. A future
   adapter could go RPC-first instead of file-first (not for 2.1; undocumented
   surface).
4. **Durable cron executions** with pid/claim state — crash-visible runs, not
   just "last_status".
5. **`hermes send --json`** — clean programmatic outbound notifications to
   Telegram/Discord/Slack/Signal with target discovery (`--list`).
6. **Session export formats** (jsonl/md/qmd/html/Claude-trace) and kanban/project
   primitives (`kanban.db`, `projects.db`) for later roadmap features.

---

## Risks & decisions for phase 2.1

1. **File-first vs CLI-first split (decide now):** reads = files/SQLite
   (jobs.json, executions.db, state.db, heartbeat JSONs — fast, JSON-less CLIs
   force this anyway); mutations = CLI (`cron create/edit/…`, `-z`) so locking,
   validation, and scheduler pickup stay Hermes's problem. Never write
   `jobs.json` without the `.jobs.lock` flock.
2. **SQLite access mode:** `state.db` is WAL and hot. Open `mode=ro`; do NOT use
   `immutable=1` (stale/corrupt reads on WAL). `hermes doctor` flags the host
   SQLite 3.50.4 WAL-reset bug — the dashboard's own SQLite driver (better-sqlite3)
   bundles its own libsqlite; verify its version ≥ fixed (3.51.3+/3.50.7) in the
   2.1 acceptance checks.
3. **`-z` latency + spend:** `sendAgentMessage` is a full agent loop (tools,
   memory, MoA fan-out is ENABLED on this machine — one message can hit three
   providers). Decide: synchronous with a 5–10 min timeout, always
   `--usage-file`, surface `api_calls`/tokens in the UI; and consider
   `-t`/`--toolsets` restriction for dashboard-originated messages.
4. **Timestamp zoo:** jobs.json + executions.db = ISO strings with local offset;
   state.db = REAL epoch seconds; heartbeats = UTC ISO. Normalize to epoch-ms at
   the adapter boundary; golden-file tests must normalize tz (the Mini is
   America/Chicago).
5. **No stable machine schema:** jobs.json fields and state.db columns have
   grown fast (config v33, schema migrations in-tree). Adapter must
   tolerate-and-preserve unknown fields, key caches on `jobs.json.updated_at`
   and `state.db schema_version`, and fail loud (not silently empty) on a
   `schema_version` it hasn't seen.
6. **Secrets adjacency:** `config.yaml` sits next to `.env`/`auth.json` and
   itself contains a dashboard `basic_auth.password_hash` and channel prompt
   text. The adapter must whitelist-extract fields (model, agent, gateway
   booleans) — never return raw config to the UI. Same for `sessions` rows:
   `system_prompt`, `origin_json`, and message `content` are tenant-private;
   the multi-tenant API must scope by instance and strip system prompts.
7. **Memory-health stub confirmed:** no Hermes equivalent; return empty/404 for
   all memory-* kinds (UI tolerates). Replace later with the gateway-health
   report (files above) as a new `kind: 'gateway'`.
8. **Lazy files everywhere:** `projects.db`, `cron/output/<id>/`, even
   `executions.db` may not exist in a fresh profile. Contract: missing file ⇒
   empty result. Add a fixture profile with NO optional files to the golden
   tests.
9. **Cron run ↔ session join is heuristic:** `cron_<jobid>_<ts>` session-id
   prefix is observed, not documented. Guard it with a fixture test so a rename
   in a future Hermes release breaks CI, not prod.
10. **Naming collision (from the plan):** the app's own `HERMES_*` env prefix vs
    the platform. 2.1 code must use `hermesAgent`/`HermesAgentBackend` names and
    never read the app's `HERMES_*` env vars inside the adapter.
11. **`hermes send` delivery targets can silently rot** (live example:
    `last_delivery_error: "no delivery target resolved for deliver=telegram"`
    on a green job). Surface `last_delivery_error` as a distinct warning state
    in the cron UI — job "ok" + delivery "failed" is a real, observed condition.
