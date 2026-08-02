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
