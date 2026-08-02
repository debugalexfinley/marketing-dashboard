# Spec: Phase 1 — Extract AgentBackend interface (no behavior change)

## Goal
After this change, no API route reads OpenClaw's filesystem or spawns its CLI
directly: all agent-platform access flows through one `AgentBackend` interface
with a single OpenClaw implementation. Every `/api/*` response is byte-identical
to before (proven by a golden-file harness). This is pure refactoring that makes
a Hermes backend implementable in Phase 2 without touching routes or UI.

Repo: `/Users/alexfinley/Documents/GitHub/marketing-dashboard` (work on a new
branch `hermes-port-phase1` off main). Package manager: pnpm 10 via corepack
(`corepack enable && corepack prepare pnpm@10.28.0 --activate` — pnpm 11 breaks
the lockfile). Node ≥22 available via nvm.

## Files touched
New:
- src/lib/backend/types.ts
- src/lib/backend/index.ts
- src/lib/backend/openclaw.ts
- src/lib/backend/openclaw.test.ts
- feature-research/hermes-port/fixtures/openclaw-home/** (fixture tree, see below)
- feature-research/hermes-port/golden/capture.mjs
- feature-research/hermes-port/golden/baseline/*.json (generated pre-refactor)
Modified:
- src/lib/instances.ts
- src/lib/agent-config.ts
- src/lib/cron-jobs.ts
- src/lib/command.ts
- src/app/api/agents/route.ts
- src/app/api/cron/route.ts
- src/app/api/cron/jobs/route.ts
- src/app/api/cron/runs/route.ts
- src/app/api/automations/route.ts
- src/app/api/hud/route.ts
- src/app/api/chat/sync-sessions/route.ts
- src/app/api/memory-health/route.ts
- src/app/api/memory-drift/route.ts
- src/app/api/memory-alerts/route.ts
- src/app/api/memory-policy/route.ts
- src/app/api/memory-alert-policy/route.ts
- src/app/api/memory-effect/route.ts
- src/app/api/deploy-status/route.ts
- src/app/api/agents/workspace-roots/route.ts
- src/app/api/agents/workspace/route.ts
- src/app/api/instances/route.ts
- src/app/api/mission-control/chat/route.ts
- src/app/api/chat/messages/route.ts
- src/lib/cron-jobs.test.ts (only if imports move; assertions unchanged)

HARD BOUNDARY: no other files. No UI/component/store changes. If a route not
listed here turns out to import OpenClaw helpers, STOP and report.

## Changes per file

### src/lib/backend/types.ts (new)
Define and export:
```ts
export type BackendKind = 'openclaw' | 'hermes';
export interface AgentBackend {
  kind: BackendKind;
  listAgents(): Promise<AgentDefinition[]>;            // from agent-config.ts:6-34 shapes
  readModelRouting(): Promise<ModelRouting>;           // shape currently built in api/agents/route.ts:34-67
  listCronJobs(): Promise<CronJobsFile>;               // cron-jobs.ts:5-36 types move here
  writeCronJobs(file: CronJobsFile): Promise<void>;    // preserves atomic write + .bak behavior
  upsertCronJob(job: CronJobConfig): Promise<void>;
  toggleCronJob(id: string, enabled: boolean): Promise<void>;
  readCronRuns(jobId: string, limit: number): Promise<CronRun[]>;
  tailCronLog(jobId: string, bytes: number): Promise<string>;
  readSessions(agentId: string): Promise<SessionFileRef[]>;      // path + mtime list
  readSessionEntries(ref: SessionFileRef, fromOffset: number): Promise<{entries: SessionEntry[]; nextOffset: number}>;
  readSessionUsage(agentId: string): Promise<AgentUsageTotals>;  // token/cost summing from api/agents/route.ts:69-134
  sendAgentMessage(agentId: string, message: string, sessionId?: string): Promise<CommandResult>;
  sendOrchestratorMessage(message: string): Promise<CommandResult>;
  validateConfig(): Promise<CommandResult>;
  readHealthReport(kind: HealthReportKind): Promise<unknown | null>;   // 'memory-health'|'memory-drift-weekly'|'memory-alerts'|'memory-policy'|'memory-alert-policy'
  writeHealthPolicy(kind: 'memory-policy'|'memory-alert-policy', body: unknown, auditEntry: unknown): Promise<void>;
  readAuditLog(name: string, limit: number): Promise<unknown[]>;       // memory-effect route needs drift-history + policy audits
  readDeployLogs(): Promise<string[]>;
  listWorkspaceRoots(): Promise<Root[]>;               // shape from api/agents/workspace-roots/route.ts:11-19
  resolveWorkspacePath(rootId: string, relPath: string): Promise<string>; // keeps existing traversal guards
}
```
Move the canonical copies of `AgentDefinition`, `AgentSkill`, `CronJob*`,
`CronRun`, `SessionEntry`, `Root`, etc. here; other modules re-export from here.
Exact method signatures may be adjusted ±1 param where the call sites demand it —
but every route must end up calling the interface, not fs/child_process.

### src/lib/backend/openclaw.ts (new)
`class OpenClawBackend implements AgentBackend` — absorbs, without behavior
change: `resolveOpenClawPaths()` from instances.ts:116-133; write-permission
flags instances.ts:135-157 (throw on write methods when the flag is off, same
error messages routes currently produce); openclaw.json parsing from
agent-config.ts (keep BOTH schema readings exactly as today: the `a.id` reading
for listAgents and the `a.name` reading currently in workspace-roots — expose
them as listAgents() vs listWorkspaceRoots() respectively; do NOT "fix" the
divergence); cron file handling from cron-jobs.ts including `.bak` rotation;
subprocess spawning from command.ts (same binary resolution env chain
HERMES_ADMIN_CLI → OPENCLAW_BIN → 'openclaw', shell:false, 120s timeout);
session JSONL walking/offset logic currently inlined in sync-sessions and
api/agents routes; health/audit/deploy-log reads from their routes.

### src/lib/backend/index.ts (new)
`resolveBackend(instanceId?: string): AgentBackend` — looks up the
`HermesInstance` (instances.ts), switches on new `kind` field (default
'openclaw'), caches per instance. `'hermes'` kind throws
`new Error('hermes backend: phase 2')` for now.

### src/lib/instances.ts
Add `kind?: BackendKind` to `HermesInstance` (default 'openclaw' in parsing).
`resolveOpenClawPaths` moves to openclaw.ts; leave a deprecated re-export so
nothing external breaks, but no route may import it (enforced by acceptance
grep).

### src/lib/{agent-config,cron-jobs,command}.ts
Become thin re-export shims over backend/types + backend/openclaw (keep public
symbols so cron-jobs.test.ts and any client imports still resolve), or fold
fully if nothing else imports them — implementer's choice, stated in audit.

### All listed route files
Mechanical: replace inline `fs.*`/`path.join(...Dir)`/`spawn` logic with
`const backend = resolveBackend(instanceParam)` + interface calls. Response
shaping/status codes/error strings stay in routes and UNCHANGED. Routes keep
accepting `?instance=` and legacy `?namespace=`.

### Golden-file harness (new, and the core safety net)
- `fixtures/openclaw-home/`: hand-built fixture with 2 agents (one from
  openclaw.json list, one filesystem-discovered), sessions jsonl with usage
  lines, cron jobs.json (all three schedule kinds: cron/every/at) + runs jsonl
  + logs, all five health JSONs, one workspace-* dir, deploy log. Realistic
  but synthetic content.
- `golden/capture.mjs`: boots the app (`pnpm build && pnpm start` or dev server)
  with `HERMES_OPENCLAW_HOME=<fixture>` and auth bypassed via seeded
  AUTH_USER/AUTH_PASS login, GETs every refactored read route (list them
  explicitly in the script), normalizes volatile fields (timestamps, absolute
  path prefixes), writes one JSON per route into an output dir.
- Workflow: run capture on UNMODIFIED main → commit `golden/baseline/`. After
  refactor, run capture again → diff against baseline → must be identical.

## Acceptance checks
1. `pnpm typecheck` (or `pnpm tsc --noEmit` per repo scripts) — clean.
2. `pnpm test` — all pass including existing cron-jobs.test.ts and new
   openclaw.test.ts (unit-test OpenClawBackend against the fixture: listAgents
   finds both agents; readCronRuns parses all schedule kinds; write methods
   throw when flags off).
3. Golden diff: `node feature-research/hermes-port/golden/capture.mjs --out
   /tmp/after && diff -r feature-research/hermes-port/golden/baseline /tmp/after`
   → empty. (This check MUST fail if run mid-refactor — it's the
   fail-before/pass-after proof.)
4. `grep -rEn "readFileSync|writeFileSync|child_process|spawn\(" src/app/api`
   → zero matches.
5. `grep -rn "resolveOpenClawPaths" src/app/api` → zero matches.

## Constraints
- Branch `hermes-port-phase1`; commit locally (wip: prefixes fine) — REQUIRED
  checkpoint commit immediately after baseline capture and immediately after
  acceptance goes green. NO pushes, no remote changes.
- No repo-wide formatters; match existing style (the repo has its own lint
  config — run targeted lint only on touched files if a script exists).
- Do not alter any JSON response shape, status code, or error string.
- Do not fix pre-existing bugs/divergences (the two openclaw.json schema
  readings stay divergent).
- No new dependencies.

## Output contract
Audit at `feature-research/hermes-port/audit-phase1.md`, beginning with the
complete "Files changed" list, then per-file summary, interface deltas vs this
spec (with reason), test/golden results (paste the actual command outputs),
deviations, open risks for phase 2.
