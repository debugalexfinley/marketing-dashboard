# Spec: Phase 5b-1 — filesystem-backed tenant discovery

## Goal
Provisioning a realtor becomes "create their profile directory" — no env edit, no
container restart, no downtime for existing tenants. The dashboard discovers
tenant instances by scanning a configured tenants root, where each valid
subdirectory is one tenant. Env-configured instances keep working unchanged for
internal/default use.

Branch `hermes-port-phase5b1` off `hermes-port-phase5a` (51509bb).

## Why (the constraint this removes)
Today instances come only from `HERMES_OPENCLAW_INSTANCES`. Adding a tenant means
editing the env file and recreating the container — a restart for every signup,
affecting all tenants. Verified live: the QA tenant required exactly that.

## Files touched
- src/lib/instances.ts
- src/lib/instances.test.ts (new or extend if one exists)
- .env.example
HARD BOUNDARY: nothing else. The binding/resolution logic in
`src/lib/backend/index.ts` must NOT change — discovery only adds a source of
instances; `getTenantInstance` keeps validating exactly as it does now.

## Behavior
New env: `HERMES_TENANTS_ROOT` (e.g. `/app/tenants`). Unset ⇒ feature off,
behavior identical to today.

`getInstances()` returns env-configured instances PLUS discovered ones:
- Scan only the immediate children of `HERMES_TENANTS_ROOT` (never recurse).
- A child qualifies as a tenant instance ONLY if ALL hold:
  1. name matches `^[A-Za-z0-9_.-]{1,128}$` — same charset the SSO `sub`
     validation allows, minus `:` (the id gets the `stagesnap:` prefix, the
     directory name does not). Rejects dotfiles, traversal, spaces, unicode.
  2. `lstat` says it is NOT a symlink; `stat` says it IS a directory.
  3. it contains a readable `config.yaml` — proof it is a real Hermes home and
     not a half-created or unrelated directory.
- Resulting instance: `{ id: 'stagesnap:<name>', label: '<name>', kind: 'hermes',
  homeDir: join(root, name) }`.
- **Env-configured instances win on id collision** (an operator override must
  always be able to beat discovery). Log a single warning naming the id.
- Cache the scan for 30s (configurable via `HERMES_TENANTS_SCAN_TTL_MS`) so a
  request storm doesn't readdir every time. Cache keyed on root path; expire by
  time only — do NOT watch the filesystem (fs watchers on a shared volume are a
  reliability hazard).
- Any error reading the root (missing, permissions) ⇒ zero discovered instances,
  never an exception. Missing root is the normal state before the first tenant.

## Tests
Build fixture roots in a temp dir. Assert:
1. A valid tenant dir with config.yaml is discovered with the right id/homeDir/kind.
2. Dir without config.yaml → NOT discovered.
3. Symlink to a valid tenant dir → NOT discovered.
4. A regular file at the root → NOT discovered.
5. Names rejected: `.hidden`, `..`, `has space`, `has:colon`, `a/b`, a 200-char
   name, and a unicode homoglyph name.
6. Nested dirs (`root/a/b`) do not produce an instance for `b`.
7. `HERMES_TENANTS_ROOT` unset → discovery contributes nothing; existing
   env-instance behavior byte-identical.
8. Missing/unreadable root → empty result, no throw.
9. Env instance with the same id as a discovered one wins.
10. Cache: two calls within the TTL perform one scan (spy on fs), and a call
    after TTL rescans and picks up a newly created tenant WITHOUT a restart —
    this is the whole point of the phase, assert it explicitly.
11. Isolation regression: a discovered tenant still passes through
    `getTenantInstance`'s existing validation, and phase-5a's adversarial tests
    all still pass unchanged.

## Acceptance checks
1. `pnpm typecheck` clean; `pnpm test` all pass (124 existing + new).
2. **`pnpm build` succeeds** — added to acceptance checks after a route-export
   bug reached deploy in an earlier phase.
3. Anti-vacuity, shown failing-then-passing with output: remove the `config.yaml`
   requirement → test 2 fails; remove the symlink check → test 3 fails.
4. Both golden baselines still pass; phase-4a and phase-5a test files diff to zero.
5. `git diff hermes-port-phase5a --stat` shows only the files listed above.

## Constraints
No pushes. Checkpoint commit on green. No new dependencies. Do not change the
tenant binding, the resolution rule, or any route.

## Output contract
`feature-research/hermes-port/audit-phase5b1.md`: the discovery rules as a table,
all acceptance outputs, both anti-vacuity demos, and the exact filesystem layout
a provisioning script must create for a tenant to be discovered (this becomes the
contract for phase 5b-2's scripts).
