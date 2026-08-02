# Phase 5a audit — per-tenant instance binding

## 1. Files changed

Real final `git diff hermes-port-phase4a --stat` output (captured after staging the authorized checkpoint set):

```text
 .env.example                                  |   3 +
 feature-research/hermes-port/audit-phase5a.md | 265 ++++++++++++++++++++++++++
 src/app/api/tenant/agent/route.ts             |  23 +++
 src/app/api/tenant/cron/route.ts              |  28 +++
 src/app/api/tenant/sessions/route.ts          |  39 ++++
 src/lib/api-auth.ts                           |  25 +++
 src/lib/auth.ts                               |  21 +-
 src/lib/backend/index.ts                      |  51 ++++-
 src/lib/instances.ts                          |   8 +
 src/lib/tenantBinding.test.ts                 | 210 ++++++++++++++++++++
 src/proxy.ts                                  |   2 +-
 11 files changed, 665 insertions(+), 10 deletions(-)
```

## 2. Migration approach

The existing idempotent `ensureAuthTables()` migration pattern was used exactly: attempt the SQLite column addition and ignore only the expected already-exists failure.

```ts
try {
  db.exec("ALTER TABLE users ADD COLUMN tenant_instance_id TEXT NULL");
} catch { /* column exists */ }
```

StageSnap insert and conflict-update paths both set the deterministic binding:

```sql
INSERT INTO users (username, password_hash, role, auth_provider, tenant_instance_id)
VALUES (?, ?, 'tenant', 'stagesnap', ?)
ON CONFLICT(username) DO UPDATE SET
  role = 'tenant',
  auth_provider = 'stagesnap',
  tenant_instance_id = excluded.tenant_instance_id
```

The bound value passed for the final parameter is `stagesnap:${sub}`. `validateSession()` selects `u.tenant_instance_id` from the user row joined through the session. Local/internal user creation does not set it, so SQLite leaves it `NULL`.

## 3. Resolution truth table

`resolveTenantBackend(request)` first reuses `requireApiTenant(request)`, then reads the session user's DB binding. URLSearchParams supplies URL-decoded values; `instance` and `namespace` comparisons are case-insensitive. Backend resolution uses `getTenantInstance()`, an exact configured-id lookup with no legacy/default fallback and an existing-`homeDir` requirement.

| Input | Internal caller behavior (unchanged) | Tenant caller result |
|---|---|---|
| No parameter | Existing `resolveBackend(undefined)` selects the existing default/first instance behavior. | `200`; bound backend only. Body is the route's sanitized `{instanceId, profiles}`, `{instanceId, jobs}`, or `{instanceId, sessions, usage}` shape. |
| Matching `?instance=` (including case-only differences) | Existing request-selected `resolveBackend(instanceId)` behavior. | `200`; parameter is ignored for resolution and the session binding is used. Same sanitized body shapes. |
| Mismatched `?instance=` | Existing request-selected instance behavior, including current internal fallback semantics. | `403 {"error":"tenant_instance_mismatch"}` before backend data is read. |
| Mismatched `?namespace=` | Existing request-selected namespace behavior. | `403 {"error":"tenant_instance_mismatch"}` before backend data is read. |
| Session binding not present in `getInstances()` | Internal sessions have no binding dependency; existing resolution is unchanged. | `403 {"error":"tenant_not_provisioned"}`; no default fallback. |
| Exact configured binding whose `homeDir` is missing | Existing internal backend construction behavior is unchanged. | `403 {"error":"tenant_not_provisioned"}`. |
| Path-traversal subject (`../../etc`) | Internal callers do not derive instance IDs from a tenant binding; request behavior is unchanged. | The direct helper creates the literal binding `stagesnap:../../etc`, which exact lookup rejects with `403 {"error":"tenant_not_provisioned"}`. The external SSO verifier rejects slash-containing `sub` values earlier via `^[A-Za-z0-9_:.-]{1,128}$`. No path concatenation occurs. |

Non-tenant/unauthenticated callers to tenant handlers receive `403 {"error":"forbidden"}`, preserving `requireApiTenant`'s existing signature and return semantics.

## 4. Acceptance checks

### Check 1 — typecheck and full tests

Before implementation:

```text
$ pnpm test
ℹ tests 108
ℹ suites 0
ℹ pass 108
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2982.305417
```

After implementation:

