# Legacy and Derived Data Classification

**Part B, Stage 2.** Where Stage 1's registry (`docs/CANONICAL_SOURCE_REGISTRY.md`) declares single-writer ownership per table, this document classifies a different risk: facts that are represented in **more than one place** -- either because a legacy predecessor was never fully retired, or because a value is deliberately denormalised for fast reads. Each pattern found is classified by how (or whether) the copies are kept consistent, since that determines the actual risk.

## Methodology

Started from the one confirmed case (COHERENCE-001, `transactions.commission*` vs `commissionCalculations`), then scanned for structurally similar splits by grepping schema comments (`legacy`, `deprecated`, `superseded`, `denormalised`) and tracing every write path for the flagged candidate -- workflow/listing-stage tracking -- across `apps/api/src`. Grep-based, direct-code audit of the live `staging` branch, 2026-09-03; not exhaustive across every domain, only the financial-commission case and the workflow-tracking case this pass covers.

## Classification categories

- **Unreconciled legacy split** -- two independent sources for the same fact, nothing keeps them in sync, disagreement is possible and currently only caught by an explicit flag-for-review mechanism (or not at all).
- **Gated derived projection** -- a coarse field whose value is only ever set as the output of validating a finer-grained source; the finer-grained source is authoritative, the coarse field cannot get ahead of it by construction.
- **Synchronously refreshed projection (non-atomic)** -- a projection recalculated from a canonical source by an explicit refresh call placed right after each write to that source, but not wrapped in the same database transaction as it -- so a crash between the two calls is a real, if narrow, drift window.
- **Best-effort projection** -- a refresh call whose failure is caught and logged (`.catch(console.error)`) rather than surfaced or retried, so the projection can go stale silently with no user-facing signal.

## Finding 1 -- Commission amount (unreconciled legacy split)

Already the flagship finding from the Step 1 audit and Stage 1's registry entry `transaction-commission-amount`: `transactions.grossCommissionCents/gstCents` (legacy, writer `transactions.ts`) and `commissionCalculations` (canonical, Financial Engine) can both exist for the same transaction with no automatic reconciliation. FIN-001 added `financialReconciliations` as the flag-for-review mechanism -- this is the one case in the codebase where the split is real and a human-review process, not code, is what closes it. See the registry for full detail; repeated here only to anchor the classification scheme against a known case.

## Finding 2 -- Property workflow stage, pre-listing (gated derived projection)

`properties.workflowStage` and `properties.listingStatus` are flipped to `"Listed"` in exactly one place, `apps/api/src/lib/goLive.ts`'s `goLiveProperty()`, and only after it loads every `workflowSteps` row for the property's `"ReadyToList"` workflow and confirms none are incomplete (`INCOMPLETE_STEPS` is returned otherwise, blocking the flip). The module's own header comment states the intent directly: this is *"the single Go Live chokepoint"*, deliberately reused rather than duplicated elsewhere. `workflowSteps` (fine-grained, per-step) is authoritative here; `workflowStage` cannot say "Listed" without the steps genuinely being complete, because the code path enforces it. This is a sound pattern, not a coherence risk -- included here so the *next* finding's contrast is clear.

## Finding 3 -- Property workflow stage, post-listing (synchronously refreshed projection, non-atomic)

Once a property is under offer, the relationship inverts: `apps/api/src/lib/transactions.ts` writes `transactions` table fields (`settlementDate`, `settlementCompletedAt`, `agentPaidAt`, `fundsReceivedCents`, `status`) as the canonical source, then writes `properties.workflowStage` directly (`"Under Offer"` / `"Contract"` / `"Settlement"` / `"Closed"`), and separately calls `refreshTransactionSteps(propertyId)` (`apps/api/src/lib/workflowSteps.ts:161`) to recompute the `"Transaction"`-type `workflowSteps` rows (`ContractSigning`, `Settlement`, `Payout`) from those same `transactions` fields. All seven `transactions.ts` state-transition sites call `refreshTransactionSteps` (verified by direct grep, lines 201/296/381/478/527/561/721) -- coverage is thorough, not accidental. But the `transactions` update, the `properties.workflowStage` update, and the `workflowSteps` refresh are three separate statements, not one database transaction. A crash between any two of them leaves `workflowStage` and/or `workflowSteps` briefly describing a transaction state that `transactions` itself has already moved past. No consistency checker currently detects this after the fact.

## Finding 4 -- AML/listing status summaries (best-effort projection)

`properties.amlStatusSummary` and `properties.listingStatus` carry an explicit schema comment: *"Denormalised status summaries for fast 'what's next' reads -- source of truth remains the linked AMLVerification / DocumentPackage rows."* They're recomputed by `refreshReadyToListSteps()` (`workflowSteps.ts:38`), called from `aml.ts`, `documents.ts`, `routes/parties.ts`, `routes/aml.ts`, and `routes/properties.ts` after the relevant AML or document-package change. At `aml.ts:279/344/387` and `documents.ts:166/271/379`, the call is `await refreshReadyToListSteps(...).catch((err) => console.error("refreshReadyToListSteps failed", err))` -- a failure is logged, not retried, not surfaced to the caller, and not flagged anywhere a human or a future request would see it. A transient DB error during refresh leaves the denormalised summary stale with nothing recording that it happened.

## Investigated and ruled out

`packages/db/src/schema/documents.ts`'s comment on `agencyAgreementTerms` -- *"Real structured agency-agreement terms... NOT the legacy app's opaque-JSON commission storage"* -- refers to a predecessor system entirely outside this codebase, already fully replaced by this table. No live dual-write exists; noted here only so this doc's "legacy" grep hits are shown as checked, not skipped.

## Open items for Stage 4 (consistency checker)

Three concrete checks this classification implies, to carry into the Stage 4 checker rather than fix ad hoc here:

1. For every transaction whose `status`/`settlementDate`/`settlementCompletedAt`/`agentPaidAt`/`fundsReceivedCents` changed, confirm the property's `workflowStage` and its `"Transaction"`-workflow `workflowSteps` rows reflect that state -- catches the Finding 3 drift window.
2. For every property with an AML verification or document-package change in the last N minutes, confirm `amlStatusSummary`/`listingStatus` was actually refreshed -- catches a swallowed Finding 4 failure.
3. Track how often `refreshReadyToListSteps`/`refreshTransactionSteps` calls actually hit their `.catch()` branch (currently only a `console.error`, not a metric) -- without this, Finding 4's real-world frequency is unknown.

## Relationship to the rest of Part B

Stage 1 (`docs/CANONICAL_SOURCE_REGISTRY.md`) covers financial-domain table ownership. This document covers cross-table representation of the same fact, financial and workflow domains. Stage 3 documents event contracts next; Stage 4's consistency checker should implement the three checks above alongside the financial-domain checks Stage 1's registry implies; Stage 5 (writer enforcement) and Stage 6 (security/documentation close-out) follow.
