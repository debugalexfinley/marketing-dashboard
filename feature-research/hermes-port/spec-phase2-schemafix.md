# Spec: Phase 2 schema-version detection fix

## Goal
`readSessions()` (and all state.db reads) work against real Hermes installs:
schema compatibility is detected from the `schema_version` TABLE (real installs:
value 23; `PRAGMA user_version` is always 0 and must not be used). The loud-fail
contract stays: an unseen schema version still raises the typed error.

## Files touched
- src/lib/backend/hermesAgent.ts        (schema detection ~L436)
- feature-research/hermes-port/fixtures/gen-hermes-home.mjs (fixture DBs create
  the schema_version table like real Hermes; drop any PRAGMA user_version use)
- src/lib/backend/hermesAgent.test.ts   (mismatch test updated to the table
  mechanism; add a test: missing schema_version table ⇒ typed loud error too)
- feature-research/hermes-port/golden/baseline-hermes/*  (ONLY if regeneration
  is needed; expected unchanged — if any file differs, stop and report)
HARD BOUNDARY: nothing else.

## Changes
Read `SELECT MAX(version) FROM schema_version` (inspect the real table layout at
/Users/alexfinley/.hermes/state.db READ-ONLY first — column names must come from
reality, not assumption; if it is a single-row/single-column table adjust
accordingly and note it). Accept a SUPPORTED_MAX constant set to the observed
live version (23); versions > SUPPORTED_MAX or an unreadable/missing table ⇒
existing typed loud error including the seen value. Fixture generator writes the
same table with version 23.

## Acceptance checks
1. `pnpm typecheck` clean; `pnpm test` all pass (updated + new tests; the new
   missing-table test must fail if the guard is deliberately disabled).
2. Hermes golden `--backend hermes --check` — byte-identical, run twice.
3. OpenClaw golden `--check` — untouched, still passes.
4. LIVE read-only smoke (same script/constraints as spec-phase2 check 6) now
   fully PASSES: readSessions returns ≥50 sessions from /Users/alexfinley/.hermes
   with token totals. Paste output. Strictly read-only, mode=ro, no CLI calls.

## Constraints & output
Phase constraints stand (no pushes; checkpoint commit on green). Append a
"Schema fix" section to audit-phase2.md with the real table layout observed and
all four check outputs.
