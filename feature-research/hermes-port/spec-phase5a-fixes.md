# Spec: Phase 5a fixes — path leakage + fail-closed completeness

Two blockers from the security review of `1c11de7..c41e902`, plus cheap
hardening. Branch `hermes-port-phase5a`. The core binding is sound and must not
be restructured: `resolveTenantBackend` already resolves only from the session's
DB-read `tenant_instance_id`, never from the request. Leave that alone.

## Files touched
- src/lib/api-auth.ts
- src/lib/instances.ts
- src/lib/backend/index.ts
- src/lib/tenantBinding.test.ts
- feature-research/hermes-port/audit-phase5a.md (append)
HARD BOUNDARY: nothing else.

## G1 — BLOCKER: `sanitizeForTenant` only redacts strings that START with `/`
`src/lib/api-auth.ts:48` is `value.startsWith('/')`, so a path *embedded* in a
longer string passes through untouched. `src/app/api/tenant/cron/route.ts:16`
returns `job.deliveryError` verbatim — and delivery errors are common in
practice (the live Hermes home has 7 of 10 jobs carrying one), so this leaks
absolute filesystem layout, and with it the tenancy naming scheme, to any tenant
with a failing cron job. No misconfiguration required.

Fix `sanitizeForTenant` to redact path-CONTAINING strings, not just
path-prefixed ones:
1. Redact any substring matching an absolute POSIX path of depth ≥2
   (`/segment/segment...`), replacing the match with `[path]` rather than
   dropping the whole string — a tenant still needs the human-readable part of
   "delivery failed: no target resolved" to be useful.
2. Additionally redact, by exact substring match, every configured instance
   `homeDir` and `os.homedir()`, before the generic pass. These are the highest
   value leaks and must not depend on the regex being perfect.
3. Do NOT mangle `http(s)://` URLs — match them first and leave them intact
   (a delivery target URL is legitimate tenant-facing information).
4. Apply to every string reached by the recursive walk, at any depth, including
   values inside arrays.

Tests: a `deliveryError` of
`"failed reading /Users/x/.hermes/profiles/stagesnap:bbb/state.db"` returns with
the path redacted and the prose intact; a URL-bearing message keeps its URL; a
string equal to another tenant's homeDir is redacted; nested/array cases covered.

## G2 — BLOCKER: fail-closed check doesn't verify `homeDir` is a directory
`src/lib/instances.ts:138-140` uses `existsSync(homeDir)` only, which is true
for a regular file and follows symlinks. The spec explicitly listed the
file/symlink case. Phase 5b provisioning will depend on this being strict.

Fix `getTenantInstance`:
- `statSync(homeDir)` must report `isDirectory()`, else return null.
- Reject when the path is a symlink: `lstatSync(homeDir).isSymbolicLink()` →
  null. (A provisioning bug that symlinks one tenant's home at another's is
  exactly the failure this guards.)
- Wrap in try/catch — any stat error is a null (fail closed), never a throw
  that could surface a path in an error response.

Tests: homeDir is a regular file → 403 `tenant_not_provisioned`; homeDir is a
symlink to a valid directory → 403; homeDir missing → 403 (existing); happy path
still 200.

## G3 — Cheap hardening (do these, they are one-liners)
- `getTenantInstance` must also require `instance.kind === 'hermes'`. Otherwise
  an entry with `kind:'openclaw'` and a populated `homeDir` passes, and
  `backendForInstance` would construct an OpenClaw backend against a different
  directory than intended.
- Replace the `toLocaleLowerCase('en-US')` comparison in
  `src/lib/backend/index.ts:56-62` with an exact, case-SENSITIVE string
  comparison. Instance ids are `stagesnap:<sub>` with a validated charset, so
  case-folding buys nothing and opens a Unicode-folding hole (Kelvin sign K
  folds to k) that lets a probe attempt slip past the intended loud 403. Not a
  data leak — resolution always uses the bound id — but the spec requires the
  403 and exactness is simpler than folding.

## G4 — Test strengthening (the reviewer showed three are weaker than they look)
- The positive-binding test currently uses tenant A, which is `instances[0]`, so
  it would still pass if resolution silently fell back to the default. **Change
  it to tenant B** (a non-first instance) so a fallback regression fails here
  too, not only in the unconfigured-binding test.
- The binding-persistence test calls `upsertStagesnapUser` directly; add a
  route-level assertion so it would fail if `validateSession` stopped reading
  `tenant_instance_id`.
- The secret-scan test is partially vacuous for the agent and cron routes
  (their handlers hand-pick fields, so blocked keys can't appear regardless).
  Keep it, but add a case that proves `sanitizeForTenant` itself is wired in:
  feed a fixture whose passthrough field (e.g. `deliveryError`, or the sessions
  route's `usage[].totals`) carries a blocked key/path, and assert it is
  scrubbed — this is the test that fails if the sanitizer call is deleted.

## Acceptance checks
1. `pnpm typecheck` clean; `pnpm test` all pass (117 existing + new).
2. Anti-vacuity, both shown failing-then-passing with pasted output:
   (a) revert `sanitizeForTenant` to `startsWith('/')` → the embedded-path test
   fails; (b) revert `getTenantInstance` to `existsSync` only → the
   file/symlink test fails.
3. All nine original phase-5a adversarial tests still pass unchanged.
4. Both golden checks still pass; phase-4a tests diff to zero.
5. `git diff hermes-port-phase4a --stat` shows only phase-5a files.

## Output contract
Append "Security fix pass" to audit-phase5a.md: the redaction strategy and its
limits (state plainly what a determined leak could still look like), the
fail-closed matrix after the change, all acceptance outputs, both anti-vacuity
demos.
