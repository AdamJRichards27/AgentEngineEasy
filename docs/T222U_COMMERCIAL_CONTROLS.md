# Owner t222u — trial expiry, Run screen protection, calling metering (31 Oct 2026)

## Trial expiry on the recorded end date
* The normalized billing snapshot carries an optional `trialEnd` (Stripe `trial_end`). `applySubscriptionSnapshot` stores it in the existing `billing_subscriptions.trial_ends_at` column (no migration). A snapshot that omits it keeps the stored value (fail closed).
* While a subscription is **Trialing**, every subscription grant gets `endsAt = trialEndsAt`. The entitlement resolver already refuses a grant past `endsAt` (`grantIsCurrentlyActive`), so access stops at the recorded end **at entitlement-check time**, with no webhook, scheduler or sweep (≤30 s resolver cache). `explainEntitlementDecision` reports `ENTITLEMENT_EXPIRED`.
* Conversion to **Active** clears `endsAt`; Cancelled/Ended revokes as before.
* Existing Trialing rows synced before this change carry no grant `endsAt` until their next provider sync; the Run-includes-Grow backfill already skips lapsed trials. No scheduler was added (none needed).

## Run screen and API protection (server side, at a7b2b0ef + #281)

| Run surface (web) | API | Server gate today | Status |
|---|---|---|---|
| Transactions / property workspace actions | `/api/transactions/*` (17) | `run.access` every route | Protected |
| Offers | `/api/offers/*` (7) | `run.access` (6); `GET /public/:shareToken` is a token-scoped public link | Protected |
| Pit Crew `/pit-crew` | Pit Crew routes (22) | role + `run.access` every route | Protected |
| Financial `/financial` | financial routes (31) | admin role + `run.access` every route | Protected |
| Launch | launch routes (23) | `run.access` every route | Protected |
| Documents / e-sign | `/api/documents/*` (12) | `run.access` (10); webhook signed, signed-download token-scoped | Protected |
| AML | `/api/aml/*` (6) | `run.access` (5); webhook signed | Protected |
| Exceptions `/exceptions` | exceptions routes (11) | `run.access` inside handler for transaction/property-linked items; ops health/scan admin role only | Protected (records) |
| Tasks / attention items | `/api/tasks/*` (3) | `run.access` for Run-linked tasks and sign-offs | Protected (Run-linked) |
| Run home `/` | `GET /api/home/summary` | auth only | **Gap — fixed by #243** |
| Command centre | `GET /api/command-centre` | auth only | **Gap — fixed by #243** |
| Property workspace `/properties/:id` | `GET /properties/:id/workspace`, `/address-search`, `POST /:id/ownership-review`, `/:id/listing-details` | auth only (2 of 10 property routes gated) | **Gap — fixed by #243** |
| Properties list / create | `GET/POST /api/properties`, `GET /:id`, `/:id/timeline` | auth only | Grow-shared by Owner decision (properties support Grow); Run-only fields stripped by #244 |
| Service orders / payments | `/api/payments/*` (8) | auth; refund admin role | **Gap — not in #243** (Pit Crew service-order charges have no `run.access`) |
| Property parties | `/api/parties/*` (3) | auth only | **Gap / decision** (Run property-party links; may be Grow-shared) |
| Legacy property appraisals | `/api/appraisals/by-property/*` (4) | auth only | **Gap / decision** (Grow appraisals live at `/api/grow/appraisals`; Grow→Run handoff already needs `run.access`) |
| Property communications threads | `/api/properties/:id/communications/*` | auth (grow.* on Grow contact paths) | **Gap / decision** |
| Automation ops | `/api/automation/ops/*` (9) | admin role | Admin surface, not entitlement-gated |

All of the above remain brokerage-scoped (404 for another brokerage's records).

## Calling usage metering and limits
* `lib/telephony/callUsage.ts`. **No new table, no migration**: usage is derived per brokerage for the current calendar month (UTC) from existing rows — calls (`grow_call_sessions`), minutes (sum of `duration_seconds`, each call rounded up), recordings (`documents` type `CallRecording`), transcriptions (`grow_call_transcriptions`).
* Limits: `AE_CALL_USAGE_LIMITS` JSON, e.g. `{"calls":500,"minutes":2000,"recordings":200,"transcriptions":200}`. Unset/invalid/≤0 = **unlimited** — the default for every metric. No allowance, no charge.
* Enforcement when configured: `createCallSession` refuses a new call at the calls or minutes limit (409); at the recordings limit the call proceeds unrecorded (recording stays non-blocking); `initiateCallTranscription` refuses with `USAGE_LIMIT_REACHED` (409).
* Not yet: a usage read API/UI, per-plan limits (needs the approved commercial schedule), and a period aligned to each subscription's billing period.
