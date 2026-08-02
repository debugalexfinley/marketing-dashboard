# Spec addendum: Phase 2 fix pass — second-reviewer (Grok) findings

Applies to branch `hermes-port-phase2`, AFTER/alongside spec-phase2-fixes.md.
These are additional confirmed findings from the independent second review; none
overlap with B1/B2/B3 except where noted. Same files-touched boundary as
spec-phase2-fixes.md (adapter, its tests, fixtures, stub CLI, audit).

## G1 — tailCronLog path traversal (major, live today)
hermesAgent.ts:~681 joins `jobId` into `cron/output/<jobId>` with no
normalization or containment check; `../../` escapes the directory. FIX: reuse
the same job-id normalization/validation the rest of the adapter uses (12-hex
per hermes-mapping.md) and assert the resolved path stays under
`<home>/cron/output`. Test with `../../` and absolute-path jobIds.

## G2 — cron↔session LIKE wildcard widening (major)
hermesAgent.ts:~601-606 uses `jobId` inside a SQL `LIKE` pattern; it is
parameterized (no injection) but `%`/`_` in a jobId widen the match. FIX:
escape LIKE metacharacters (or validate jobId as 12-hex before use — preferred,
pairs with G1). Test a jobId containing `%`.

## G3 — cron session timestamp parsed in the wrong timezone (major, correctness)
hermesAgent.ts:~316-328 parses the `YYYYMMDD_HHMMSS` suffix of
`cron_<jobid>_<ts>` session ids with `Date.UTC`, but Hermes writes that suffix
in LOCAL wall time (America/Chicago on this machine — ~5-6h offset). Cost
enrichment can therefore pick the wrong session. FIX: parse as local time
(and combine with N1's ±10-minute bound from the main fix spec, which becomes
meaningless if the parse is 5 hours off). Test with a multi-run fixture where
the correct match is only correct under local-time parsing.

## G4 — fixture/stub vs LIVE format mismatch: `jobs.json.updated_at` (major)
Fixture generator and stub CLI write `updated_at` as a NUMERIC ms epoch; real
Hermes writes an ISO 8601 STRING (verify against
/Users/alexfinley/.hermes/cron/jobs.json, read-only). Tests can pass while live
data breaks — and the stub's `Number(isoString)` → NaN would corrupt a
live-shaped file. FIX: fixtures + stub emit the LIVE format (ISO string); the
adapter must accept BOTH (tolerate number, prefer string) and never write NaN.
Test both shapes.

## G5 — stub CLI fidelity (blocks B1 testing)
- Stub does not strip the documented `-p <profile>` flag (only `--home`) — a
  `-p`-using adapter (which B1 requires per hermes-mapping.md) hits "unhandled
  stub subcommand". FIX the stub to accept `-p`/`--profile`.
- Unsafe home resolution fallback `HERMES_HOME || --home || process.cwd()` has
  been observed writing a `cron/` tree into the caller's cwd. FIX: require an
  explicit fixture home and REFUSE to run (exit non-zero) if the resolved home
  is not under the fixture temp root — a hard guard against ever touching a real
  Hermes home.
- `-z`/usage-file stub always reports success. FIX: add a triggerable failure
  mode (e.g. a magic prompt substring) emitting `completed:false, failed:true`
  plus the optional `failure` key, so the adapter's failure parsing is testable.
- No `.jobs.lock` flock / atomic replace. FIX (lightweight): stub takes the same
  lock file and writes via temp+rename, so lock-related adapter regressions are
  at least observable.

## G6 — tests that cannot fail (major)
- hermesAgent.test.ts:~189 `typeof Date.parse(x) === 'number'` is true even for
  NaN. Assert `Number.isFinite(Date.parse(x))` and an expected value.
- hermesAgent.test.ts:~99-102 `gatewayRunning` compares a fixed fixture
  heartbeat against `Date.now()`, so it effectively always asserts false. Pin
  the threshold: generate heartbeats at (now-30s) and (now-300s) and assert
  true/false respectively.
- Replace `>= 0` / `typeof` shaped assertions with expected values from the
  deterministic fixture.

## G7 — golden gaps (major)
- `api-agents-workspace.json` baseline freezes a 404 for a nonexistent path —
  a permanent-404 regression would pass. FIX: point the captured request at a
  real fixture file so the golden proves a successful read (coordinate with B3:
  the file must be a NON-secret file under an allowed root).
- capture.mjs does not pin `TZ` though spec-phase2 requires determinism. FIX:
  set `TZ=America/Chicago` (and a fixed `LANG`) for the captured server process;
  re-generate baselines only if this changes output, and explain any diff.

## Non-blocking (note in audit, fix if cheap)
- SQLite opened `{readonly:true}` rather than the mapping doc's
  `file:...?mode=ro` URI — equivalent in practice; standardize for clarity.
- `toEpochMs(..., epochSeconds=true)` multiplies any finite number by 1000 —
  add a magnitude sanity check.
- `readJson` swallows corrupt-JSON and EACCES identically to missing-file —
  distinguish corrupt (loud) from missing (empty), consistent with the phase's
  "missing ⇒ empty, broken ⇒ loud" rule.

## Acceptance additions
Extend spec-phase2-fixes.md's checks with: G1/G2/G3 regression tests (each shown
failing before its fix), a test asserting BOTH `updated_at` shapes parse, the
stub-guard test (stub refuses a home outside the fixture root), and the
tightened assertions from G6 demonstrably failing when their subject is broken.
