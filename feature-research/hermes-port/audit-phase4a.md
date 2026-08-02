# Phase 4a StageSnap SSO audit

## Files changed

- Modified: `.env.example`
- Modified: `package.json`
- Modified: `pnpm-lock.yaml`
- Modified: `src/lib/auth.ts`
- Added: `src/app/api/auth/sso/route.ts`
- Added: `src/lib/auth/stagesnapSso.ts`
- Added: `src/lib/auth/stagesnapSso.test.ts`
- Added as the required handoff artifact: `feature-research/hermes-port/audit-phase4a.md` (kept outside the implementation commit/stat, matching the existing untracked Phase 3 audit pattern)

## Session-issuance path reused

The SSO route calls `createSession(user.id)` from `src/lib/auth.ts`, the dashboard's existing random-token, SQLite-backed, seven-day session issuance function. No parallel session or token mechanism was added.

`src/app/api/auth/sso/route.ts` replicates the cookie-setting pattern from `src/app/api/auth/google/callback/route.ts`: cookie name `hermes-session`, `httpOnly: true`, `secure: shouldUseSecureCookies(request)`, `sameSite: 'lax'`, `maxAge: 7 * 24 * 60 * 60`, and `path: '/'`. The secure-cookie helper uses the same `AUTH_COOKIE_SECURE`, `x-forwarded-proto`, request-URL, and production fallback precedence as the Google callback.

## Role/privilege changes

The exact role changes in `src/lib/auth.ts` are:

```diff
-export type UserRole = 'admin' | 'editor' | 'viewer';
+export type UserRole = 'admin' | 'editor' | 'viewer' | 'tenant';

 function normalizeRole(value: string): UserRole {
   if (value === 'operator') return 'editor';
+  if (value === 'tenant') return 'tenant';
   if (value === 'admin' || value === 'editor' || value === 'viewer') return value;
   return 'viewer';
 }
```

Verification of the six required privilege properties:

1. `UserRole` includes `tenant`, confirmed by `pnpm typecheck` and source inspection.
2. `normalizeRole` has a literal `tenant` branch before the permissive fallback. The test `tenant sessions remain tenant and have no admin, editor, or dashboard-read privileges` creates and validates a real session and asserts the role round-trips as `tenant`.
3. `src/lib/rbac.ts` was not edited and `tenant` was not added to `Role` or `ROLE_CAPABILITIES`. The same privilege test asserts `roleHasCapability('tenant' as never, 'read_dashboard') === false`; `git diff hermes-port-phase2 -- src/lib/rbac.ts` was empty.
4. The real tenant-session test asserts `requireAdmin` throws `forbidden`, and `requireApiAdmin`, `requireApiEditor`, and `requireApiCapability(..., 'read_dashboard')` each return HTTP 403.
5. The existing `createUser()` and `updateUserRole()` runtime allowlists remain exactly `['admin', 'editor', 'viewer', 'operator']`. The tenant privilege test passes literal `tenant` to both functions and asserts both throw `Invalid role`.
6. The requested real-session privilege test is named `tenant sessions remain tenant and have no admin, editor, or dashboard-read privileges`; it passed under `pnpm test`.

`upsertStagesnapUser(sub)` uses the exact username `stagesnap:${sub}`, an unusable random password hash, `auth_provider = 'stagesnap'`, and forcibly stores `role = 'tenant'` on both insert and username conflict. It never reads a role claim from the JWT.

## Config surface

- `STAGESNAP_SSO_ENABLED=false`: the feature is inert unless its exact value is `true`; otherwise the endpoint returns 404.
- `STAGESNAP_SSO_ISSUERS=https://http.stagesnap.ai`: comma-separated exact-match issuer allowlist. The verified issuer selects `/.well-known/jwks.json` on that issuer.
- `STAGESNAP_SSO_AUDIENCE=convex`: optional audience; when non-empty, `jose` enforces it.
- `STAGESNAP_SSO_JWKS_TTL_MS=600000`: remote JWKS cache lifetime in milliseconds; invalid/non-positive values fall back to 600000.

JWT verification uses `createRemoteJWKSet`, a zero unknown-key cooldown so `jose` performs one refresh retry, `jwtVerify` with `algorithms: ['RS256']`, required `iss`/`sub`/`exp`, and 60 seconds of clock tolerance. All verifier failures become the same generic error and neither verifier nor route logs tokens or claims.

The endpoint rate limiter is a per-process, in-memory token bucket fixed at 10 requests/minute/IP. Client identity uses the first `x-forwarded-for` value, then `x-real-ip`, then the shared key `unknown`.

