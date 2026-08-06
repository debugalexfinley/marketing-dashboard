# Spec: Phase 5a — per-tenant instance binding (cross-tenant isolation)

## Goal
A tenant session can read exactly one Hermes profile — its own — and there is no
request-controlled way to reach another. Internal roles (admin/editor/viewer/
operator) keep today's behavior unchanged. This is the security foundation the
100-realtor deployment stands on: one dashboard process serving many tenants,
where each tenant's data boundary is enforced server-side from identity, never
from a parameter.

Branch `hermes-port-phase5a` off `hermes-port-phase4a` (1c11de7).

## Threat model (what must be impossible)
Today every route resolves its backend from `?instance=` / `?namespace=` (see
`resolveBackend` and the route handlers). With tenants that becomes a direct
IDOR: tenant A appends `?instance=<tenant-B>` and reads B's agent sessions,
transcripts, and cron jobs. **The binding must come from the session, and a
tenant-supplied instance parameter must never widen access — only be ignored or
rejected.**

## Files touched
- src/lib/instances.ts            (binding lookup + tenant-safe resolution)
- src/lib/backend/index.ts        (resolveBackend honors the binding)
- src/lib/auth.ts                 (persist the binding at SSO upsert)
- src/lib/api-auth.ts             (requireApiTenant returns the bound instance)
- src/app/api/tenant/agent/route.ts        (new)
- src/app/api/tenant/cron/route.ts         (new)
- src/app/api/tenant/sessions/route.ts     (new)
- src/lib/tenantBinding.test.ts   (new)
- .env.example
HARD BOUNDARY: no changes to the 59 existing internal routes. If one must
change, STOP and report — internal behavior is meant to be untouched.

## T1 — The binding
- Add `tenant_instance_id TEXT NULL` to the users table (migration in the same
  style the repo already uses — find it; do not invent a new migration system).
- `upsertStagesnapUser(sub)` sets it deterministically: `stagesnap:<sub>`.
- **Fail closed**: if no instance with that id is configured, or its `homeDir`
  does not exist on disk, tenant requests get 403 `{error:"tenant_not_provisioned"}`.
  Never fall back to a default instance — that is how a tenant would land in
  someone else's data (or the operator's).
- Internal users keep `tenant_instance_id` NULL and are unaffected.

## T2 — Resolution rule (the load-bearing change)
Introduce ONE function that every tenant-facing path must use:
`resolveTenantBackend(request)` → `{ backend, instanceId }` or throws a typed
`TenantAccessError`. It:
1. requires a tenant session (reuse `requireApiTenant`),
2. reads `tenant_instance_id` from the SESSION's user row — never from the
   request,
3. **ignores `?instance=` and `?namespace=` entirely**; if either is present AND
   differs from the bound id, reject with 403 rather than silently ignoring
   (loud beats quiet for an access-control probe, and it makes the test crisp),
4. resolves the backend for that id only.

Internal (non-tenant) callers continue to use the existing `resolveBackend`
path with its `?instance=` support, unchanged.

## T3 — Three tenant-readable routes (proof the binding works end to end)
New, all gated by `resolveTenantBackend`, all READ-ONLY (no writes this phase):
- `GET /api/tenant/agent` → the tenant's profile summary (name, model,
  gatewayRunning) via `listAgents()`.
- `GET /api/tenant/cron` → the tenant's cron jobs incl. `deliveryError`.
- `GET /api/tenant/sessions` → the tenant's recent sessions with token totals.
Response shaping must strip anything tenant-private-but-not-theirs and anything
operator-only: no `system_prompt`, no `origin_json`, no absolute filesystem
paths, no config values. Include a helper `sanitizeForTenant()` and use it in
all three.

## Tests (`tenantBinding.test.ts`) — adversarial, against real handlers
Set up TWO fixture Hermes homes (reuse `gen-hermes-home.mjs`) as instances
`stagesnap:aaa` and `stagesnap:bbb`, and two tenant sessions bound to each.
1. Tenant A `GET /api/tenant/agent` returns A's profile; asserted by a value
   unique to A's fixture.
2. Tenant A with `?instance=stagesnap:bbb` → **403**, and the response body
   contains no data from B (assert B's unique fixture value is absent).
3. Same for `?namespace=` and for a URL-encoded / mixed-case variant.
4. Tenant A whose bound instance is not configured → 403
   `tenant_not_provisioned`; assert it does NOT fall back to any other instance.
5. Tenant A whose bound homeDir path does not exist → same 403.
6. A tenant session on the three new routes never returns `system_prompt`,
   `origin_json`, or a string containing the fixture's absolute home path
   (JSON.stringify-scan the whole response).
7. An INTERNAL viewer session still reaches the existing internal routes with
   `?instance=` working exactly as before (regression proof).
8. A tenant session is still 403 on the internal routes (phase-4a property must
   survive this refactor) — reuse the real-route table from
   `tenantAccess.test.ts`.
9. Path traversal in the bound id (`stagesnap:../../etc`) never escapes the
   configured instance set — resolution is by exact id match against config,
   not by path concatenation. Assert with such a `sub`.

## Acceptance checks
1. `pnpm typecheck` clean; `pnpm test` all pass (existing 108 + new).
2. Anti-vacuity, shown failing-then-passing with pasted output:
   (a) make `resolveTenantBackend` honor `?instance=` → test 2 fails;
   (b) add a default-instance fallback when the binding is missing → test 4
   fails.
3. `git diff hermes-port-phase4a --stat` shows only the files listed above.
4. Existing golden checks still pass (both OpenClaw and Hermes baselines) —
   internal behavior unchanged.
5. Live smoke against the phase-3 deployment on `http://100.101.23.37:3003`:
   the three new tenant routes return 401/403 to an unauthenticated caller
   (they must not be open), and the existing dashboard still works.

## Constraints
- Read-only toward any Hermes home; no CLI mutations in this phase.
- No pushes. Checkpoint commit on green. No new dependencies.
- Do not weaken anything from phase 4a; its tests must still pass verbatim.

## Output contract
`feature-research/hermes-port/audit-phase5a.md`: the migration approach used,
the resolution rule's exact behavior for each input combination (a small truth
table), all acceptance outputs, both anti-vacuity demos, and what phase 5b
(provisioning scripts) must do to create a tenant that this binding will accept.