```text
$ pnpm typecheck && pnpm test
> hermes-dashboard@0.2.0 typecheck
> tsc --noEmit

> hermes-dashboard@0.2.0 test
> node --import tsx --test --test-concurrency=1 "src/lib/**/*.test.ts"
ℹ tests 117
ℹ suites 0
ℹ pass 117
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2431.504667
```

The two phase-4a files were also run explicitly without changing their assertions:

```text
$ node --import tsx --test --test-concurrency=1 src/lib/auth/tenantAccess.test.ts src/lib/auth/stagesnapSso.test.ts
ℹ tests 23
ℹ suites 0
ℹ pass 23
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 823.076125
```

### Check 2 — anti-vacuity

Both required mutations failed their targeted real-handler tests and passed after restoration. Exact diffs and outputs are repeated in section 5.

### Check 3 — scope

The real final stat is in section 1. The staged-name check contained only the authorized ten implementation/test/config paths plus this audit. Pre-existing untracked phase specs and `audit-phase3.md` were neither edited nor staged.

### Check 4 — OpenClaw and Hermes golden baselines

The standard script first exposed an existing phase-4a Next.js build error in an out-of-scope file:

```text
$ pnpm golden:check
src/app/api/auth/sso/route.ts
Type error: Route "src/app/api/auth/sso/route.ts" does not match the required types of a Next.js Route.
  "resetSsoRateLimitsForTests" is not a valid Route export field.
Next.js build worker exited with code: 1 and signal: null
```

`hermes-port-phase4a:src/app/api/auth/sso/route.ts` contains that same export. The hard file boundary prohibited changing it. A temporary `/tmp` `pnpm` shim changed only the harness's build subcommand from `next build --webpack` to `next build --webpack --experimental-build-mode compile`; it did not alter repository files, capture routes, production `next start`, or byte comparison.

```text
$ PATH=/tmp/phase5a-golden-bin:<node24-and-system-path> node feature-research/hermes-port/golden/capture.mjs --check
Building production app...
✓ Compiled successfully in 21.7s
200 /api/agents
...
200 /api/chat/messages
Golden check passed: 19 JSON files are byte-identical.

$ PATH=/tmp/phase5a-golden-bin:<node24-and-system-path> node feature-research/hermes-port/golden/capture.mjs --backend hermes --check
Building production app...
✓ Compiled successfully in 20.3s
200 /api/agents
...
200 /api/chat/messages
Golden check passed: 19 JSON files are byte-identical.
```

### Check 5 — live smoke

Skipped as explicitly authorized because `http://100.101.23.37:3003` may be unreachable from this environment. No request was sent to the live phase-3 deployment.

## 5. Anti-vacuity demonstrations

### A. Temporarily honor a mismatched `?instance=`

Exact temporary diff:

```diff
@@ -54,16 +54,17 @@
   const url = new URL(request.url);
   const boundId = instanceId.toLocaleLowerCase('en-US');
-  for (const parameter of ['instance', 'namespace']) {
+  const effectiveId = url.searchParams.get('instance') ?? instanceId;
+  for (const parameter of ['namespace']) {
     const supplied = url.searchParams.get(parameter);
     if (supplied !== null && supplied.toLocaleLowerCase('en-US') !== boundId) {
       throw new TenantAccessError('tenant_instance_mismatch');
     }
   }

-  const instance = getTenantInstance(instanceId);
+  const instance = getTenantInstance(effectiveId);
   if (!instance) throw new TenantAccessError('tenant_not_provisioned');
-  return { backend: backendForInstance(instance), instanceId };
+  return { backend: backendForInstance(instance), instanceId: effectiveId };
 }
```

Failing output:

```text
$ node --import tsx --test --test-concurrency=1 --test-name-pattern='mismatched instance and namespace' src/lib/tenantBinding.test.ts
✖ every tenant handler rejects mismatched instance and namespace probes without B data (59.904209ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
AssertionError [ERR_ASSERTION]: agent ?instance=stagesnap:bbb
200 !== 403
at src/lib/tenantBinding.test.ts:146:14
```

Passing after the exact mutation was reverted:

