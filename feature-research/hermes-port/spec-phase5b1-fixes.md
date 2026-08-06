# Spec: Phase 5b-1 fixes — discovery ordering, alias defenses, documented policy

Findings from the blind security review of `hermes-port-phase5a..hermes-port-phase5b1`.
Work in the worktree `/Users/alexfinley/Documents/GitHub/marketing-dashboard-phase5b1`
on branch `hermes-port-phase5b1` (head 0ac9bcc).

Verified by the orchestrator before speccing: name validation is genuinely tight
(unicode, homoglyphs, traversal, dotfiles, nesting all rejected) and there is no
name-only path that serves one tenant's home under another's id. The issues below
are ordering, alias handling, and stated policy.

## Files touched
- src/lib/instances.ts
- src/lib/instances.test.ts
- .env.example (documentation only)
HARD BOUNDARY: nothing else.

## F1 — BLOCKER (real today): configured instances must come FIRST
`src/lib/instances.ts:189-192` returns `[...discovered, ...configured]`, and
`getInstance(undefined)` falls back to `instances[0]` (line 211). So the default
instance for any internal caller that resolves without an explicit id becomes
whichever tenant directory `readdir` happened to return first — an admin session
attaching to a customer's Hermes home.

Fix: return `[...configured, ...discovered.filter(not colliding)]`.
Tests: with one configured instance and two discovered tenants, `getInstance()`
with no id returns the CONFIGURED one; and it stays configured regardless of
discovered names sorting before it alphabetically (use names like `aaa`, `aab`
that would sort ahead). Add this to the anti-vacuity set: swap the order back →
the test must fail.

## F2 — MAJOR: `config.yaml` must be a non-symlink regular file
`statSync(configPath)` follows symlinks, so a directory whose `config.yaml` is a
symlink to another tenant's config qualifies, and the config read then pulls the
linked file's contents. Fix: `lstatSync(configPath)` and require
`isFile()` (rejects symlinks) before the `accessSync(R_OK)` check. Also require
size > 0 — an empty file is not a Hermes home and only lets half-provisioned
directories go live.
Tests: `config.yaml` as a symlink to a valid config → NOT discovered; empty
`config.yaml` → NOT discovered; normal file → discovered.

## F3 — MAJOR: detect aliased homes (bind mounts / duplicate targets)
`lstat` cannot see a bind mount, so two names can serve the same underlying tree,
or one tenant's name can serve another's data, if someone with mount privileges
manipulates the root.

Fix (cheap, catches the whole class): while scanning, record each accepted home's
`(dev, ino)` from its `stat`. If two discovered homes resolve to the SAME
`(dev, ino)`, discard BOTH and emit one warning naming the ids — an ambiguous
identity must never resolve rather than resolving arbitrarily. Also skip any
discovered home whose `(dev, ino)` matches a configured instance's `homeDir`.
Tests: two directories hardlinked/bind-mounted to the same target (simulate with
a test double or by pointing two entries at one path via the injected fs layer if
one exists — if the test harness cannot create a real alias, assert the dedupe
logic directly with a stubbed stat) → neither is discovered, warning emitted.

## F4 — Document the trust boundary and the case policy (docs + one test)
Both are policy, not code, but must be written down where an operator will see it.
- `.env.example`: state that `HERMES_TENANTS_ROOT` is a **privileged directory** —
  only the provisioning process may create entries; it must not be world-writable,
  shared with untrusted workloads, or mountable by tenant code. Anyone who can
  create a directory there can define a tenant.
- Case policy: tenant identity is **case-sensitive and exact** (`stagesnap:Bob` ≠
  `stagesnap:bob`), matching the Convex `sub`. Note the macOS/APFS caveat: on a
  case-insensitive volume two casings collapse to one directory, so a dev machine
  cannot host both — provisioning should therefore normalize nothing and simply
  reject a name that already exists in any casing.
- Test: pin the case-exact behavior so a future "helpful" case-fold breaks CI.

## F5 — MINOR: cache must not hand out mutable shared references
The cache stores the live `HermesInstance[]`; callers get the same object
references for the TTL. Return shallow copies of the instance objects from
`getInstances()` so a future mutation by any caller cannot poison every other
caller for 30 seconds.

## Acceptance checks
1. `pnpm typecheck` clean; `pnpm test` all pass (136 existing + new).
2. `pnpm build` succeeds.
3. Anti-vacuity, shown failing-then-passing with pasted output: (a) revert the F1
   ordering; (b) revert F2's lstat to stat and point config.yaml at a symlink.
4. Both golden baselines pass; phase-4a and phase-5a test files diff to zero.
5. `git diff hermes-port-phase5a --stat` shows only the three files above.

## Output contract
Append "Security fix pass" to audit-phase5b1.md: the corrected ordering rule, the
alias-detection approach and what it cannot catch, the documented trust boundary
and case policy verbatim, all acceptance outputs, and both anti-vacuity demos.
