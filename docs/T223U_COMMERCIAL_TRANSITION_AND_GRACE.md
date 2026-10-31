# Owner t223u (31 Oct 2026) — Grow $139 transition plan, calling metering, Starter grace policy

**PLAN ONLY. No live customer billing, price row, subscription or grant is changed by this PR.**

## 1. Approved catalogue (new subscriptions)
| Product | Code | Price | Includes |
|---|---|---|---|
| Grow | `grow` | **$139/month** | Grow |
| Run | `agent_engine_pro_grow_bundle` | **$289/month total** | Run + every Grow feature |
| Starter $69 | `agent_engine_starter` | not offered (410 at checkout) | legacy subscriptions keep syncing |

Seed amounts are insert-only (`ensurePrice`): an environment already seeded at Grow $99 keeps that price row until an approved provider-side price change.

## 2. Transition plan for existing subscribers billed $99 (Grow)
**Owner decision t225u (31 Oct 2026): move to $139 at the FIRST ELIGIBLE RENEWAL that falls at least 30 days after written notice, subject to contractual and legal checks.** No live billing has changed. Each execution step below still needs approval.
Effective date per subscriber = first `current_period_end` ≥ notice date + 30 days (if the contract requires a longer notice, the longer period applies and the next renewal after it is used).

1. **Inventory (read-only, per environment).** `billing_subscriptions` ⨝ items ⨝ prices where `product.code='grow' and price.amount_cents=9900`, listing brokerage, status, period end, provider subscription id. Staging and production have **not** been queried (no approval to read shared DBs).
2. **Treatment (decided t225u):** $139 from the first eligible renewal ≥30 days after notice. Exceptions only where a contract fixes the price for a term (then at the end of that term).
3. **Contract check.** Confirm the subscription terms allow a price change with notice; Australian Consumer Law: give clear advance notice and a right to cancel without penalty before the new price applies.
4. **Notice.** Approved wording, sent ≥30 days before the first $139 invoice; record the send per brokerage.
5. **Provider change, not DB edits.** In the payment provider (mock in all non-production environments) create the $139 price, schedule each subscription to switch at period end (`proration_behavior=none`). Our DB follows the provider webhook (`applySubscriptionSnapshot`); no direct writes.
6. **Dry run.** Per-subscription list of `{subscription, current price, new price, effective date}` attached to the approval request; rehearse in provider test mode.
7. **Execute in batches**, reconcile each batch against provider invoices.
8. **Rollback.** Before the effective date: cancel the scheduled price change in the provider. After: issue a credit for the difference and revert the price for the next period.
Entitlements do not change: a Grow subscriber keeps exactly the Grow keys throughout.

## 3. Calling: metered, no limits, no charges (t225u: caps removed)
* Usage is measured per brokerage per calendar month (calls, minutes, recordings, transcriptions) from existing rows (`lib/telephony/callUsage.ts`, no migration).
* **No limit is configured and none is introduced.** `AE_CALL_USAGE_LIMITS` is unset in every environment; unset/invalid = unlimited, so no call, recording or transcription is ever refused for usage. No charge is attached to usage.
* **t225u:** the dormant configuration-only caps (`AE_CALL_USAGE_LIMITS`) are **removed** from #281: call sessions and transcriptions no longer reference usage at all, and no configuration can introduce a cap. Caps return only as reviewed code with an approved commercial policy.

## 4. Seven-day grace policy — past-due Starter customer (ADOPTED t225u where contract and provider permit)
**Scope:** the single legacy Starter ($69) subscription in `PastDue` status (synthetic: "Synthetic Starter PastDue"; real environments not yet inventoried).

**Today:** a PastDue subscription's own grants are revoked (only Trialing/Active grant). That customer keeps Run solely through the blanket free `run.access` grant. Removing free Run without a grace period would cut them off immediately.

**Draft policy**
1. Grace starts on the later of (a) the Owner's approval date or (b) the date the customer is notified, and lasts **7 calendar days** (ends 23:59 Australia/Brisbane on day 7).
2. During grace: access unchanged (Run + Grow); in-app and email notice of the overdue amount, the grace end date, and the options (pay the overdue invoice, move to Grow $139 or Run $289, or cancel). No late fees.
3. Mechanism: no code change (nothing flag-gated exists to switch on). When the checks below pass, a time-bound `admin_override` grant set (`run.access` + Grow keys) with `endsAt` = grace end, audited, so expiry is automatic at entitlement-check time. It is listed in the protected-account list until it ends. No new code is needed.
4. If paid within grace: the provider webhook returns the subscription to Active and the override is left to expire.
5. If unpaid at grace end: the override expires; the brokerage keeps onboarding-only access (unsubscribed rule); data is retained, nothing is deleted.

**Checks required before the grace grant is applied (adoption is conditional on them)**
* **Contract:** the customer's Starter terms (suspension notice period, any contractual grace longer than 7 days, which would prevail).
* **Provider:** the provider's own dunning/retry schedule for this subscription (smart retries may already run beyond 7 days; avoid suspending while the provider is still collecting); confirm whether the provider will cancel the subscription automatically at the end of dunning.
* **Consumer law/notice:** written notice content and timing.
* **Data:** confirm in each real environment that exactly one PastDue Starter customer exists (read-only query in §2 step 1 adapted to `agent_engine_starter`).