```text
$ node --import tsx --test --test-concurrency=1 --test-name-pattern='mismatched instance and namespace' src/lib/tenantBinding.test.ts
✔ every tenant handler rejects mismatched instance and namespace probes without B data (60.427541ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

### B. Temporarily add default-instance fallback

Exact temporary diff:

```diff
@@ -136,7 +136,8 @@
 /** Strict tenant lookup: exact configured id only, with no legacy/default fallback. */
 export function getTenantInstance(id: string): HermesInstance | null {
-  const instance = getInstances().find((candidate) => candidate.id === id);
+  const instances = getInstances();
+  const instance = instances.find((candidate) => candidate.id === id) ?? instances[0];
   if (!instance?.homeDir || !existsSync(instance.homeDir)) return null;
   return instance;
 }
```

Failing output:

```text
$ node --import tsx --test --test-concurrency=1 --test-name-pattern='unconfigured tenant binding fails closed' src/lib/tenantBinding.test.ts
✖ unconfigured tenant binding fails closed without configured-instance data (61.576333ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
200 !== 403
at src/lib/tenantBinding.test.ts:156:10
```

Passing after the exact mutation was reverted:

```text
$ node --import tsx --test --test-concurrency=1 --test-name-pattern='unconfigured tenant binding fails closed' src/lib/tenantBinding.test.ts
✔ unconfigured tenant binding fails closed without configured-instance data (61.171041ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

Both stable files were byte-compared to their pre-mutation copies after revert (`diff -u` produced no output).

## 6. Phase 5b provisioning contract

To create a tenant accepted by this binding, provisioning must:

1. Accept only an SSO `sub` that passes `^[A-Za-z0-9_:.-]{1,128}$`.
2. Create an isolated Hermes home directory before traffic is enabled, with the tenant's profile/config/state permissions restricted to the dashboard service account.
3. Add exactly one `HERMES_OPENCLAW_INSTANCES` entry whose id is `stagesnap:<sub>`, `kind` is `hermes`, and `homeDir` is that existing directory. The `profile` should identify the tenant profile.
4. Complete both config publication and directory creation atomically enough that requests cannot be routed to a partial home. Until both exist, 403 `tenant_not_provisioned` is the intended result.
5. Never rely on `HERMES_DEFAULT_INSTANCE`, the first configured instance, the legacy `leads`/`openclaw` aliases, or path construction from the subject.

## 7. Deviations and confirmations

- The resumed worktree did not match the handoff exactly: `audit-phase5a.md` was absent, while `audit-phase3.md` and four phase spec files were already untracked. They were treated as user-owned, read where required, and excluded from the checkpoint.
- The standard golden build is blocked by the pre-existing, out-of-scope SSO route export described in check 4. The repository was not modified to work around it; both byte comparisons passed through the temporary compile-only build shim.
- The authorized live smoke was skipped as requested.
- `requireApiTenant(request)` was not changed. It still returns `null` for a tenant and a 403 `NextResponse` otherwise.
- Existing `getInstance()` and public `resolveBackend(instanceId?)` signatures and behaviors remain unchanged; tenant resolution is an added strict path.
- `src/proxy.ts` changed by exactly one line: only the literal `'/api/tenant/'` was added to `TENANT_ALLOWED_PREFIXES`. No matching logic or other code in that file changed.
- No existing internal route was edited, no real Hermes home was mutated, no dependencies were added, and no live state was changed.

## Security fix pass

### Redaction strategy and honest limits (G1)

`sanitizeForTenant()` still walks arrays and objects recursively. For every string it reaches, it now:

1. Splits out `http://` and `https://` URL spans and leaves those spans unchanged.
2. In each non-URL span, replaces every configured instance `homeDir` and `os.homedir()` by exact substring matching with `[path]`. Longer sensitive paths are processed first.
3. Replaces remaining absolute POSIX paths with at least two non-empty segments after the leading slash with `[path]`.

The surrounding message remains useful: `failed reading /Users/x/.hermes/profiles/stagesnap:bbb/state.db` becomes `failed reading [path]` instead of disappearing as a whole value. The recursive walk applies the same handling inside nested objects and arrays.

This is deliberately a targeted output sanitizer, not a general secret detector. It can still miss relative paths such as `profiles/tenant/state.db`, Windows paths using backslashes or drive letters, a path divided across multiple string fields, percent/base64/Unicode-escaped or otherwise encoded paths, and absolute POSIX strings shallower than the required two-segment pattern. A configured home replacement can leave a one-segment suffix visible, for example `[path]/state.db`; it hides the configured tenancy path but not that filename. URL spans are intentionally protected in full, so path-looking URL segments survive. A determined leak encoded into a URL, split across fields, or transformed before serialization is outside this sanitizer's coverage and must be prevented at response shaping and data-source boundaries too.

### Fail-closed tenant instance matrix (G2/G3)

| Configured lookup condition | Result |
|---|---|
| ID is not configured | `null` |
| `homeDir` is absent/empty | `null` |
| `homeDir` path is missing | `null` (stat error is caught) |
| `homeDir` is a regular file | `null` |
| `homeDir` is a symlink to a valid directory | `null` |
| Any `lstatSync`/`statSync` error | `null` |
| `kind: 'openclaw'` with a valid directory | `null` |
| `kind` is undefined with a valid directory | `null` |
| Exact configured ID, `kind: 'hermes'`, real non-symlink directory | instance |

The load-bearing binding shape was not restructured: `resolveTenantBackend()` still obtains `tenant_instance_id` from `requireUser(request)`'s DB-read session user, checks request parameters only for mismatch rejection, and resolves the backend only through exact configured-ID lookup. It never selects a backend from `?instance=` or `?namespace=`.

### G5, G6, and G7 coverage

- G5: `TENANT_BLOCKED_KEYS` remains the literal source-of-truth set. A module-load companion set lowercases each literal and strips `_`/`-`; comparison keys receive the same transform. Direct tests prove both `systemPrompt` and `System_Prompt` are removed.
- G6: all three tenant routes preserve the existing `TenantAccessError` 403 mapping. Every other error goes through `tenantInternalErrorResponse()`, which logs only the original error server-side and returns exactly `500 {"error":"internal_error"}`. The real cron backend regression fixture uses a valid tenant directory whose `cron/jobs.json` is a self-referential symlink, producing an absolute-path-bearing `ELOOP` error inside `backend.listCronJobs()`. The test proves the original error is logged but its path, raw message, and filesystem error text are absent from the response.
- G7: a table-driven test invokes agent, cron, and sessions handlers without a cookie. All return the existing unauthenticated tenant shape, `403 {"error":"forbidden"}`, and none contains either fixture model or fixture home path.

### Per-file change summary (seven code/test files)

- `src/lib/api-auth.ts`: added URL-protected embedded POSIX path redaction, exact configured-home/OS-home substring redaction, normalized blocked-key comparison, and the generic tenant-route 500 helper.
- `src/lib/instances.ts`: made tenant lookup require `kind === 'hermes'`, reject symlinks and non-directories, and catch all stat failures as `null`.
- `src/lib/backend/index.ts`: changed only the request-probe comparison to exact case-sensitive equality; session-row backend binding remains structurally unchanged.
- `src/lib/tenantBinding.test.ts`: moved the positive binding proof to non-first tenant B; added the session-row route proof; added file, symlink, wrong-kind, embedded/exact/nested/URL sanitizer, key-normalization, live cron-sanitizer, generic-500, and unauthenticated-route coverage; moved mixed-case parameters to rejection probes.
- `src/app/api/tenant/agent/route.ts`: preserved typed 403 handling and converted unexpected failures to logged generic 500 responses.
- `src/app/api/tenant/cron/route.ts`: preserved typed 403 handling and converted unexpected failures to logged generic 500 responses.
- `src/app/api/tenant/sessions/route.ts`: preserved typed 403 handling and converted unexpected failures to logged generic 500 responses.

### Acceptance outputs

#### Typecheck — PASS

```text
$ pnpm typecheck
> hermes-dashboard@0.2.0 typecheck /Users/alexfinley/Documents/GitHub/marketing-dashboard
> tsc --noEmit
```

#### Full test run — PASS, 124/124

The branch had 117 tests before this pass and has seven new tests. Exact final terminal result:

```text
$ pnpm test
✔ path-traversal subject creates only an exact unconfigured binding and cannot escape (21.884833ms)
✔ writebackLeadCreate creates leads.json when missing and upserts by id (0.872625ms)
✔ writebackLeadUpdate updates an existing lead (0.725ms)
✔ writebackLeadDelete removes an existing lead (0.402667ms)
ℹ tests 124
ℹ suites 0
ℹ pass 124
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2772.314959
```

The complete tenant-binding file, including all original phase-5a adversarial coverage with the required G3/G4 expectation changes, also passed:

```text
$ node --import tsx --test --test-concurrency=1 src/lib/tenantBinding.test.ts
✔ tenant binding persists on insert and conflict update and is read from the session row (86.286667ms)
✔ tenant B agent handler returns only B profile and accepts exact matching params (25.270041ms)
✔ every tenant handler rejects mismatched instance and namespace probes without B data (26.106042ms)
✔ unconfigured tenant binding fails closed without configured-instance data (23.233291ms)
✔ configured tenant binding with a missing homeDir fails closed (22.831625ms)
✔ regular-file and symlink tenant homes fail closed (44.279375ms)
✔ a non-Hermes configured tenant home fails closed (22.2775ms)
✔ sanitizeForTenant redacts embedded, exact, nested, and array paths but preserves URLs (0.398375ms)
✔ sanitizeForTenant removes normalized blocked-key variants (0.197125ms)
✔ the cron route applies tenant sanitization to pass-through delivery errors (23.237958ms)
✔ tenant routes return a generic 500 without backend path or message leakage (22.292334ms)
✔ all tenant routes reject unauthenticated requests without tenant data (0.560334ms)
✔ all tenant handlers strip secrets and absolute fixture paths from full response bodies (25.064125ms)
✔ internal viewer retains request-controlled instance selection on a real handler (7.077ms)
✔ tenant remains forbidden on the same five real internal handlers (22.359792ms)
✔ path-traversal subject creates only an exact unconfigured binding and cannot escape (23.85925ms)
ℹ tests 16
ℹ suites 0
ℹ pass 16
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 662.492458
```

#### Golden checks — both PASS, 19/19 byte-identical

The unmodified standard command reached the same pre-existing phase-4a Next.js route-export blocker already recorded earlier in this audit:

```text
$ pnpm golden:check
> hermes-dashboard@0.2.0 golden:check /Users/alexfinley/Documents/GitHub/marketing-dashboard
> node feature-research/hermes-port/golden/capture.mjs --check
Building production app...
> hermes-dashboard@0.2.0 build /Users/alexfinley/Documents/GitHub/marketing-dashboard
> next build --webpack
✓ Compiled successfully in 27.9s
Failed to compile.
src/app/api/auth/sso/route.ts
Type error: Route "src/app/api/auth/sso/route.ts" does not match the required types of a Next.js Route.
  "resetSsoRateLimitsForTests" is not a valid Route export field.
Next.js build worker exited with code: 1 and signal: null
Error: pnpm build exited with 1
```

That file is unchanged from `hermes-port-phase4a` and is outside this fix's hard boundary. As in the existing phase-5a audit, a temporary `/tmp` `pnpm` shim changed only the harness build invocation to `next build --webpack --experimental-build-mode compile`; no repository file was changed. Real OpenClaw comparison output:

```text
$ PATH=/tmp/phase5a-fix-golden-bin:<node-and-system-path> node feature-research/hermes-port/golden/capture.mjs --check
Building production app...
✓ Compiled successfully in 20.0s
Starting production app on http://127.0.0.1:59858...
✓ Ready in 302ms
200 /api/agents
200 /api/cron
200 /api/cron/jobs
200 /api/cron/runs
200 /api/automations
200 /api/hud
200 /api/chat/sync-sessions
200 /api/memory-health
200 /api/memory-drift
200 /api/memory-alerts
200 /api/memory-policy
200 /api/memory-alert-policy
200 /api/memory-effect
200 /api/deploy-status
200 /api/agents/workspace-roots
200 /api/agents/workspace
200 /api/instances
200 /api/mission-control/chat
200 /api/chat/messages
Golden check passed: 19 JSON files are byte-identical.
```

Real Hermes comparison output:

```text
$ PATH=/tmp/phase5a-fix-golden-bin:<node-and-system-path> node feature-research/hermes-port/golden/capture.mjs --backend hermes --check
Building production app...
✓ Compiled successfully in 18.0s
Starting production app on http://127.0.0.1:61689...
✓ Ready in 271ms
200 /api/agents
200 /api/cron
200 /api/cron/jobs
200 /api/cron/runs
200 /api/automations
200 /api/hud
200 /api/chat/sync-sessions
404 /api/memory-health
404 /api/memory-drift
404 /api/memory-alerts
200 /api/memory-policy
200 /api/memory-alert-policy
200 /api/memory-effect
200 /api/deploy-status
200 /api/agents/workspace-roots
200 /api/agents/workspace
200 /api/instances
200 /api/mission-control/chat
200 /api/chat/messages
Golden check passed: 19 JSON files are byte-identical.
```

#### Phase-4a test preservation and phase-5a scope

The two phase-4a test files are byte-identical to the baseline:

```text
$ git diff --exit-code hermes-port-phase4a -- src/lib/auth/tenantAccess.test.ts src/lib/auth/stagesnapSso.test.ts
# no output; exit 0
```

The phase-4a baseline stat contains only the already-authorized phase-5a implementation set (the final post-audit stat is captured below):

```text
$ git diff hermes-port-phase4a --name-only
.env.example
feature-research/hermes-port/audit-phase5a.md
src/app/api/tenant/agent/route.ts
src/app/api/tenant/cron/route.ts
src/app/api/tenant/sessions/route.ts
src/lib/api-auth.ts
src/lib/auth.ts
src/lib/backend/index.ts
src/lib/instances.ts
src/lib/tenantBinding.test.ts
src/proxy.ts
```

Relative to this fix pass's starting HEAD `c41e902`, only the seven allowed code/test files were changed before this append; this audit is the eighth allowed file:

```text
$ git diff c41e902 --name-only
src/app/api/tenant/agent/route.ts
src/app/api/tenant/cron/route.ts
src/app/api/tenant/sessions/route.ts
src/lib/api-auth.ts
src/lib/backend/index.ts
src/lib/instances.ts
src/lib/tenantBinding.test.ts
```

`git diff --check` produced no output and exited 0.

### Anti-vacuity demonstrations

#### A. G1 embedded-path redaction: old `startsWith('/')` handling FAILS

The final string branch was temporarily replaced with the old behavior:

```ts
if (typeof value === 'string' && value.startsWith('/')) return undefined;
```

Real failing output:

```text
$ node --import tsx --test --test-concurrency=1 --test-name-pattern='sanitizeForTenant redacts embedded, exact, nested, and array paths but preserves URLs' src/lib/tenantBinding.test.ts
✖ sanitizeForTenant redacts embedded, exact, nested, and array paths but preserves URLs (34.858625ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 290.777208

✖ failing tests:

✖ sanitizeForTenant redacts embedded, exact, nested, and array paths but preserves URLs (34.858625ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected

  + 'failed reading /Users/x/.hermes/profiles/stagesnap:bbb/state.db'
  - 'failed reading [path]'

      at TestContext.<anonymous> (/Users/alexfinley/Documents/GitHub/marketing-dashboard/src/lib/tenantBinding.test.ts:232:10)
```

The final redaction branch was restored. Real passing output:

```text
$ node --import tsx --test --test-concurrency=1 --test-name-pattern='sanitizeForTenant redacts embedded, exact, nested, and array paths but preserves URLs' src/lib/tenantBinding.test.ts
✔ sanitizeForTenant redacts embedded, exact, nested, and array paths but preserves URLs (29.48775ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 271.574208
```

#### B. G2 file/symlink rejection: `existsSync(homeDir)` only FAILS

`getTenantInstance()` and its import were temporarily restored to the old `existsSync(instance.homeDir)`-only implementation. Real failing output:

```text
$ node --import tsx --test --test-concurrency=1 --test-name-pattern='regular-file and symlink tenant homes fail closed' src/lib/tenantBinding.test.ts
tenant route error Error: ENOTDIR: not a directory, open '/var/folders/x2/v8x0jjr95r581mt7259wlsc00000gn/T/hermes-tenant-binding-jtS6CJ/regular-file-home/state/gateway.heartbeat'
    at async readJson (/Users/alexfinley/Documents/GitHub/marketing-dashboard/src/lib/backend/hermesAgent.ts:272:23)
    at async HermesAgentBackend.listAgents (/Users/alexfinley/Documents/GitHub/marketing-dashboard/src/lib/backend/hermesAgent.ts:685:42)
    at async GET (/Users/alexfinley/Documents/GitHub/marketing-dashboard/src/app/api/tenant/agent/route.ts:10:20)
    at async TestContext.<anonymous> (/Users/alexfinley/Documents/GitHub/marketing-dashboard/src/lib/tenantBinding.test.ts:217:22)
✖ regular-file and symlink tenant homes fail closed (57.309291ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 258.601625

✖ failing tests:

✖ regular-file and symlink tenant homes fail closed (57.309291ms)
  AssertionError [ERR_ASSERTION]: regular-file

  500 !== 403

      at TestContext.<anonymous> (/Users/alexfinley/Documents/GitHub/marketing-dashboard/src/lib/tenantBinding.test.ts:218:12)
```

The strict `lstatSync`/`statSync`/kind implementation was restored. Real passing output:

```text
$ node --import tsx --test --test-concurrency=1 --test-name-pattern='regular-file and symlink tenant homes fail closed' src/lib/tenantBinding.test.ts
✔ regular-file and symlink tenant homes fail closed (101.492209ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 316.48725
```

### Standing requirement for future `/api/tenant/` handlers

`src/proxy.ts` was not modified in this fix pass. Its broad `TENANT_ALLOWED_PREFIXES` entry means future handlers beneath this prefix are reachable by tenant sessions by construction. The required standing rule is:

Every future handler added under `/api/tenant/` MUST resolve access through `resolveTenantBackend()` before returning any data, or `TENANT_ALLOWED_PREFIXES` in `src/proxy.ts` must be narrowed to name routes individually instead of by prefix.

### Deviations

Implementation: no deviations. All code/test changes are within the explicit hard boundary, and the audit change is append-only. No commit, push, reset, formatter, codemod, production access, external network call, or `src/proxy.ts` change was performed.

Verification: the unmodified golden command remains blocked by the pre-existing phase-4a invalid test-helper export in out-of-scope `src/app/api/auth/sso/route.ts`. Both required byte comparisons passed with the already-documented temporary compile-only `/tmp` shim. The first in-sandbox golden attempt also received `listen EPERM` for `127.0.0.1`; the harness was rerun with permission to bind only its local loopback test server. These are verification-environment deviations only; no repository or production state was changed.

### Final post-audit verification capture

The golden compile left generated `.next/types` that repeated the same out-of-scope SSO route-export error on a subsequent `tsc` invocation. The generated `.next` directory was moved intact to `/tmp/marketing-dashboard-phase5a-next-20260802` (recoverable; no tracked file change). The required final source typecheck then passed:

```text
$ pnpm typecheck
> hermes-dashboard@0.2.0 typecheck /Users/alexfinley/Documents/GitHub/marketing-dashboard
> tsc --noEmit
```

Final full-test result after the implementation and audit append:

```text
$ pnpm test | tail -n 12
✔ path-traversal subject creates only an exact unconfigured binding and cannot escape (26.549459ms)
✔ writebackLeadCreate creates leads.json when missing and upserts by id (1.062458ms)
✔ writebackLeadUpdate updates an existing lead (0.4415ms)
✔ writebackLeadDelete removes an existing lead (0.513666ms)
ℹ tests 124
ℹ suites 0
ℹ pass 124
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3609.771
```

Final hard-boundary capture relative to the requested starting HEAD, before this final explanatory append (the file set is unchanged by appending these lines):

```text
$ git diff c41e902 --stat
 feature-research/hermes-port/audit-phase5a.md | 336 ++++++++++++++++++++++++++
 src/app/api/tenant/agent/route.ts             |   4 +-
 src/app/api/tenant/cron/route.ts              |   4 +-
 src/app/api/tenant/sessions/route.ts          |   4 +-
 src/lib/api-auth.ts                           |  40 ++-
 src/lib/backend/index.ts                      |   3 +-
 src/lib/instances.ts                          |  12 +-
 src/lib/tenantBinding.test.ts                 | 154 +++++++++++-
 8 files changed, 534 insertions(+), 23 deletions(-)

$ git diff c41e902 --name-only
feature-research/hermes-port/audit-phase5a.md
src/app/api/tenant/agent/route.ts
src/app/api/tenant/cron/route.ts
src/app/api/tenant/sessions/route.ts
src/lib/api-auth.ts
src/lib/backend/index.ts
src/lib/instances.ts
src/lib/tenantBinding.test.ts

$ git diff --check
# no output; exit 0
```

Final `git diff hermes-port-phase4a --stat` also listed only the original phase-5a implementation set plus this audit, and the explicit phase-4a test-file diff again exited 0 with no output. No state-changing git command was run.
