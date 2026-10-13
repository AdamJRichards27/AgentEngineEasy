# Startup reliability remediation, dev Repl 7403a19e (14 Oct 2026). DRAFT
Diagnosis: `REPLIT_STARTUP_INCIDENT_DIAGNOSIS_2026-10-14.md`. Root cause: dev container recycles + no workflow autostart after a recycle (platform). Contributing cause: the `Dev` workflow `wait -n` + trap tears down both processes when either exits.

## Remediation set (smallest first)
| # | Action | Fixes | Change type | Approval |
|---|---|---|---|---|
| R1 | Pilot on a **Reserved VM** deployment (PH-1/PH-3) | Pilot uptime (structural) | New resources | Owner (PH-1/PH-3) |
| R2 | External probe on the dev readiness URL, every 5 min (UptimeRobot free tier is enough) → Owner email | Detects "recycled, not running" within ~5–10 min | Account only; no Repl change | Owner |
| R3 | Submit Replit support Ticket 2 (draft below) | Stop reasons; whether autostart or always-on dev exists | External send | Owner |
| R4 | Optional `.replit` Dev task hardening (diff below) | A crash of one child no longer kills both; each restarts with backoff | Repo PR + Replit sync | MERGE + sync approval |
| R5 | Operator procedure: after any alert, open the Repl and press **Run**, then confirm `/api/health/ready` | Recovery now | None | — |

## R4 proposed diff (NOT applied; a local docs branch carries this file only)
```diff
-args = "...; node -v && pnpm -v && { pnpm dev:api & api_pid=$!; pnpm --filter @aee/web exec vite --host 0.0.0.0 --port 5000 & web_pid=$!; trap 'kill \"$api_pid\" \"$web_pid\" 2>/dev/null || true' EXIT; wait -n \"$api_pid\" \"$web_pid\"; }"
+args = "...; node -v && pnpm -v && { (n=0; until pnpm dev:api; do n=$((n+1)); [ $n -ge 20 ] && exit 1; sleep $((n<6?n*5:30)); done) & api_pid=$!; (n=0; until pnpm --filter @aee/web exec vite --host 0.0.0.0 --port 5000; do n=$((n+1)); [ $n -ge 20 ] && exit 1; sleep $((n<6?n*5:30)); done) & web_pid=$!; trap 'kill \"$api_pid\" \"$web_pid\" 2>/dev/null || true' EXIT; wait \"$api_pid\" \"$web_pid\"; }"
```
- **Risks:** `tsx watch` already restarts on file change, so this only matters for a hard exit. The bounded retry (20) avoids a hot loop.
- **Does not** fix the no-autostart cause; only R1 does that, and only for the pilot.
