# Canonical Source Registry -- Financial Domain

**Part B, Stage 1.** Companion matrix to `packages/domain/src/canonicalSources.ts`, the machine-readable source of truth. This document is a human-readable view of the same 14 entries -- if the two ever disagree, the TypeScript file wins.

## Scope and methodology

This pass covers the financial domain only (14 tables in `packages/db/src/schema/financial.ts`, plus the legacy commission fields on `transactions`). It was seeded by a direct grep-based audit of the live `staging` branch on 2026-09-03 -- every writer and projection cited below was confirmed by reading the actual call site, not inferred from documentation or the original Part B brief. Other domains (workflow tracking, listings, etc.) are out of scope for Stage 1 and are flagged as the likely next candidates in Stage 2.

## Why this exists

The Step 1 build-state audit (`docs/CONSOLIDATED_BUILD_STATE_AND_MERGE_AUDIT.md`) found COHERENCE-001: the commission amount for a property transaction can live in two places -- the legacy `transactions.grossCommissionCents` column and the Financial Engine's `commissionCalculations` table -- and nothing in the codebase reconciled them automatically. FIN-001 (verified live this session) closed the acute risk by having `legacyReconciliation.ts` flag disagreements into `financialReconciliations` rather than silently merging or fabricating a value. This registry generalizes that finding: it is the map of every financial fact that has, or could develop, the same dual-source problem, so the next COHERENCE-001 is caught by inspection instead of by accident.

## Matrix

| Domain fact | Canonical table | Permitted writer(s) | Legacy source | Projections (read-only) | Conflict policy |
| --- | --- | --- | --- | --- | --- |
| Commission amount for a transaction | `commissionCalculations` | `financial/calculations.ts`, `financial/settlement.ts` | `transactions.grossCommissionCents/gstCents/commissionCalculatedAt` (writer: `transactions.ts`) | `financial/queries.ts`, `timeline.ts` | flag-for-review |
| Commission agreement terms | `commissionAgreements` | `financial/agreements.ts` | none | `financial/calculations.ts`, `financial/queries.ts` | single-writer |
| Pit Crew fee authority | `pcFeeAuthorities` | `financial/pcFeeAuthorities.ts` | none | `financial/settlement.ts` | single-writer |
| Pit Crew fee calculation | `pcFeeCalculations` | `financial/pcFeeCalculations.ts` | none | -- | single-writer |
| Payment request | `financialPaymentRequests` | `financial/settlement.ts` | none | -- | single-writer |
| Payment provider event | `financialPaymentProviderEvents` | `financial/paymentWebhooks.ts` | none | -- | single-writer |
| Payment outbox entry | `financialPaymentOutbox` | `financial/paymentOutbox.ts` | none | -- | single-writer |
| Financial dispute | `financialDisputes` | `financial/paymentWebhooks.ts` | none | `exceptions/rules/financial.ts` | single-writer |
| Marketing payment record | `marketingPaymentRecords` | `financial/marketing.ts` | none | -- | single-writer |
| Sale deposit | `financialDeposits` | none found | none | `financial/queries.ts` | unverified |
| Financial reconciliation flag | `financialReconciliations` | `financial/legacyReconciliation.ts` | none (this table IS the flag-for-review mechanism) | -- | single-writer |
| Financial ledger event | `financialLedgerEvents` | `financial/settlement.ts`, `financial/legacyReconciliation.ts` | none | -- | single-writer |
| Audit return reminder | `auditReturnReminders` | none found | none | `financial/queries.ts` | unverified |
| Brokerage financial settings | `financialSettings` | none found | none | `financial/queries.ts` | unverified |

## Conflict policy legend

- **single-writer** -- only one module writes this table; no conflict is possible by construction.
- **legacy-superseded** -- a legacy source existed first; the canonical source supersedes it once created and the legacy value is never overwritten. (No current entry uses this yet -- reserved for when a backfill/migration path is designed for the commission-amount gap below.)
- **flag-for-review** -- disagreement is expected and cannot be auto-resolved; surfaced via a `financialReconciliations` row for a human to review. Currently only the commission-amount entry uses this.
- **unverified** -- no confirmed writer found in this audit pass. Not a data-integrity finding by itself, but an open item that must be resolved (either a writer is found, or the table is confirmed unwired/roadmap) before Stage 5 (writer enforcement) can cover it.

## Open items (the registry's own gap list)

Three tables -- `financialDeposits`, `auditReturnReminders`, `financialSettings` -- appear only in `apps/api/src/lib/financial/queries.ts` (a read path) anywhere in `apps/api/src`. No write call site was found. This was cross-checked with a broad, unanchored string search (not just an ORM-call regex) across the whole `apps/api/src` tree, so it is treated as a genuine gap rather than a search-completeness artifact. Each is either an unwired roadmap table or a real oversight; either way it should be resolved -- confirmed wired, or explicitly deferred -- before writer enforcement (Stage 5) is added for these tables.

## Relationship to the rest of Part B

- **Stage 2** will classify the legacy `transactions.commission*` split (and any structurally similar splits found elsewhere, workflow tracking is the leading candidate) in `docs/LEGACY_DATA_CLASSIFICATION.md`.
- **Stage 3** documents the real event contracts and fixes the stale "19 canonical events" comment (DOC-001) found in the Step 1 audit.
- **Stage 4** builds a read-only consistency checker that walks this registry and flags live disagreements -- the kind of automated check that would have caught COHERENCE-001 without a manual audit.
- **Stage 5** adds writer enforcement (lint rule or runtime guard) once the registry is populated and stable enough to enforce against.
- **Stage 6** closes the gate with security checks and documentation finalization.
