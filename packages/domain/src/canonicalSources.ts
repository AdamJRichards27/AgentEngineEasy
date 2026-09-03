/**
 * Canonical Source Registry -- Part B, Stage 1 (financial domain).
 *
 * Declares, for each domain fact this registry covers: which table is the
 * canonical record, which module(s) are the confirmed (or intended) sole
 * writer(s), what legacy source predates it (if any), and the conflict
 * policy to apply when two sources disagree.
 *
 * This is a DECLARATION, not an enforcement mechanism yet. A later Part B
 * stage adds a lint rule / runtime guard that checks real write call sites
 * against `canonicalWriters` below. Until then, treat every entry as a
 * documented intent that a human (or the planned consistency checker) must
 * still verify against actual code -- and note that several entries below
 * are marked "unverified" precisely because no writer could be confirmed.
 *
 * Scope: financial domain only, seeded from a direct audit of
 * apps/api/src/lib/financial/**, apps/api/src/lib/transactions.ts, and
 * apps/api/src/routes/financial.ts on 2026-09-03 (grep across the live
 * repository, not inferred from documentation). Widen domain-by-domain in
 * later passes -- do not assume this file is exhaustive.
 */

export type ConflictPolicy =
  | "single-writer" // Only one system writes this fact; no conflict is possible by construction.
  | "legacy-superseded" // A legacy source existed first; the canonical source supersedes it once created, and the legacy value is never overwritten.
  | "flag-for-review" // Disagreement is expected and cannot be auto-resolved; surface it for a human via a reconciliation record -- never silently merge or fabricate.
  | "unverified"; // No confirmed writer found in this audit pass -- needs investigation before this entry can be trusted.

export interface LegacySource {
  table: string;
  columns: string[];
  writer: string;
}

export interface CanonicalSourceEntry {
  /** Stable identifier, kebab-case. */
  id: string;
  /** Plain-language description of the domain fact this entry governs. */
  fact: string;
  /** The table that is the canonical record for this fact. */
  canonicalTable: string;
  /** Column(s) covered, if only some columns of the table are in scope. */
  canonicalColumns?: string[];
  /** Module(s) that are the confirmed, or intended, sole writer(s). */
  canonicalWriters: string[];
  /** A pre-existing table/column that recorded this same fact before the canonical source existed, if any. */
  legacySource?: LegacySource;
  /** Read-only consumers -- must never write the canonical table directly. */
  projections?: string[];
  conflictPolicy: ConflictPolicy;
  /** Cite the real finding this entry is grounded in -- never a hypothetical. */
  notes: string;
}