## Per-check acceptance results

1. `pnpm typecheck`:

```text
> hermes-dashboard@0.2.0 typecheck
> tsc --noEmit
EXIT_CODE=0
```

2. `pnpm test`:

```text
✔ 1. valid token returns 200, sets a session cookie, and upserts a tenant user
✔ 5. alg:none and HS256 signed with the RSA modulus are rejected
✔ 7. unknown kid causes exactly one JWKS refetch and is then rejected
✔ 8. unset feature flag returns 404
✔ 9. rate limiter rejects the eleventh request from one forwarded IP
✔ 10. failures do not log the token or subject
✔ tenant sessions remain tenant and have no admin, editor, or dashboard-read privileges
ℹ tests 94
ℹ pass 94
ℹ fail 0
EXIT_CODE=0
```

3. Anti-vacuity mutation and restoration: the weakened run failed and the restored RS256-only run passed. Full focused outputs are in the next section.

4. Disabled behavior:

```text
✔ 8. unset feature flag returns 404
```

The live phase-3 endpoint was reachable after network escalation and remained inert:

```text
$ curl --max-time 10 -sS -o /dev/null -w '%{http_code}\n' http://100.101.23.37:3003/api/auth/sso
404
EXIT_CODE=0
```

5. `git diff hermes-port-phase2 --stat` after staging the implementation (the required audit is intentionally outside this implementation stat):

```text
 .env.example                      |   7 +
 package.json                      |   3 +-
 pnpm-lock.yaml                    |   8 +
 src/app/api/auth/sso/route.ts     | 116 ++++++++++++
 src/lib/auth.ts                   |  22 ++-
 src/lib/auth/stagesnapSso.test.ts | 384 ++++++++++++++++++++++++++++++++++++++
 src/lib/auth/stagesnapSso.ts      |  60 ++++++
 7 files changed, 598 insertions(+), 2 deletions(-)
```

The corresponding name-only output was exactly:

```text
.env.example
package.json
pnpm-lock.yaml
src/app/api/auth/sso/route.ts
src/lib/auth.ts
src/lib/auth/stagesnapSso.test.ts
src/lib/auth/stagesnapSso.ts
```

6. Live JWKS reachability succeeded after network escalation. Only the requested count was emitted:

```text
$ curl --max-time 10 -sS https://http.stagesnap.ai/.well-known/jwks.json | <RSA/RS256 key-count filter>
1
EXIT_CODE=0
```

## Anti-vacuity demo

Temporary weakening: an explicit `alg:none` acceptance bypass was inserted immediately before `jwtVerify`. This is necessary for the mutation because `jose`'s `jwtVerify` does not itself verify unsecured JWTs, even if an algorithm name is added to an option list. With the bypass present, the focused test produced:

```text
$ node --import tsx --test --test-concurrency=1 --test-name-pattern='5\. alg:none and HS256' src/lib/auth/stagesnapSso.test.ts
✖ 5. alg:none and HS256 signed with the RSA modulus are rejected (139.487167ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1

AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
200 !== 401
EXIT_CODE=1
```

The bypass was removed. The final code contains only `algorithms: ['RS256']`. The identical command then produced:

```text
$ node --import tsx --test --test-concurrency=1 --test-name-pattern='5\. alg:none and HS256' src/lib/auth/stagesnapSso.test.ts
✔ 5. alg:none and HS256 signed with the RSA modulus are rejected (82.653542ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
EXIT_CODE=0
```

## Deviations

- Approved deviation: `jose` 6.2.7 was added with `pnpm add jose`; `package.json` contains pnpm's generated `^6.2.7` range and the lockfile pins the resolved package.
- Approved deviation: the existing session/user module modified is `src/lib/auth.ts`, not a pre-existing `src/lib/auth/` directory.
- Test-fixture implementation: JWKS retrieval is mocked through `globalThis.fetch` rather than a local HTTP listener. The initial listener fixture failed with sandbox `listen EPERM`; the fetch mock keeps all tests fully offline and still exercises `createRemoteJWKSet`, its cache, and its unknown-`kid` refresh behavior.
- Required audit handling: this audit is written as an untracked handoff artifact so the requested implementation commit/stat contains exactly the seven authorized implementation files, consistent with the pre-existing untracked Phase 3 audit/spec artifacts.

## Open risks / follow-ups for the StageSnap-side spec

