# Phase 10 — Billing and External-Action Locks

`docs/gate-evidence/PHASE10_BILLING_AND_EXTERNAL_ACTION_LOCKS.md`

**Owner instruction this document implements:** "AE Operational Readiness — Critical Blocker
Remediation," Phase 10: *"Billing and external-action locks — audit and implement fail-closed
checks for any live-marked integration lacking approved credentials/config; verify sandbox creds
can't produce real charges; label pilot-mode billing UI."* Owner decisions this phase operates
under: *"Commercial operation: free or manually invoiced only; no automated
subscription/direct-debit/PC success-fee/trust-money transaction authorised"* and *"External
services: test/sandbox modes only; no real AML/email/SMS/e-signature/payment/property-data action
authorised."*

## 0. Why this phase exists — the gap this closes

`docs/gate-evidence/PHASE6_FINANCIAL_AND_BILLING_AUDIT.md` (the original gate's financial/billing
audit) already found and documented, correctly, that every real provider adapter in this codebase
defaults to mock/sandbox and requires explicit environment configuration to activate, and its own
recommendation was: *"that configuration should stay unset for this pilot"* (§6, §Recommendation).
**That recommendation was a policy instruction to a human operator, not a code-enforced
control.** Nothing in the code, before this phase, would have stopped a real charge if an
operator set the right combination of environment variables — accidentally or otherwise (the
concrete scenario this remediation pass has repeatedly guarded against elsewhere: a credential
copied in from another deployment's Secrets by mistake, the same class of risk the Phase
2/4 authentication work and Phase 9's email fail-closed gate both treat as a real, foreseeable
failure mode, not a hypothetical one).

This phase converts that recommendation into an enforced, credential-independent lock, verifies
it actually works (not just that it reads correctly), and separately closes one related,
previously-flagged-but-not-fixed gap: the custody-boundary field for PC success-fee debits
(`authorisedPaymentMethod`) was free text with no validation (Phase 6 §16). Both are now real
code-level controls, not emergent properties of what has or hasn't been built or configured.

## 1. The lock mechanism

**New environment flag: `LIVE_EXTERNAL_TRANSACTIONS_APPROVED`.** Documented in `.env.example`,
left unset for every pilot deployment. Two equivalent implementations of the same two-line check
exist, for architectural reasons (packages under `packages/integrations/*` are separate workspace
packages that `apps/api` depends on, not the other way around, so they cannot import
`apps/api/src/lib/env.ts` and instead repeat the check locally, matching how each of those
packages already reads `process.env` directly for its own `PROVIDER` variable):

- `apps/api/src/lib/env.ts`: `isLiveExternalTransactionsApproved()` and
  `mustForceMockExternalProvider()` (`isProductionEnvironment() && !isLiveExternalTransactionsApproved()`),
  used by `apps/api/src/lib/billing/gateway.ts`.
- An identical, locally-defined `mustForceMockExternalProvider()` in each of
  `packages/integrations/payments/src/index.ts`, `packages/integrations/aml/src/index.ts`,
  `packages/integrations/esign/src/index.ts`, and `packages/integrations/property-data/src/index.ts`.

**The check runs BEFORE the existing credential check in every factory, not after or instead of
it.** A real credential being present is no longer sufficient on its own to reach a real
provider — in production, without the explicit approval flag, the factory returns its
mock/sandbox implementation regardless of what `STRIPE_SECRET_KEY`/`AML_PROVIDER_API_KEY`/etc.
are set to, and logs a structured warning naming exactly what was requested and why it was
denied (`billing_provider_locked_to_mock_pilot_policy`, `payment_provider_locked_to_mock_pilot_policy`,
`aml_provider_locked_to_mock_pilot_policy`, `esign_provider_locked_to_mock_pilot_policy`,
`property_data_provider_locked_to_mock_pilot_policy`).

**Outside production, the lock never applies** — `mustForceMockExternalProvider()` is
unconditionally `false` whenever `NODE_ENV !== "production"`. Local development and the existing
CI/test suite behave exactly as before this phase; nothing about today's dev/test workflow
changes.

## 2. Per-category findings

- **Grow subscription billing** (`apps/api/src/lib/billing/gateway.ts`, `BILLING_PROVIDER`):
  locked. Previously undocumented in `.env.example` despite the code reading it since the
  original build — added as part of this phase's audit.
