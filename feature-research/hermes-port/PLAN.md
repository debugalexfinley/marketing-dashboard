# Plan: Marketing Dashboard — OpenClaw→Hermes port + StageSnap integration

Owner: Alex. Orchestrated per the phase loop; each phase hands off as a codex-spec.
Working repo: `~/Documents/GitHub/marketing-dashboard` (clone of builderz-labs/marketing-dashboard).
**Before phase 1 ships: fork to Alex's GitHub and repoint `origin` — we will diverge permanently.**

## End state (why)

Realtors log into StageSnap, see an "AI Dashboard" tab beside the social calendar.
Upgraded tenants get: a Hermes agent (profile in the multiplexed tenant container on
coolify-vps) + this dashboard showing that agent's activity, leads, sequences, and
approvals — with StageSnap SSO, StageSnap look, and the agent drafting posts INTO
Postiz (single calendar; the dashboard's own tenant-facing calendar UI is retired).
Alex runs a personal instance on the Mac Mini against `~/.hermes`.
`dashboard.mydreamtc.com` remains the internal/master instance.

## Naming decision — DECIDED (Alex, 2026-08-01)

Keep `HERMES_*` env vars as-is; RENAME the marketing persona (working name
"Maven" — `src/lib/agent-config.ts:82-120` metadata + `ACTION_TO_AGENT`
322-330 + any UI strings); in code the platform is always `hermesAgent` /
`HermesAgentBackend`, never bare "hermes". Persona rename executes as a small
follow-up task AFTER phase 1 merges (agent-config.ts is under refactor right
now — do not touch it in parallel).

Fork: DONE — origin = github.com/debugalexfinley/marketing-dashboard,
upstream = builderz-labs. Push branches to origin only.

---

## Phase 1 — Extract the backend interface (no behavior change)

The port's foundation. Today ~20 API routes each do inline `readFileSync` +
`JSON.parse` of OpenClaw files; `openclaw.json` is parsed 3 ways, `cron/jobs.json`
in 4 places. Extract one interface, refactor every caller onto it, implement it
once for OpenClaw. Zero UI changes.

**Interface (new `src/lib/backend/types.ts`):**
`AgentBackend { listAgents; readModelRouting; listCronJobs; writeCronJobs;
readCronRuns(jobId); tailCronLog(jobId); readSessions(agentId); sendAgentMessage;
validateConfig; readHealthReport(kind); writePolicy(kind); listWorkspaceRoots }`
plus `resolveBackend(instance): AgentBackend` keyed by a new
`HermesInstance.kind: 'openclaw' | 'hermes'` discriminator (default `'openclaw'`).

**Files touched (route refactors + consolidation):**
- `src/lib/backend/{types.ts,index.ts,openclaw.ts}` (new — OpenClaw impl absorbs
  logic from `instances.ts`, `agent-config.ts`, `cron-jobs.ts`, `command.ts`)
- `src/lib/instances.ts` (add `kind`; `resolveOpenClawPaths` moves into openclaw.ts)
- `src/lib/{agent-config.ts,cron-jobs.ts,command.ts}` (become thin re-exports or fold in)
- Routes: `src/app/api/{agents,cron,cron/jobs,cron/runs,automations,hud,
  chat/sync-sessions,memory-health,memory-drift,memory-alerts,memory-policy,
  memory-alert-policy,memory-effect,deploy-status,agents/workspace-roots,
  agents/workspace,instances,mission-control/chat,chat/messages}/route.ts`
- `src/lib/cron-jobs.test.ts` (keep passing; add backend-level tests)

**Acceptance checks (must fail before / pass after):**
- `pnpm typecheck` clean; `pnpm test` all pass.
- New golden-file test: run app against a fixture `$OPENCLAW_HOME` (checked into
  `feature-research/hermes-port/fixtures/openclaw-home/`), capture JSON of every
  refactored `/api/*` route BEFORE the refactor, assert byte-identical AFTER
  (timestamps normalized). This is the no-behavior-change proof.
- `grep -rn "resolveOpenClawPaths\|readFileSync" src/app/api | wc -l` → 0
  (no route touches the filesystem directly anymore).

## Phase 2 — Hermes adapter (same-host files + `hermes` CLI)

**Task 2.0 (investigation, gates the rest):** map Hermes Agent's on-disk state
layout against the interface — sessions/transcripts location + JSONL shape, cron
(`hermes cron` store), config/profiles (`~/.hermes/config.yaml`, per-profile
dirs), token/cost accounting availability, and which CLI commands replace
`openclaw agent --message` (likely `hermes send`/`hermes chat`) and
`openclaw config validate` (`hermes doctor`?). Output: a contract-mapping doc in
`feature-research/hermes-port/hermes-mapping.md`. **Rule: verified against the
live install at `~/.hermes` on the Mini, not from memory.**

**Then:** `src/lib/backend/hermes.ts` implementing the interface; per-profile
pathing (a `HermesInstance` maps to one profile — this is what makes tenant
slicing work later); memory-health cluster returns 404/empty (UI already
tolerates); `EXPERIMENT_CONTRACT:` text convention preserved in cron payloads.

**Acceptance:** same golden-file harness with a fixture `~/.hermes`; plus live
smoke on the Mini: agents page lists real profiles, sessions sync into SQLite,
sending a message round-trips through the real `hermes` CLI.

## Phase 3 — Alex's instance on the Mac Mini

Container or node process on the Mini, tailnet-only (`100.101.23.37:3003`),
LaunchAgent (same pattern as t3/hermes-dashboard), `kind: 'hermes'` instance
pointed at `~/.hermes`, Mission Control + Kuma entries.
**Acceptance:** reachable at :3003 from phone/MacBook with Tailscale; shows real
agent activity from Alex's Hermes; survives reboot; closed publicly.

## Phase 4 — StageSnap integration

- **SSO (design updated after scout, 2026-08-01):** StageSnap = Next.js 16 web
  + Convex backend with @convex-dev/auth — sessions are Convex-issued JWTs in
  the `__Host-__convexAuthJWT` cookie (issuer = CONVEX_SITE_URL, see
  stagesnap.ai/convex/auth.config.ts). The dashboard's `/api/auth/sso`
  VERIFIES the Convex JWT (issuer JWKS) instead of a custom minted token —
  no new token infrastructure on the StageSnap side. Tenant identity =
  Convex `userId` (optional `teamId` for team plans). Seed-password auth
  stays for internal instances.
- **Theming:** StageSnap nav/colors on the dashboard shell.
- **Calendar cut:** tenant role hides the dashboard's content-calendar UI.
- **Marketing recipe catalog (CORRECTED 2026-08-01 — not an import):** the
  Automations view ships a curated library of POTENTIAL marketing recipes the
  tenant can activate — playbooks built on StageSnap capabilities (e.g. "new
  listing blast: stage photos → post series across channels", "just-sold
  story", "weekly market update", "open-house countdown", "just-listed
  postcards" via `postcardCampaigns`). Implementation chassis: the dashboard's
  existing cron-template system (`src/lib/cron-templates.ts`, dashboard-owned
  SQLite — already portable). Activating a recipe = creating the Hermes cron
  job + skill invocation through the AgentBackend interface; the agent then
  drafts into StageSnap/Postiz per the flow above. Recipe definitions are
  content we author (with Alex) — a seed JSON in the repo, editable per tenant
  tier. The tenant's existing scheduled posts still show in the StageSnap
  calendar (source of truth) — the dashboard does not duplicate that view.
- **Agent→Postiz (design updated after scout):** per-user Postiz API keys are
  ENVELOPE-ENCRYPTED inside Convex (`postizAccounts` table, KEK in Convex env)
  — the agent must NOT hold raw Postiz keys. Instead: a new Convex HTTP
  action in the stagesnap.ai repo ("draft post for userId X", auth'd by a
  server-to-server secret) that decrypts and calls Postiz internally; the
  Hermes skill calls that action. Drafts land as `socialPosts` rows
  (status queued/scheduled) → visible in the existing StageSnap calendar.
  Postiz runs in `enterprise` mode (per-user Postiz orgs = real isolation).
**Acceptance:** clicking "AI Dashboard" in StageSnap lands authenticated with no
second login; a test agent draft appears in the Postiz calendar as
pending-approval; tenant role shows no calendar UI; direct unauthenticated hit
still bounces to login.

## Phase 5 — Tenant packaging (100-realtor shape)

Per-tenant provisioning script in `realtor-hermes-assistant-template`:
`provision-tenant.sh <slug>` = `docker exec hermes-tenants hermes profile install
<template-repo> --name <slug>` + dashboard container (tenant-sliced state volume,
`kind: 'hermes'` instance) + Traefik route + Kuma monitor + StageSnap SSO secret.
De-provision script = the reverse.
Provisioning also creates the tenant's INTEGRATION HEALTH monitors (design
decided 2026-08-01): per-tenant, per-integration Uptime Kuma push monitors —
each integration a tenant's agent depends on (Optimal Blue session for LOs,
MLS/listing APIs for realtors e.g. RealEstateAPI, Postiz connection, CRM)
runs a lightweight validity check on a schedule and heartbeats its push URL;
missed heartbeat = that tenant's integration is down → Discord #uptime-alerts
(instant + 8h resend). Checks must be cheap enough not to trip provider rate
limits/lockouts. LenderPricing/OB is the pilot implementation (scout in
progress); the realtor-template integrations adopt the same harness as they
come online. Document the multiplexed-gateway container
(`gateway.multiplex_profiles: true`, 2–4GB sizing, per-tenant bot tokens).
**Acceptance:** provisioning a fresh test tenant end-to-end (script → realtor
sees AI Dashboard in StageSnap) in under 10 minutes with zero manual container
steps; de-provision leaves no orphan containers/routes/volumes.

