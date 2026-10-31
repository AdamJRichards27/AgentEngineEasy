# Retired $69 Starter — historical subscription report and billing-migration review (Owner t222u)

**Read-only. No existing subscription, price or customer billing is changed by this PR.**

## What changed for NEW subscriptions
* Catalogue: Grow **$139/mo**; Run **$289/mo total including every Grow feature** (the `agent_engine_pro_grow_bundle` product). Seed amounts apply only where no Active price row exists (`ensurePrice` is insert-only); an already-seeded DB keeps its rows and logs `catalogue_seed_price_differs` at boot. Changing a live price row is a separate approved billing change.
* `GET /api/billing/catalogue` lists only offered products (Grow, Run). `POST /api/billing/checkout` refuses `agent_engine_starter` with **410 PRODUCT_NOT_OFFERED**.
* The Starter product, its $69 price and its entitlement mapping are kept, so existing Starter subscriptions keep syncing through the webhook unchanged (test: "an EXISTING Starter subscription is not altered").

## Historical Starter subscriptions — synthetic/dev data (throwaway DB, `harness/impact.sh` §3)

| subscription | brokerage | status | item | price | period end | active grants |
|---|---|---|---|---|---|---|
| 5 | Synthetic Starter Active | Active | Active | 6900 | 2026-11-30 | 19 (run.access + 18 grow.*) |
| 6 | Synthetic Starter PastDue | PastDue | Cancelled | 6900 | 2026-11-30 | 0 |
| 7 | Synthetic Starter Cancelled | Cancelled | Cancelled | 6900 | 2026-10-31 | 0 |

Report query (read-only, safe on any environment with approval to read): see `harness/impact.sh` §3. Real staging/production data has **not** been queried.

## How a billing migration would be reviewed (not started)
1. Read-only report per environment (query above) → subscriber list, status, period end, provider subscription id.
2. Owner decides the commercial treatment per cohort (Active, PastDue, cancel-at-period-end): grandfather at $69, move to Run $289 at renewal with notice, or offer Grow $139.
3. Customer notice period and wording approved (Australian Consumer Law price-change notice).
4. Provider-side change (Stripe price swap at period end, `proration_behavior=none`) rehearsed in Stripe test mode; our side only follows the webhook (`applySubscriptionSnapshot`), no direct DB edit.
5. Per-subscription dry-run list → Owner approval → execution in small batches with reconciliation against provider invoices; rollback = swap the price back before the period renews.