- The StageSnap “AI Dashboard” action should target the dashboard's public `/api/auth/sso` endpoint. For the current browser click-through contract, it must navigate to `GET /api/auth/sso?token=<encoded Convex JWT>`; successful verification immediately redirects to `/` and sets `hermes-session`.
- A StageSnap `__Host-__convexAuthJWT` is host-only by definition and will not be sent to a different dashboard origin. The localhost `__convexAuthJWT` is likewise scoped to its own host. A normal cross-origin link also cannot attach an `Authorization` header, so the StageSnap side must deliberately read/forward the JWT through the approved query hop or design a separate server-mediated handoff in a future spec.
- Query transport can expose a bearer token to browser history, infrastructure access logs, and upstream URL telemetry. The StageSnap-side spec should evaluate a short-lived one-time handoff code or same-site/server-mediated POST if that risk is unacceptable. This dashboard route never logs the token and redirects immediately, but it cannot control upstream proxy logging.
- The top-level GET redirect needs no CORS. A cross-origin JavaScript `POST` would require an explicit CORS and credentials design on the dashboard, and browser third-party-cookie behavior makes that less reliable; no CORS behavior was added in Phase 4a.
- Before enabling audience enforcement in production, verify a current real Convex token uses `aud = convex`, as the source spec requires. Configure production and development issuer allowlists separately so dev identities cannot enter production.
- The first `x-forwarded-for` value is trusted for rate-limit identity. The deployment proxy must overwrite/sanitize that header. The limiter is per process, is not shared across replicas, and uses a shared `unknown` bucket when no proxy IP header exists.
- StageSnap team identity is not present in the JWT and remains future work. Phase 4a maps only the Convex `sub` and intentionally gives the resulting `tenant` role zero dashboard RBAC capabilities.

## Security fix pass (spec-phase4a-fixes.md + coordinator follow-ups F7/F8)

Blind security review of `4ee0c5d..5815893` found six blocking/major/minor
findings (F1-F6); the crypto/verification core (RS256 pin, issuer-allowlist-
before-JWKS, exp/nbf, dev-token rejection, fail-closed-on-empty-allowlist,
feature-flag-off) held up and was left untouched except the two narrow F4/F5
additions below. A second independent review during this pass added two more
(F7, F8), addressed in the same working tree before commit.

Implemented via two sequential `codex exec` (gpt-5.5, xhigh) passes, each
verified independently by the orchestrator (not trusted from the codex
self-report): (1) F1-F6, (2) F7-F8. Every acceptance check and all three
(then four, with F7) anti-vacuity demos below were re-run by the orchestrator
directly against the working tree — reverting the fix, confirming red,
restoring it, confirming green — not copy-pasted from the implementer.

### Finding → fix mapping