---

## Lane assignments & order

Phase 1: codex-implementer (mechanical, exhaustively specced) → codex-reviewer,
  with a SECOND blind review pass via `grok` CLI (Grok 4.5, SuperGrok sub —
  also free capacity); orchestrator reconciles both reviews.
Phase 2.0: scout/codex read-only investigation. 2.1: codex-implementer.
Phase 3: builder. Phase 4 SSO/Postiz: codex-implementer; theming: designer (taste).
Phase 5: codex-implementer, `grok` as overflow/fallback lane when Codex is
  rate-limited (same self-contained-spec discipline; note the lane switch in
  the audit).
Checkpoint-commit after every green acceptance run.
Phases 1→2→3 are strictly sequential; 4 and 5 can overlap after 2.
For the riskiest calls (SSO design, tenant slicing), run Codex + Grok blind in
parallel on the same question and synthesize.

## Open items

- Fork the repo (blocks any push).
- Naming decision above.
- StageSnap-side work (SSO mint, "AI Dashboard" tab, upsell gate) lives in the
  StageSnap repo — separate spec once its stack is scouted.
- Postiz API auth for the agent skill: reuse StageSnap's existing per-tenant
  Postiz wiring — find where StageSnap stores workspace/API-key mapping.
- OPEN-SOURCE GROWTH MODEL (Alex, 2026-08-01): the realtor marketing skill +
  recipe catalog ships as a public repo (installable Hermes skill bundle) whose
  DEFAULT backend is the public StageSnap API — usage consumes StageSnap
  credits, so the free skill is a paid-API acquisition funnel (open-source
  client, monetized engine). Implications for phase 4/5: the StageSnap Convex
  action grows into a small public API surface — per-user API keys for
  external (non-SSO) installs + credit metering on agent-driven calls
  (StageSnap already has a credits system in Convex; extend, don't rebuild).
  SSO secrets and tenant provisioning stay private. The private realtor
  template depends on the public skill package.
