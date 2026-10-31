# Owner t223u (31 Oct 2026) — removing blanket free Run access: readiness pack

Approved **in principle**. **Not activated:** `AE_RUN_ACCESS_BOOT_BACKFILL` is not set to `false` anywhere and no grant has been removed. Builds on `T222U_FREE_RUN_ACCESS_REMOVAL_PLAN.md` (sources of free access, classification, inventory tool).

## 1. Environment-by-environment impact
| Environment | Measured? | Brokerages losing Run | Users | Notes |
|---|---|---:|---:|---|
| Local / throwaway (synthetic, 15 brokerages) | **Yes**, read-only inventory (`evidence-t222u/harness/impact.sh`) | 8 (4 unsubscribed, 3 Grow-only, 1 Starter PastDue) | 16 | Platform Owner and `QA ` tenant protected; grant count unchanged 159=159 |
| CI (GitHub Actions, ephemeral PG) | N/A | — | — | Every tenant is created by dev-login, which grants `run.access` (source 2). Unaffected unless dev-login is changed (Owner decision "dev-login switch"). |
| Staging (shared DB) | **Not measured** | ? | ? | Needs Owner approval to run the read-only inventory against staging. |
| Pilot / production | **Not measured** | ? | ? | Same; read-only inventory first, results attached to the approval request. |

Command (read-only; `--apply` is refused with exit 2):
`pnpm --filter api inventory:free-run-access --protect-prefix="QA " [--protect-ids=1,2]`

## 2. Protected-account list (kept on removal)
| Class | Rule | Source |
|---|---|---|
| Platform Owner tenants | brokerage has a `platform_owners` user | automatic |
| Test / QA / demo tenants | `--protect-ids` / `--protect-prefix` | **Owner to name** per environment (synthetic run used prefix `QA `) |
| Authorised trials | Trialing subscription with a recorded future trial end | automatic |
| Paid Run / bundle / Active Starter | holds a current subscription `run.access` | automatic (free grant is redundant) |
| Past-due Starter in grace | time-bound override grant (see `T223U_COMMERCIAL_TRANSITION_AND_GRACE.md` §4) | Owner approval of the grace policy |

## 3. Dry run (per environment, needs read approval only)
1. Run the inventory; save the JSON (brokerage ids, names, class, user counts, grant ids) with SHA-256.
2. Owner reviews `WOULD_LOSE_RUN_ACCESS` and confirms/extends the protected list.
3. Re-run with the agreed protections; the final JSON is the exact removal list. Grant count before = after (proves read-only).

## 4. Removal (later, separately approved, not built)
1. Deploy with `AE_RUN_ACCESS_BOOT_BACKFILL=false` (stops re-granting; revokes nothing).
2. Reviewed script flips only the listed `sourceType='migration'` grant ids to `Revoked`, `endsAt=now()`; never deletes; one audit row per grant; invalidates entitlement cache. Refuses any id not in the approved JSON.
3. Re-run the inventory: expect 0 `WOULD_LOSE_RUN_ACCESS`.

## 5. Rollback
* Fast: set the same grant ids back to `Active`, `endsAt=null` (ids from the approved JSON), invalidate cache. Access returns within the ≤30 s resolver cache.
* Full: unset `AE_RUN_ACCESS_BOOT_BACKFILL` and restart; the boot backfill re-grants `run.access` to any brokerage with no `run.access` row (note: a Revoked row counts as a row, so use the fast path for those).
* No data is deleted at any step, so rollback never needs a restore.

## 6. What Grow keeps and what is Run-only (server side)
| Surface | After removal | Server gate |
|---|---|---|
| Property parties (`/api/parties/*`) | **Grow keeps** (existing permissions, brokerage + #147 own-property scope) | auth only — unchanged by Owner decision |
| Historical appraisals (`/api/appraisals/by-property/*`, Grow appraisals) | **Grow keeps** | `run.access` or `grow.access` (#282) |
| Relevant communications (property/contact threads) | **Grow keeps** | existing `grow.*` checks |
| Agency agreements (terms, package, send, ready-to-list) | Run only | `run.access` + BA or the property's agent (#282) |
| Transaction administration | Run only | `run.access` every route (staging) |
| Service orders and payments (`/api/payments/*`) | Run only | `run.access` every route; charge needs BA or Agent, Pit Crew never executes (#282, t223u) |
| Financials | Run only | BA + `run.access` (staging; extended in #245) |
| Property workspace / home summary / command centre | Run only | #243 |