- **ServiceOrder payments** (`packages/integrations/payments`, `PAYMENT_PROVIDER`): locked.
- **AML verification** (`packages/integrations/aml`, `AML_PROVIDER`): locked.
- **E-signature** (`packages/integrations/esign`, `ESIGN_PROVIDER`): locked.
- **Property data** (`packages/integrations/property-data`, `PROPERTY_DATA_PROVIDER`): locked.
  (Google Places carries no direct financial risk, but the Owner's instruction names
  property-data explicitly — locked for the same reason and by the same mechanism as the rest,
  for consistency and literal compliance.)
- **PC success-fee mandate debits** (`packages/integrations/mandate-payments`,
  `MANDATE_PAYMENT_PROVIDER`): **already safe, no lock needed.** `createMandatePaymentProvider()`
  has no live branch at all — `SandboxMandatePaymentProvider` is the only implementation that
  exists in this codebase (confirmed already by Phase 6 §6: *"there is no real provider
  implementation at all"*). A comment was added noting this Phase 10 finding, but no functional
  change was required or made.
- **SMS** (`apps/api/src/lib/communications/providers/sandboxSms.ts`,
  `apps/api/src/lib/integrations/adapters/mockSms.ts`): checked, and the same conclusion applies
  — no real SMS provider factory exists anywhere in this codebase; only sandbox/mock
  implementations are wired up. No lock needed, no code change made.
- **Object storage** (`packages/integrations/object-storage`): checked — only a local-filesystem
  implementation exists (the comment referencing a future S3/GCS adapter is aspirational; no such
  adapter has been written). Not an external network action and outside the Owner's named list
  (AML/email/SMS/e-signature/payment/property-data) — no lock needed.
- **Trust-money transactions**: a repo-wide check found no dedicated trust-account/trust-ledger
  module anywhere in this codebase — `financialDeposits` (the closest schema table) is explicitly
  evidentiary/read-only and is never touched by any charge/debit function (confirmed independently
  by Phase 6 §16). There is no code path that could constitute a "trust-money transaction" for
  this instruction to apply to; this is a structural absence, not a gap this phase needed to close.

## 3. Custody-boundary enforcement (PC success-fee authorisedPaymentMethod)

Phase 6 §16 found the "AE must not receive, hold, transfer or disburse trust money" claim true in
effect but not technically enforced: `pcFeeAuthorities.authorisedPaymentMethod` was an
unvalidated free-text column, and `createPcFeeAuthority()` (`apps/api/src/lib/financial/pcFeeAuthorities.ts`)
wrote whatever value a caller passed straight through with no check. The existing
`POST /financial/pc-fee-authorities` route's Zod schema happens to never accept this field as
input at all, so the only value ever reachable through that one route today was already the safe
default — but nothing would have stopped a different caller (a script, a bulk-import, a future
admin UI feature) from passing something else.

**Fix:** `createPcFeeAuthority()` now rejects any `authorisedPaymentMethod` other than the literal
string `"GENERAL_ACCOUNT_DEBIT_MANDATE"` outright, throwing a new `FinancialControlError` reason,
`CUSTODY_BOUNDARY_VIOLATION`, mapped to HTTP 400 in `apps/api/src/routes/financial.ts`'s existing
`handleFinancialControlError()`. This does not change the existing route's observable behaviour
(it never sent a different value anyway) — it closes the gap for every other, currently
hypothetical caller.

## 4. Pilot-mode billing UI labelling

`GET /grow/access` (`apps/api/src/routes/grow.ts`) now additionally returns
`billingProviderName: getBillingProvider().name` — reading the outcome of the same fail-closed
provider selection `POST /billing/checkout` already uses, never itself triggering a checkout or
external call. `apps/web/src/pages/Grow.tsx` renders a note — *"Sandbox billing — this is
test-mode only. No real card is charged and no real subscription is created."* — on the locked
upgrade screen when `billingProviderName === "mock"`, and an equivalent note in the entitled
workspace view. This label is honest and dynamic: if a future, non-pilot, fully-approved
production deployment ever sets `LIVE_EXTERNAL_TRANSACTIONS_APPROVED=true` with a real Stripe
key, `billingProviderName` becomes `"stripe"` and the sandbox note disappears automatically,
rather than this being a static claim that could silently go stale.

## 5. Verification performed this phase

1. `pnpm --filter @aee/api run typecheck` — clean, both before and after every edit in this
   phase.
2. `pnpm --filter @aee/web run typecheck` — clean (verifies the `Grow.tsx`/`grow.ts` changes).
3. `pnpm --filter @aee/integration-{payments,aml,esign,property-data,mandate-payments} run
   typecheck` — clean for all five.
4. `pnpm --filter @aee/web run build` and `pnpm --filter @aee/api run build` — both clean,
   consistent with Phase 9's verified production build path.
5. **New automated test**, `apps/api/src/lib/billing/__tests__/gatewayLock.test.ts` (wired into
   the existing `pnpm --filter @aee/api run test` glob via `src/lib/billing/__tests__/*.test.ts`,
   no database required): four cases proving (a) a fully-credentialed
   `BILLING_PROVIDER=stripe` request in production is forced to mock while
   `LIVE_EXTERNAL_TRANSACTIONS_APPROVED` is unset, (b) setting that flag to `"true"` restores real
   provider selection, (c) the lock never applies outside production, and (d) the safe
   `BILLING_PROVIDER=mock` default is unaffected either way. Run directly: `4/4 passing`.
6. **New automated tests**, added to the existing `apps/api/src/lib/financial/__tests__/pcFeeAuthorities.test.ts`
   (three new cases: the safe default, an explicit safe value, and a rejected unsafe value),
   run against a fresh disposable Postgres 16 database (`aee_phase10_smoke2`, created and migrated
   specifically for this phase, dropped afterward): together with the pre-existing tests in that
   file, `18/18 passing` (`25/25` combined with the billing gateway lock and entitlements tests run
   in the same pass).
7. **Targeted regression check** — `settlement.test.ts`, `paymentOutbox.test.ts`,
   `mandateProvider.test.ts`, `agreements.test.ts` (the financial-engine tests most likely to be
   affected by the custody-boundary check, since they all call `createPcFeeAuthority()`), against
   the same disposable database: `32/32 passing`, confirming the new validation does not break any
   existing caller that relies on the default `authorisedPaymentMethod`.
8. **Manual verification of the four packages that have no automated test infrastructure at all**
   (`packages/integrations/{payments,aml,esign,property-data}` have `typecheck`-only
   `package.json` scripts, no `node:test`/`tsx --test` wiring, and no `__tests__` directory
   anywhere in this codebase prior to this phase — adding a full test harness for four
   from-scratch packages was judged out of proportion to this phase's scope and is noted below as
   a good candidate for a future improvement, not performed here). A disposable Node script
   (`tsx --eval`) imported each factory directly under nine environment combinations and asserted
   the resulting instance's constructor name:
   - Each of `createPaymentProvider()`/`createAMLProvider()`/`createESignProvider()`/
     `createPropertyDataProvider()`, given full real-looking credentials, `NODE_ENV=production`,
     and **no** `LIVE_EXTERNAL_TRANSACTIONS_APPROVED` → returned `MockPaymentProvider`/
     `MockAMLProvider`/`MockESignProvider`/`MockPropertyDataProvider` respectively.
   - The same four, with `LIVE_EXTERNAL_TRANSACTIONS_APPROVED=true` added → returned
     `StripePaymentProvider`/`HttpAMLProvider`/`HttpESignProvider`/`GooglePlacesProvider`
     respectively, confirming the lock does not silently break real provider selection once
     genuinely approved.
   - `createPaymentProvider()` outside production (`NODE_ENV` unset), same credentials, no
     approval flag → returned `StripePaymentProvider`, confirming dev/test behaviour is
     unchanged.
   - **All nine cases passed.**

## 6. What this phase does not do

- Does not enable, or bring any closer to enabled, any real external-service credential or real
  charge — `LIVE_EXTERNAL_TRANSACTIONS_APPROVED` is left unset everywhere in this repository, and
  no Replit Secret was set from this environment (this environment has no access to Replit's
  Secrets store at all).
- Does not add a permanent, wired-into-CI automated test harness for the four
  `packages/integrations/*` packages that had none before this phase — the manual verification in
  §5.8 confirms correctness for this phase's evidence, but a future improvement would be adding
  `node:test`/`tsx` wiring to those packages' own `package.json` scripts so this class of check
  runs automatically going forward rather than needing a one-off script.
- Does not address the other, non-lock findings already on record from Phase 6 (Grow billing's
  webhook-signature-verification placeholder, unimplemented invoice generation, the PC-fee GST
  rate's lack of an override field, the unclosable dispute lifecycle, absent processor
  reconciliation) — those are pre-existing, already-documented gaps outside this phase's specific
  "billing and external-action locks" charter, tracked in
  `docs/gate-evidence/PHASE6_FINANCIAL_AND_BILLING_AUDIT.md` for a future pass.
- Does not re-run the complete ~664-test `pnpm run test` suite — that remains Phase 12's own
  mandated, separate step, using a fresh disposable database of its own, consistent with Phase 9's
  same deferral.
