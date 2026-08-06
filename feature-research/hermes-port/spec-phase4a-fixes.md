# Spec: Phase 4a fixes — SSO authorization + transport hardening

Blocking findings from the blind security review of `4ee0c5d..5815893`.
Branch `hermes-port-phase4a`. The crypto/verification half held up (RS256 pin,
issuer-allowlist-before-JWKS so no attacker-controlled fetch, exp/nbf, dev-token
rejection, fail-closed on empty allowlist, feature-flag-off) — **do not touch
that logic except where explicitly listed.** What failed is everything after
verification.

Root cause of F1 (documented so it isn't repeated): the original spec demanded a
privilege test against `requireApiCapability`, which **zero** production routes
use, while 59 route files gate on `requireApiUser` — "any authenticated user."
The test proved an unused gate. Authorization must be verified against the guard
the app actually uses.

## Files touched
- src/lib/api-auth.ts
- src/lib/auth.ts
- src/proxy.ts
- src/app/api/auth/sso/route.ts
- src/lib/auth/stagesnapSso.ts
- src/lib/auth/stagesnapSso.test.ts
- src/lib/auth/tenantAccess.test.ts (new)
- .env.example
HARD BOUNDARY: no other route files. If a route must change to keep working for
existing roles, STOP and report.

## F1 — BLOCKER: tenant must be deny-by-default against the REAL guards
A `tenant` session currently passes `src/proxy.ts` middleware (session-cookie
presence only) and `requireApiUser` (`src/lib/api-auth.ts:5-11`), which together
gate 59 API routes and all pages.

Fix:
1. `requireUser`/`requireApiUser` treat `tenant` as NOT an internal user:
   `requireApiUser` returns 403 `{error:"forbidden"}` for a tenant session.
   Every existing internal role (admin/editor/viewer/operator) behaves exactly
   as before — no regression.
2. Add `requireApiTenant(request)` for future tenant-facing routes (returns the
   tenant user or 403 for non-tenant). Nothing uses it yet; that is correct —
   the tenant UI is a later phase.
3. `src/proxy.ts`: a tenant session may reach only an explicit allowlist of
   path prefixes, from a single exported constant `TENANT_ALLOWED_PREFIXES`
   (initially `['/api/auth/', '/tenant/']`). Everything else → redirect to a
   `/tenant` placeholder (pages) or 403 (API). Middleware must read the role
   from the session, so if that requires a session lookup in middleware and the
   runtime forbids it, implement the check in `requireApiUser` + a server-side
   layout guard instead and SAY SO in the audit — do not silently skip it.

**Test file `tenantAccess.test.ts` must assert against the guards routes really
use**: a tenant session gets 403 from `requireApiUser`; an admin/editor/viewer
session still gets through; and a table-driven test picks at least 5 REAL route
modules that import `requireApiUser` (e.g. sync, leads, cron, analytics,
settings) and asserts each rejects a tenant session. Also assert
`TENANT_ALLOWED_PREFIXES` does not contain `/api/` alone or `/`.

## F2 — BLOCKER: stop carrying the JWT in a query string
`GET /api/auth/sso?token=<jwt>` puts a 7-day-session-minting bearer token into
proxy logs, browser history, and possibly `Referer`.

Fix: **drop query-token support entirely.** The supported transport becomes
`POST /api/auth/sso` with the token in the request body (`application/json` or
form-encoded), which StageSnap performs as an auto-submitting form POST — the
same `response_mode=form_post` pattern OIDC uses for exactly this reason.
- Remove the `token` query-param read and the GET handler's token path. GET may
  remain only to return 404/405 consistently.
- Keep the `Authorization: Bearer` header path (server-to-server callers).
- Add `Cache-Control: no-store` and `Referrer-Policy: no-referrer` to every SSO
  response, matching the password-login route.
- Do this NOW, before the StageSnap side is built against the old shape.

## F3 — MAJOR: rate limiting must not trust attacker-controlled headers
`x-forwarded-for` is used as the bucket key, so rotating the header defeats it.
Fix: only trust `x-forwarded-for`/`x-real-ip` when `TRUSTED_PROXY=true` is set
(document that it means a proxy that OVERWRITES the header); otherwise key on
the platform-provided connection IP. Independently, add a **global** bucket
(e.g. 120 attempts/min across all keys) so header rotation cannot amplify JWKS
fetches. Test: 20 requests with 20 distinct spoofed XFF values must still trip
the global limit.

## F4 — MAJOR: audience must fail closed when SSO is enabled
`audience: audience || undefined` silently disables the `aud` check when the env
var is unset. Fix: when `STAGESNAP_SSO_ENABLED=true` and
`STAGESNAP_SSO_AUDIENCE` is empty, the module refuses to start/verify (throw at
config load, or reject every token with the generic 401 and log ONE startup
warning without secrets). Test both: configured aud enforced; missing aud while
enabled → all tokens rejected.

## F5 — MINOR: validate `sub` before using it as an identity key
`stagesnap:${sub}` with no charset/length validation. Fix: require `sub` to
match `^[A-Za-z0-9_:.-]{1,128}$`, reject otherwise (generic 401). Test a `sub`
containing `/`, whitespace, and a 500-char value.

## F6 — MINOR: cookie/response parity with the login route
Align `Cache-Control: no-store`. Keep `sameSite: 'lax'` (required: the flow is a
cross-site top-level POST→redirect; `strict` would drop the cookie) but state
that reason in a code comment and the audit, so it reads as a decision rather
than an oversight.

## Acceptance checks
1. `pnpm typecheck` clean; `pnpm test` all pass (existing 94 + new).
2. Anti-vacuity, all three shown failing-then-passing with pasted output:
   (a) make `requireApiUser` accept tenant → the real-route tenant test fails;
   (b) re-add query-token support → an F2 test asserting query tokens are
   ignored fails; (c) restore `audience || undefined` → the F4 test fails.
3. Regression proof: a viewer-role session still passes `requireApiUser` on the
   same 5 real routes used in the tenant test.
4. Feature still inert by default: `curl http://100.101.23.37:3003/api/auth/sso`
   → 404 (run against the live phase-3 deployment).
5. `git diff hermes-port-phase2 --stat` shows only the phase-4a files plus the
   ones listed above.

## Output contract
Append "Security fix pass" to audit-phase4a.md: finding→fix mapping, the
middleware-vs-guard decision made for F1, the new SSO transport contract (for
the StageSnap-side spec), all acceptance outputs, and anything deferred.
