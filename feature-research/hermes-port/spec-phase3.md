# Spec: Phase 3 — Alex's dashboard instance on the Mac Mini

## Goal
A running marketing-dashboard on Alex's Mac Mini, tailnet-only, reading his LIVE
Hermes home (`/Users/alexfinley/.hermes`) through the phase-2 HermesAgentBackend.
Reachable from his phone and MacBook over Tailscale, auto-restarting like the
other services on this box, invisible to the public internet. This is the first
real use of the port — and the reference deployment for the later tenant
containers.

Repo: `/Users/alexfinley/Documents/GitHub/marketing-dashboard`, branch
`hermes-port-phase2` (head has the complete adapter). Do NOT modify app source —
this phase is deployment only. If something needs a code change to work, STOP
and report (it means the adapter has a gap worth knowing about).

## Files touched
- `/Users/alexfinley/Library/LaunchAgents/com.marketingdashboard.serve.plist` (new)
- `/opt`-equivalent app data dir on the Mac: `~/Library/Application Support/marketing-dashboard/` (new, for the app's own SQLite)
- `feature-research/hermes-port/audit-phase3.md` (new, in repo)
- Homepage config on the droplet (`/opt/homepage/config/services.yaml` — append one tile)
Nothing else in the repo.

## Deployment shape
1. Build: `pnpm install --frozen-lockfile` (corepack pnpm@10.28.0) then
   `pnpm build` in the repo on the Mini. Node ≥22 via nvm (v24.13.0 present).
2. Run: the app's production server bound to the Mini's tailnet IP
   `100.101.23.37`, port **3003**. (In use on this box already: 5177 t3,
   9119 hermes dashboard — do not collide.)
3. Instance config: ONE instance, `kind: 'hermes'`, `homeDir:
   /Users/alexfinley/.hermes`. Read `src/lib/instances.ts` to get the exact
   env-var name and JSON shape phase 2 expects — do not guess it.
4. App's own state (its SQLite, sessions imported from Hermes) lives in
   `~/Library/Application Support/marketing-dashboard/` — NEVER inside
   `~/.hermes`. The Hermes home must stay untouched except for the adapter's
   reads and any cron mutations the user later makes through the UI.
5. Auth: generate a strong random `AUTH_PASS` + `API_KEY`. Host-lock configured
   to allow the tailnet host/IP only.
6. Write-permission flags: leave cron/policy/workspace writes DISABLED for this
   first deployment (read-only dashboard). Note in the audit how to enable.
7. LaunchAgent `com.marketingdashboard.serve`: RunAtLoad + KeepAlive,
   ThrottleInterval 10, logs to `~/Library/Logs/marketing-dashboard.log`, PATH
   including the nvm node dir, pinned node binary path (nvm upgrades break
   unpinned agents — this bit us with t3). Load with `launchctl bootstrap gui/501`.

## Acceptance checks
1. `curl -s -o /dev/null -w '%{http_code}' http://100.101.23.37:3003/` returns
   200 or a redirect to login, from THIS Mac.
2. Login with the generated credentials succeeds (verify with a scripted
   session-cookie login, not by hand).
3. The agents view returns Alex's real Hermes profile with model `grok-4.5`,
   and the cron view lists his real jobs (expect ~10, several with delivery
   errors surfaced). Verify via authenticated `curl` against the app's own
   `/api/*` routes and paste the JSON summaries (redact any content).
4. Sessions sync imports real sessions (expect ~126 available) — run the sync
   endpoint, then confirm the session list is non-empty and token totals are
   non-zero.
5. `launchctl kickstart -k gui/501/com.marketingdashboard.serve` → service comes
   back and check 1 passes again within 60s.
6. `~/.hermes` is unmodified: capture `find ~/.hermes -newer <timestamp-file>
   -not -path '*/logs/*'` before and after the whole run — no adapter-caused
   writes. (Hermes's own gateway writes are expected; distinguish them.)
7. Not publicly reachable: confirm the listener is bound to the tailnet IP, not
   0.0.0.0 (`lsof -nP -iTCP:3003 -sTCP:LISTEN`).
8. Homepage tile added under the existing "Apps" group pointing at
   `http://100.101.23.37:3003`, and Homepage still returns 200 afterward.

## Constraints
- Read-only toward `~/.hermes` for this phase (write flags off).
- No repo source changes. No pushes.
- Do not touch the t3 or hermes-dashboard LaunchAgents, or any droplet container
  other than appending the Homepage tile.
- Credentials: print them ONCE in your final report so they can be saved to the
  Passwords app; also write them to the plist/env only, never into the repo.

## Output contract
`feature-research/hermes-port/audit-phase3.md`: exact build/run commands, the
instance config used, all eight acceptance outputs, the generated credentials'
LOCATION (not the values), how to enable write flags later, and anything that
needed a workaround.