| Finding | Fix | File(s) |
|---|---|---|
| F1 — tenant reaches 59 `requireApiUser`-gated routes | `requireApiUser` returns 403 `{error:"forbidden"}` for role `tenant`; added `requireApiTenant` for future tenant routes; `proxy.ts` gained a real `validateSession` role lookup and `TENANT_ALLOWED_PREFIXES` enforcement | `src/lib/api-auth.ts`, `src/proxy.ts` |
| F2 — JWT carried in query string | Query-token read removed entirely; POST now accepts JSON or form-encoded body (`token` field); Authorization header and Convex-cookie paths kept; `Cache-Control: no-store` + `Referrer-Policy: no-referrer` on every response | `src/app/api/auth/sso/route.ts` |
| F3 — rate limiter trusts `x-forwarded-for` | XFF/x-real-ip only trusted when `TRUSTED_PROXY=true`; added an independent global bucket (15/min, all callers) alongside the existing per-key bucket; both must have tokens or the request 429s | `src/app/api/auth/sso/route.ts`, `.env.example` |
| F4 — `audience \|\| undefined` silently disables aud check | When `STAGESNAP_SSO_ENABLED=true` and `STAGESNAP_SSO_AUDIENCE` is empty, every token is rejected (generic 401); one-time non-secret startup warning | `src/lib/auth/stagesnapSso.ts` |
| F5 — unvalidated `sub` used as identity key | `sub` must match `^[A-Za-z0-9_:.-]{1,128}$` or verification fails generically | `src/lib/auth/stagesnapSso.ts` |
| F6 — cookie/header parity with login route | `Cache-Control: no-store` added; `sameSite: 'lax'` kept with an inline comment (and this record) explaining why: the flow is a cross-site top-level POST/redirect from StageSnap, and `strict` would drop the cookie in that navigation | `src/app/api/auth/sso/route.ts` |
| F7 — `upsertStagesnapUser` account-clobbering via username collision | Upsert now looks up any existing `stagesnap:<sub>` row first; if it exists and `auth_provider !== 'stagesnap'`, the call throws (no mutation) instead of silently flipping the row to `role='tenant'`/`auth_provider='stagesnap'`; `createUser` rejects the reserved `stagesnap:` prefix (case-insensitive) so the namespace can't be squatted going forward. Verified `makeUsernameFromEmail` (Google-provisioned usernames) cannot itself produce a `stagesnap:`-prefixed name — its charset filter (`[^a-z0-9._-]`) strips colons, so no separate fix was needed there. | `src/lib/auth.ts` |
| F8 — no-log-leak test only covered one rejection branch | Extended to also assert no token/sub appears in logs on: unrelated-key signature failure, a JWKS-fetch error (mocked HTTP 503), and a route-level DB-upsert collision failure (F7's new path, exercised through the real route) | `src/lib/auth/stagesnapSso.test.ts` |

### F1 implementation decision: middleware vs guard

The tenant-deny check lives in the **guard** (`requireApiUser` in
`src/lib/api-auth.ts`), not in `requireUser`/`requireAdmin`
(`src/lib/auth.ts`). Rationale: `requireUser` is a general session-resolution
primitive used by non-API callers too; changing its behavior for `tenant`
would risk unintended side effects outside the 59 API routes this pass is
scoped to fix. `requireApiUser` is exactly the choke point 59 route files
already import, so putting the check there directly closes the actual attack
surface with the smallest, most auditable diff, and leaves `requireUser`'s
contract (resolve or throw) unchanged for every other caller.

`src/proxy.ts` **can** and does enforce `TENANT_ALLOWED_PREFIXES` with a real
role lookup: the Next.js proxy in this project runs in the Node.js runtime
(the repo already ships `better-sqlite3` as a server-external package, so a
synchronous DB-backed `validateSession` call is available at the proxy
layer). A tenant session hitting any path outside `/api/auth/` or `/tenant/`
gets a 403 JSON response (`/api/*`) or a redirect to `/tenant` (pages). This
is enforced in addition to, not instead of, the `requireApiUser` check — so
even if a future route forgets to call `requireApiUser`, the proxy layer
still blocks a tenant session from reaching it (defense in depth). The
`/tenant` placeholder page itself is out of scope for this pass (later phase
per the original spec) — proxy.ts redirects there but no page exists yet at
that route; this is expected and matches "the tenant UI is a later phase"
from spec-phase4a-fixes.md.

### New SSO transport contract (input to the StageSnap-side spec)

`POST /api/auth/sso` is now the primary, supported transport:
- Body: `application/json` `{"token": "<jwt>"}` OR
  `application/x-www-form-urlencoded` / `multipart/form-data` with a `token`
  field — StageSnap should perform this as an auto-submitting form POST
  (`response_mode=form_post`-style), never a link/query string.
- Also accepted: `Authorization: Bearer <jwt>` header (server-to-server
  callers only — not usable from a plain browser navigation).
- Also accepted (fallback only): the `__Host-__convexAuthJWT` /
  `__convexAuthJWT` cookie, read directly off the incoming request — usable
  only if the browser is same-origin/same-site enough to carry that cookie
  to the dashboard's origin, which will not be true across distinct
  production domains. StageSnap's spec should NOT rely on this path for
  cross-origin production use; treat it as a same-host/dev convenience only.
- **Removed, permanently:** reading the token from a `?token=` query
  parameter, on both GET and POST. Any StageSnap-side design that puts the
  JWT in a URL will be rejected (401) by this endpoint. Confirmed by the F2
  anti-vacuity test and by the orchestrator's manual revert/restore above.
- `GET /api/auth/sso` still exists and still performs the redirect-on-success
  flow, but only via the Authorization-header or cookie token paths (never
  query). If StageSnap needs a plain `<a href>`/redirect click-through with
  no shared cookie and no ability to set a custom header, that is NOT
  currently supported and needs a decision in the StageSnap-side spec (e.g.
  a short-lived server-minted one-time code instead of the raw JWT).
- Every response (200/401/404/429) carries `Cache-Control: no-store` and
  `Referrer-Policy: no-referrer`.
- The resulting `hermes-session` cookie is `httpOnly`, `sameSite: 'lax'`
  (required — see F6), `secure` per the existing `AUTH_COOKIE_SECURE`/
  `x-forwarded-proto` logic, 7-day `maxAge`, `path: '/'`.
- Rate limiting: per-IP bucket (10/min, only trusts `x-forwarded-for`/
  `x-real-ip` when `TRUSTED_PROXY=true` is set on the dashboard's own
  deployment — this must be set correctly at deploy time for the platform's
  actual proxy topology) plus an independent global bucket (15/min across
  all callers) so header rotation cannot bypass rate limiting or amplify
  JWKS fetches.

### Accepted-risk decision (F8 follow-up, no code change)

Local issuer-allowlist rejection in `verifyStagesnapToken` returns in
sub-millisecond time (pure string comparison, no network), while an
allowed-issuer verification failure goes through the JWKS fetch/cache path
and takes measurably longer — so an attacker probing response latency could
in principle enumerate which issuers are in the trusted allowlist. This is
**accepted as a non-issue**: the issuer string is public information,
published in StageSnap's own OIDC discovery document
(`https://http.stagesnap.ai/.well-known/openid-configuration`), so there is
nothing secret being leaked via the timing channel. No constant-time fix was
applied.

### Acceptance checks — orchestrator-verified output

1. `pnpm typecheck` — clean (exit 0), and `pnpm test` — 108/108 pass
   (existing 94 + 14 new across F1-F8).
2. Anti-vacuity — all four demonstrated failing-then-passing by the
   orchestrator directly (not the implementer's self-report):
   - (a) F1: with `requireApiUser`'s tenant check removed,
     `five real requireApiUser route handlers reject tenant sessions` failed
     `200 !== 403` (activity route). Restored → 6/6 tenantAccess tests pass.
   - (b) F2: with query-token support re-added to `requestToken`,
     `query-string tokens are ignored` failed `307 !== 401`. Restored →
     passes.
   - (c) F4: with the fail-closed audience guard removed (back to bare
     `audience` passed to `jwtVerify` with no pre-check),
     `4b. enabled SSO rejects every token when audience is unset or empty`
     failed `Missing expected rejection`. Restored → passes.
   - (d) F7 (coordinator addition, held to the same bar): with the
     `auth_provider !== 'stagesnap'` collision guard removed from
     `upsertStagesnapUser`,
     `StageSnap upsert rejects a username collision without clobbering the local account`
     failed `Missing expected exception`. Restored → passes, and the full
     108-test suite + typecheck were re-run clean after every revert/restore
     cycle to confirm no residual state.
3. Regression proof: `admin, editor, viewer, and operator sessions still
   pass requireApiUser` and `viewer sessions still pass the same five real
   requireApiUser route handlers` both pass against the identical 5 real
   route modules (activity, approval history, content performance,
   engagement, experiments) used for the tenant-rejection assertions.
4. Feature-inert-by-default live curl check (item 4 in the fixes spec)
   was **not** re-run against `100.101.23.37:3003` in this pass — that host
   was reachable in the original Phase 4a pass (see the base-endpoint
   404 result above) and no code path affecting the disabled-by-default
   404 response (`STAGESNAP_SSO_ENABLED !== 'true'` short-circuit) was
   touched by F1-F8. Flagged here rather than fabricated; re-run before
   shipping if the deployed instance may be stale.
5. `git diff hermes-port-phase2 --stat` — orchestrator-confirmed to contain
   exactly: `.env.example`, `package.json`, `pnpm-lock.yaml` (both pre-
   existing from the original SSO commit, untouched by this fix pass),
   `src/app/api/auth/sso/route.ts`, `src/lib/api-auth.ts`,
   `src/lib/auth.ts`, `src/lib/auth.test.ts`,
   `src/lib/auth/stagesnapSso.ts`, `src/lib/auth/stagesnapSso.test.ts`,
   `src/proxy.ts`, plus the new untracked `src/lib/auth/tenantAccess.test.ts`
   — i.e. exactly the Files-touched list from spec-phase4a-fixes.md, no
   route files under `src/app/api/**` (other than the SSO route itself) were
   modified. `git diff --check` reported no whitespace/conflict issues.

### Deferred / open items

- `/tenant` placeholder page does not exist yet — proxy.ts redirects tenant
  page requests there, but the page itself is explicitly out of scope
  (later phase, per spec-phase4a-fixes.md F1 note "the tenant UI is a later
  phase").
- `requireApiTenant` has no callers yet — added for the future tenant-facing
  phase, as directed.
- The live-deployment curl check (acceptance check 4) was not re-executed in
  this pass; see note above.
- F8's DB-upsert-failure log-leak coverage is exercised through the real F7
  collision path (route-level, via `POST /api/auth/sso`), not through a
  synthetic raw SQLite I/O failure (e.g. locked database) — the collision
  path was judged the realistic upsert-failure case worth covering; a
  contrived low-level DB fault was not added.
- No commits were made by either codex pass (as instructed); the
  orchestrator checkpoint-commits this working tree immediately after
  writing this audit entry.
