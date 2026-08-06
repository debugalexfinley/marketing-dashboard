# Spec: Phase 4a — StageSnap SSO (dashboard side only)

## Goal
A StageSnap user who clicks "AI Dashboard" lands in the marketing dashboard
already authenticated, with no second login and no new token infrastructure on
the StageSnap side. The dashboard verifies the Convex-issued JWT the user
already holds, maps it to a dashboard user, and issues its normal session
cookie. Seed-password login continues to work unchanged for internal instances.

Scope: **this repo only** (`/Users/alexfinley/Documents/GitHub/marketing-dashboard`,
branch `hermes-port-phase2`). Zero changes to the StageSnap repo — that side is
a separate spec requiring the user's approval, since it is a production app.

## Verified facts (do not re-derive, do not guess)
StageSnap runs Next.js + Convex with `@convex-dev/auth`; sessions are Convex
JWTs in the `__Host-__convexAuthJWT` cookie (localhost: `__convexAuthJWT`).

- **Production deployment**: `glorious-caterpillar-774`
  - OIDC issuer: **`https://http.stagesnap.ai`** (custom domain — NOT a
    `.convex.site` URL)
  - JWKS: `https://http.stagesnap.ai/.well-known/jwks.json`
- **Dev deployment**: `beloved-jellyfish-218`
  - issuer/JWKS under `https://beloved-jellyfish-218.convex.site`
- `applicationID` is `"convex"` (see stagesnap.ai `convex/auth.config.ts`) —
  expect it as the `aud` claim; verify against a real token before enforcing.
- Tenant identity = Convex `userId` (the `sub` claim). Optional `teamId` exists
  for team plans (`teams`/`teamMembers` tables) but is NOT in the token — treat
  team mapping as future work.

## Files touched
New:
- src/lib/auth/stagesnapSso.ts        (JWKS fetch+cache, verification)
- src/lib/auth/stagesnapSso.test.ts
- src/app/api/auth/sso/route.ts       (the endpoint)
Modified:
- .env.example                        (document the new vars)
- src/lib/auth/* or wherever session issuance lives — locate it first; reuse
  the EXISTING session-cookie issuance path, do not write a parallel one.
HARD BOUNDARY: nothing else. No StageSnap repo files. No UI/theming (separate
phase). If session issuance can't be reused without refactoring, STOP and report.

## Endpoint contract
`POST /api/auth/sso` (also accept `GET` for the click-through hop):
1. Read the token from, in order: `Authorization: Bearer <jwt>`, then a `token`
   query param (GET hop), then the `__Host-__convexAuthJWT` / `__convexAuthJWT`
   cookie if the request carries it.
2. Verify with `jose` (already in the dependency tree? check — if not, STOP and
   report rather than adding a dep):
   - signature against JWKS from the configured issuer's
     `/.well-known/jwks.json`, cached with a TTL (10 min) and refetched on
     unknown `kid`
   - `iss` ∈ the configured trusted-issuer allowlist (exact string match)
   - `aud` === configured audience when set
   - `exp` / `nbf` with ≤60s clock skew
   - **`alg` allowlist: RS256 only.** Explicitly reject `none` and any HMAC alg.
3. On success: upsert a dashboard user keyed by `stagesnap:<sub>`, role
   `tenant` (never admin), then issue the app's normal session cookie via the
   existing code path. Redirect (GET) or return `{ok:true}` (POST).
4. On any failure: generic 401 `{error:"invalid_sso_token"}`. Never leak which
   check failed, never echo the token.

## Config (env)
```
STAGESNAP_SSO_ENABLED=false                       # default OFF
STAGESNAP_SSO_ISSUERS=https://http.stagesnap.ai   # comma-separated allowlist
STAGESNAP_SSO_AUDIENCE=convex                     # optional; enforced when set
STAGESNAP_SSO_JWKS_TTL_MS=600000
```
When `STAGESNAP_SSO_ENABLED` is not `true`, the route returns 404 — the feature
must be inert on every existing deployment (including the Mini instance from
phase 3) until explicitly turned on.

## Security requirements (non-negotiable)
- Algorithm confusion: RS256 only; a token with `alg:none` or `alg:HS256` signed
  with the JWKS modulus must be REJECTED — cover both with tests.
- Issuer pinning: a validly-signed token from the DEV deployment must be
  rejected when only the prod issuer is configured (this is the exact mistake
  that would let dev accounts into production data) — test it.
- No token, `sub`, or JWKS material in logs at any level.
- Rate limit the endpoint (in-memory token bucket is fine, e.g. 10/min/IP) so
  it can't be used as a JWKS-fetch amplifier or brute-force oracle.
- SSO-created users get role `tenant` only; privilege can never be derived from
  a claim in the token.
- Do not weaken or bypass the existing host-lock/auth middleware; SSO is an
  additional issuance path, not a replacement.

## Tests (all offline — generate keypairs in-test, no network)
Serve a local JWKS from an in-test RSA keypair and assert:
1. valid token → 200 + session cookie set + user upserted with role `tenant`
2. expired token → 401; not-yet-valid (`nbf` future) → 401
3. wrong issuer (dev issuer while only prod configured) → 401
4. wrong audience when audience configured → 401
5. `alg:none` → 401; HS256 signed with the public modulus → 401
6. signature by an unrelated key → 401
7. unknown `kid` triggers exactly one JWKS refetch, then 401 if still unknown
8. `STAGESNAP_SSO_ENABLED` unset → route 404s (feature inert)
9. rate limit trips at the configured threshold
10. no log line in any test contains the token string or the `sub`

## Acceptance checks
1. `pnpm typecheck` clean; `pnpm test` all pass including the 10 above.
2. Anti-vacuity: temporarily allow `alg:none` → test 5 fails; revert → passes.
   Paste both outputs.
3. With the feature disabled (default), `curl -s -o /dev/null -w '%{http_code}'
   http://100.101.23.37:3003/api/auth/sso` → 404 against the running phase-3
   deployment (i.e. existing deployments are unaffected).
4. `git diff hermes-port-phase2 --stat` shows only the files listed above.
5. Live JWKS reachability check (read-only, no auth): the prod JWKS URL returns
   a key set containing at least one RS256 key. Paste the key count only —
   never key material.

## Constraints
No pushes. Checkpoint commit on green. No new dependencies without reporting
first. Branch from `hermes-port-phase2` as `hermes-port-phase4a`.

## Output contract
`feature-research/hermes-port/audit-phase4a.md`: the session-issuance path
reused, config surface, all acceptance outputs, the anti-vacuity demo, and an
explicit list of what the StageSnap side will need to do (the button/link and
which cookie/domain considerations apply) — that becomes the input to the
StageSnap-side spec the user must approve separately.