export const FINANCIAL_CANONICAL_SOURCES: CanonicalSourceEntry[] = [
  {
    id: "transaction-commission-amount",
    fact: "The commission amount (and GST) calculated for a property transaction",
    canonicalTable: "commissionCalculations",
    canonicalWriters: [
      "apps/api/src/lib/financial/calculations.ts",
      "apps/api/src/lib/financial/settlement.ts",
    ],
    legacySource: {
      table: "transactions",
      columns: ["grossCommissionCents", "gstCents", "commissionCalculatedAt"],
      writer: "apps/api/src/lib/transactions.ts",
    },
    projections: [
      "apps/api/src/lib/financial/queries.ts",
      "apps/api/src/lib/timeline.ts",
    ],
    conflictPolicy: "flag-for-review",
    notes:
      "COHERENCE-001 (Step 1 audit): transactions that closed before a " +
      "commissionAgreement existed have only the legacy value; transactions " +
      "with an agreement have both, and they are not reconciled automatically. " +
      "FIN-001/legacyReconciliation.ts implements this flag-for-review policy: " +
      "reconcileLegacyCommission() creates a financialReconciliations row " +
      "(recordType=LEGACY_TRANSACTION_COMMISSION) rather than fabricating or " +
      "silently merging a commissionCalculations row. A partial unique index " +
      "(financial_reconciliations_legacy_commission_unique_idx) prevents a " +
      "second flag for the same transaction. No automatic backfill exists -- " +
      "investigated and found unsafe (legacy transactions never stored a " +
      "calculation method/rate, and commissionAgreementId/method are NOT NULL " +
      "on the Financial Engine side, so a backfill would have to fabricate data).",
  },
  {
    id: "commission-agreement-terms",
    fact: "The commission rate/method a brokerage has agreed for a property",
    canonicalTable: "commissionAgreements",
    canonicalWriters: ["apps/api/src/lib/financial/agreements.ts"],
    projections: [
      "apps/api/src/lib/financial/calculations.ts",
      "apps/api/src/lib/financial/queries.ts",
    ],
    conflictPolicy: "single-writer",
    notes:
      "No legacy equivalent -- pre-Financial-Engine transactions never " +
      "recorded a method/rate, only a final gross amount (see " +
      "transaction-commission-amount above).",
  },
  {
    id: "pc-fee-authority",
    fact: "Whether a Pit Crew has an active success-fee mandate, and its terms",
    canonicalTable: "pcFeeAuthorities",
    canonicalWriters: ["apps/api/src/lib/financial/pcFeeAuthorities.ts"],
    projections: ["apps/api/src/lib/financial/settlement.ts"],
    conflictPolicy: "single-writer",
    notes:
      "redactPcFeeAuthority() (routes/financial.ts) ensures the raw " +
      "mandateProviderRef never leaves the API -- a security boundary on this " +
      "same table, recorded here for visibility, not itself a canonical-ownership issue.",
  },
  {
    id: "pc-fee-calculation",
    fact: "The success-fee amount calculated for a Pit Crew on a completed settlement",
    canonicalTable: "pcFeeCalculations",
    canonicalWriters: ["apps/api/src/lib/financial/pcFeeCalculations.ts"],
    conflictPolicy: "single-writer",
    notes:
      "Triggered by the SETTLEMENT_COMPLETED handler in " +
      "apps/api/src/lib/financial/bootstrap.ts (confirmed in the Step 1 audit, " +
      "section 4) only when an ACTIVE pc-fee-authority exists for the property.",
  },
  {
    id: "financial-payment-request",
    fact: "A tracked request/notice for an external payment -- never an actual funds movement",
    canonicalTable: "financialPaymentRequests",
    canonicalWriters: ["apps/api/src/lib/financial/settlement.ts"],
    conflictPolicy: "single-writer",
    notes:
      "Agent Engine never moves funds (PR #17's own scope statement); this " +
      "table is a request/notice record, not a payment ledger.",
  },
  {
    id: "financial-payment-provider-event",
    fact: "An inbound event/webhook from an external payment provider",
    canonicalTable: "financialPaymentProviderEvents",
    canonicalWriters: ["apps/api/src/lib/financial/paymentWebhooks.ts"],
    conflictPolicy: "single-writer",
    notes:
      "Sandbox-only provider by construction (Step 2 report, section 1.2) -- " +
      "no real payment provider is connected.",
  },
  {
    id: "financial-payment-outbox",
    fact: "A pending/retryable outbound payment-provider action",
    canonicalTable: "financialPaymentOutbox",
    canonicalWriters: ["apps/api/src/lib/financial/paymentOutbox.ts"],
    conflictPolicy: "single-writer",
    notes:
      "Drained by a 15-minute sweep (dispatchPendingPaymentOutbox, registered " +
      "in bootstrap.ts) -- confirmed wired in the Step 1 audit, section 4; not " +
      "an orphaned table.",
  },
  {
    id: "financial-dispute",
    fact: "A disputed financial record and its resolution",
    canonicalTable: "financialDisputes",
    canonicalWriters: ["apps/api/src/lib/financial/paymentWebhooks.ts"],
    conflictPolicy: "single-writer",
    notes:
      "Also read by apps/api/src/lib/exceptions/rules/financial.ts (a risk-" +
      "exception rule over open disputes) -- confirm that read path stays " +
      "read-only when Stage 5 (writer enforcement) covers this table.",
  },
  {
    id: "marketing-payment-record",
    fact: "A tracked marketing/campaign expense record",
    canonicalTable: "marketingPaymentRecords",
    canonicalWriters: ["apps/api/src/lib/financial/marketing.ts"],
    conflictPolicy: "single-writer",
    notes: "Writer confirmed by direct grep; no legacy equivalent found.",
  },
  {
    id: "financial-deposit",
    fact: "A tracked sale-deposit record",
    canonicalTable: "financialDeposits",
    canonicalWriters: [],
    conflictPolicy: "unverified",
    notes:
      "GENUINE GAP, not a search-completeness artifact: grepped across the " +
      "entire apps/api/src tree, this table appears only in " +
      "apps/api/src/lib/financial/queries.ts (a read path). No write call site " +
      "was found anywhere. Either an unwired roadmap table or a real oversight " +
      "-- resolve before Stage 5 covers this table.",
  },
  {
    id: "financial-reconciliation",
    fact: "A flagged financial record requiring human review -- the flag-for-review mechanism itself",
    canonicalTable: "financialReconciliations",
    canonicalWriters: ["apps/api/src/lib/financial/legacyReconciliation.ts"],
    conflictPolicy: "single-writer",
    notes:
      "This table is itself the conflictPolicy=flag-for-review mechanism for " +
      "the transaction-commission-amount entry above -- it is the canonical " +
      "record of 'a conflict was flagged', not a projection of another fact.",
  },
  {
    id: "financial-ledger-event",
    fact: "An immutable entry in the financial audit ledger",
    canonicalTable: "financialLedgerEvents",
    canonicalWriters: [
      "apps/api/src/lib/financial/settlement.ts",
      "apps/api/src/lib/financial/legacyReconciliation.ts",
    ],
    conflictPolicy: "single-writer",
    notes:
      "Intended append-only (the audit-log-style table for this domain). " +
      "Worth a Stage 6 (security checks) pass confirming no code path ever " +
      "UPDATEs or DELETEs a row here.",
  },
  {
    id: "audit-return-reminder",
    fact: "A scheduled annual audit-return reminder",
    canonicalTable: "auditReturnReminders",
    canonicalWriters: [],
    conflictPolicy: "unverified",
    notes:
      "Same genuine gap as financial-deposit: only appears in " +
      "apps/api/src/lib/financial/queries.ts across the whole apps/api/src " +
      "tree. No write call site found. Resolve before Stage 5.",
  },
  {
    id: "financial-settings",
    fact: "Per-brokerage financial configuration",
    canonicalTable: "financialSettings",
    canonicalWriters: [],
    conflictPolicy: "unverified",
    notes:
      "Same genuine gap as financial-deposit and audit-return-reminder: only " +
      "appears in apps/api/src/lib/financial/queries.ts across the whole " +
      "apps/api/src/lib tree. No write call site found. Resolve before Stage 5.",
  },
];

/** Convenience lookup by canonical table name. */
export function findCanonicalSourceByTable(
  table: string,
): CanonicalSourceEntry | undefined {
  return FINANCIAL_CANONICAL_SOURCES.find((e) => e.canonicalTable === table);
}

/** All entries whose ownership is not yet confirmed -- the registry's own open-items list. */
export function unverifiedCanonicalSources(): CanonicalSourceEntry[] {
  return FINANCIAL_CANONICAL_SOURCES.filter(
    (e) => e.conflictPolicy === "unverified",
  );
}
