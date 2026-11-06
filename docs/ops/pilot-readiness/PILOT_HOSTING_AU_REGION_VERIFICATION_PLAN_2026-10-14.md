# Pilot hosting plan: dedicated Repl, Reserved VM, Australia region (14 Oct 2026). PLAN ONLY
Nothing has been created, published or configured. Every step marked **[OWNER]** needs approval at the time; **[ENG]** steps are for engineering after approval.
- **Sources:**
  - [V] docs.replit.com publishing-geography / project-geography / security/geography (fetched 14 Oct): Australia is a publishing geography (Core/Pro/Enterprise), with compute, DB and Object Storage colocated. The choice is **permanent**. Australia is "rolling out gradually; may not be visible; contact support". **Dev environments run in North America.**
  - `D4_PILOT_HOST_PLAN_FINAL_2026-10-10.md`.

## 0. Preconditions
OA-1 answered; PH-1–PH-4 approved; legal #1/#2 approved before a production boot (PH-8). Until legal is approved, steps 1–5 can be done but publishing will fail closed, which is correct.

## 1. AU region check (before anything is created) [OWNER, ~5 min, no cost]
1. Replit → Account → plan is **Core** or higher (geography selection needs it).
2. In any scratch Repl, open **Publish → geography dropdown** and confirm **Australia** is listed. Cancel without publishing.
3. If Australia is missing, contact Replit support asking for the Australia publishing geography for this account. **Stop.** Do not publish to another region (the choice is permanent).
4. Record the evidence: a screenshot of the dropdown + date, in the CC (ChatGPT) and `docs/legal` facts for #2/#5.
5. Ask in the same support ticket, or confirm in the docs [UNVERIFIED today], whether Reserved VM is offered in the Australia geography.

## 2. Dedicated pilot Repl [OWNER creates; ENG verifies]
1. **New** Repl → Import from GitHub `AdamJRichards27/AgentEngineEasy`, branch `staging`. **Not** the dev Repl 7403a19e and not a fork of it (that would carry the Replit-only files and dev Secrets).
2. Check out the **pinned commit** `S_pilot` = the staging SHA with green post-merge CI at provisioning time (today **94e6d485**, CI 38454898873), detached: `git checkout --detach <S_pilot>`, then `git rev-parse HEAD` must equal `S_pilot`, and porcelain must be 0.
3. No local edits on the pilot Repl, ever. Changes arrive only as a new pinned SHA.
4. Prerequisite PRs merged into staging **before** `S_pilot` is chosen, each with its own MERGE:
   - (a) `.replit` `deploymentTarget` → the Reserved VM value (confirm the string from the scratch Repl's `.replit` after selecting Reserved VM; `"gce"` per community sources only [UNVERIFIED]);
   - (b) nix packages for `postgresql` (pg_dump/pg_restore/psql) and `awscli2` for the PH-7 scheduler;
   - (c) the `scripts/ph67/*` files (if adopted).

## 3. Pilot database: fresh, 0000 → 0036 [OWNER approves PH-9; ENG runs]
1. In the pilot Repl: Database → create a **production** database in the Australia geography (it is colocated when published; confirm in the UI).
2. Preflight (read-only): `pnpm --filter @aee/db run db:preflight` [V script exists] shows an empty DB with 0 migrations.
3. `ALTER DATABASE <db> SET timezone TO 'UTC'` (required by `assertDatabaseSessionTimezoneUtc`).
4. `pnpm --filter @aee/db run db:migrate`, then verify: `drizzle.__drizzle_migrations` = **37 rows**; the last tag is `0036_e9_tenant_brokerage_id`; the 0035 file sha is `ededd89f…49db6`; the owner tables exist with **0 owners** (bootstrap refuses in production/deployment).
5. Under the PH-2 decision of 14 Oct, the old 0035 skip hazard (PH-13) does not apply to a fresh DB that migrates in journal order.

## 4. Secrets
Per `PILOT_SECRETS_NAMES_ONLY_2026-10-14.md`. **PROPERTY_DATA_PROVIDER and GOOGLE_PLACES_API_KEY unset.** Then run the names-only presence check.

## 5. Publish [OWNER: production activation, separately approved]
Publish → **Reserved VM, dedicated 1 vCPU / 4 GiB**, geography **Australia**, a single instance.

**Post-publish evidence:**
- `/api/health/ready` 200;
- deployment logs show `api_listening` once and no second process;
- external probe green 24 h;
- boot log shows the legal gate passed (artifact SHA match);
- no `GooglePlacesProvider`.

## 6. Rollback
| Situation | Rollback |
|---|---|
| Region missing or wrong before publish | Nothing created yet. Stop, then raise a support ticket |
| Published to the wrong region | **Cannot migrate** (permanent). Unpublish/delete that deployment **[OWNER]** and create a new Repl + publish in AU. Data is synthetic only, so nothing needs migrating |
| Bad `S_pilot` (boot fails / readiness 503) | Redeploy the previous good pinned SHA (code-only); DB unchanged |
| Migration failure on the fresh DB | Drop and recreate the empty pilot DB (no data yet), fix forward via a staging PR, re-pin |
| Data problem after use | Restore from the PH-7 offsite artifact into a new DB (see the PH6/PH7 runbook), then repoint `DATABASE_URL` [OWNER] |
| Abandon the pilot | PH-T teardown: unpublish, delete the DB after a final offsite backup, rotate/delete every secret, retain backups per legal #8 |

## 7. Cost
≈ US$175 ≈ **A$251/mo** (`OWNER_DECISIONS_OA1_PH1-4_2026-10-14.md`) + PH-6/7 ≈ A$20–30/mo. Whether pricing differs for the Australia geography is [UNVERIFIED]; check the Publish screen estimate during step 1.
