# Free `run.access` — inventory and SAFE REMOVAL PLAN (Owner t222u, 31 Oct 2026)

Status: **PLAN ONLY. Nothing is removed by this PR.** No shared, staging or production database has been read or written. Removal needs explicit Owner authorisation per environment.

## 1. Where free Run access comes from today

| # | Source | Code | `sourceType` | Who gets it |
|---|--------|------|--------------|-------------|
| 1 | Boot backfill, **every boot** | `lib/billing/runAccessBackfill.ts`, called from `index.ts` | `migration` | Every brokerage with **no** `run.access` grant row of any kind. Re-grants on the next boot, so any removal is undone unless this is switched off first. |
| 2 | Dev-login brokerage creation | `routes/auth.ts` `POST /auth/dev-login` | `migration` | Every brokerage created through dev-login (dev/test only: requires `ALLOW_DEV_AUTH`). |
| 3 | Platform Owner `POST /owner/brokerages`, `scripts/bootstrapAdmin.ts`, `scripts/bootstrapPlatformOwners.ts` | create the brokerage without a grant | — | Receive (1) on the next boot. |
| 4 | Seeds | none found (`rg '"run.access"'` over apps/packages/scripts) | — | — |

Paid Run (`sourceType = subscription`) is NOT free access: Run (Pro + Grow bundle, $289) and legacy Starter subscriptions grant `run.access` + every `grow.*` while Trialing/Active (#281).

## 2. What changed in this PR (no access removed)

* `AE_RUN_ACCESS_BOOT_BACKFILL=false` switches the boot backfill (source 1) off. Unset = today's behaviour. Switching it off revokes nothing; it only stops re-granting.
* `pnpm --filter api inventory:free-run-access` — **read-only** inventory (`lib/billing/freeRunAccessInventory.ts`). It has **no apply mode**; `--apply` exits 2.
* Dev-login (source 2) is **unchanged**. 21 API test files create tenants through dev-login and then exercise Run routes (transactions, Pit Crew, financial, launch, documents, AML); removing the grant would break those testing flows. Proposal: §5.

## 3. Classification (first match wins)

| Class | Rule | Effect of removal |
|-------|------|-------------------|
| `PROTECTED_PLATFORM_ADMIN` | a Platform Owner user belongs to the brokerage | kept |
| `PROTECTED_TEST_OR_ALLOWLIST` | `--protect-ids` / `--protect-prefix` (test, QA, demo tenants the Owner names) | kept |
| `PROTECTED_AUTHORISED_TRIAL` | Trialing subscription with a recorded trial end in the future | kept (trial governs) |
| `REDUNDANT_PAID_RUN` | also holds a current subscription `run.access` | none (paid grant remains) |
| `WOULD_LOSE_RUN_ACCESS` | none of the above | loses Run; any Grow subscription is unaffected |

## 4. Impact counts — throwaway DB, synthetic data only

Harness: `evidence-t222u/harness/impact.sh` (loopback PG16 created and deleted per run). 15 synthetic brokerages; the boot backfill then gave 10 of them a free grant (it skips any brokerage that already has a `run.access` row, so paid, trial, lapsed-trial and cancelled-Starter tenants got none).

| Class | Brokerages | Active users |
|-------|-----------:|-------------:|
| WOULD_LOSE_RUN_ACCESS | **8** (4 unsubscribed, 3 Grow-only subscribers, 1 Starter **PastDue**) | **16** |
| PROTECTED_TEST_OR_ALLOWLIST | 1 (`QA ` prefix) | 1 |
| PROTECTED_PLATFORM_ADMIN | 1 (`AgentEngineOwner`) | 1 |
| PROTECTED_AUTHORISED_TRIAL | 0 (trial tenants hold a subscription grant, so the backfill never gave them a free one) | — |
| REDUNDANT_PAID_RUN | 0 (same reason) | — |

Grant count before and after the inventory: 159 = 159 (read-only verified).

Decision needed: a **PastDue** Starter customer currently keeps Run only because of the free grant (subscription grants are revoked when not Trialing/Active). Removal would cut them off; confirm whether PastDue should get a grace period first.

## 5. Proposed removal sequence (each step needs Owner approval per environment)

1. Run the inventory against the target environment **read-only** and attach the JSON to the approval request (names, counts, users).
2. Owner confirms the protected list: Platform Owner tenants (automatic), named test/QA/demo tenants (`--protect-ids`/`--protect-prefix`), authorised trials (automatic), and any PastDue grace.
3. Deploy with `AE_RUN_ACCESS_BOOT_BACKFILL=false` so removed grants are not re-created.
4. Dev-login proposal: gate the dev-login `run.access` grant behind `AE_DEV_LOGIN_GRANTS_RUN_ACCESS` (default on in test/dev so the 21 suites keep passing; off on any shared environment). Not implemented here, pending approval.
5. Removal (separate reviewed script, not in this PR): flip only `WOULD_LOSE_RUN_ACCESS` grants to `Revoked` with `endsAt = now()`, never delete rows, audit each, invalidate the entitlement cache. Rollback = set the same grant ids back to `Active`.
6. Re-run the inventory: expect 0 `WOULD_LOSE_RUN_ACCESS`.
