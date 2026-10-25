// Owner t178u(1) (CC #37): statement-first fee collection. The AE Pit Crew
// service fee may be collected only after a finalised, itemised settlement
// statement has been ISSUED to the authorised payer, with a PC_SERVICE_FEE
// line equal to the payment request amount.
//
// Owner t180u(1): the default lookup now reads the real statement (0041,
// settlement_statements + lines) and re-verifies, at collection time, what
// issue required: both representatives' written confirmations still ACTIVE
// and matching the recorded solicitors, and the statement lines re-derived
// from the source records (finalised commission, approved fees, PC fee
// request) unchanged and free of validation issues. Any drift since issue
// refuses collection until a Brokerage Administrator corrects the statement.
//
// Fails closed: a missing statement, a non-ISSUED statement, a statement for
// another transaction or brokerage, a different payer, a missing, duplicated
// or different PC_SERVICE_FEE line, a stale statement, incomplete
// confirmations, a lookup error, all refuse.
import { and, eq } from "drizzle-orm";
import { db, settlementConfirmations, settlementStatementLines, settlementStatements, transactions } from "@aee/db";

export type StatementPayer = { payerType: "Agent"; userId: number } | { payerType: "Brokerage"; brokerageId: number };

export interface IssuedSettlementStatementRecord {
  statementId: number;
  brokerageId: number;
  transactionId: number;
  status: string; // DRAFT | ISSUED | SUPERSEDED (S1)
  issuedAt: Date | null;
  issuedTo: StatementPayer;
  lines: Array<{ kind: string; amountCents: number; currency?: string; paymentRequestId?: number | null }>;
  /** Set by the real lookup (t180u): drift since issue. Test fakes may omit it. */
  integrity?: "OK" | "CONFIRMATIONS_INCOMPLETE" | "STALE";
}

export type SettlementStatementLookup = (q: { brokerageId: number; transactionId: number }) => Promise<IssuedSettlementStatementRecord | null>;

type LegalReps = { sellerSolicitorPartyId?: number | null; buyerSolicitorPartyId?: number | null } | null;

/** t180u: the real lookup over 0041. Returns the single ISSUED statement for the transaction, or null. */
export const dbSettlementStatementLookup: SettlementStatementLookup = async ({ brokerageId, transactionId }) => {
  const [st] = await db
    .select()
    .from(settlementStatements)
    .where(and(eq(settlementStatements.transactionId, transactionId), eq(settlementStatements.brokerageId, brokerageId), eq(settlementStatements.status, "ISSUED")));
  if (!st) return null;
  const lines = await db.select().from(settlementStatementLines).where(eq(settlementStatementLines.statementId, st.id)).orderBy(settlementStatementLines.lineNo);
  const [txn] = await db.select().from(transactions).where(eq(transactions.id, transactionId));
  const reps = (txn?.legalRepresentatives ?? null) as LegalReps;
  const active = await db
    .select()
    .from(settlementConfirmations)
    .where(and(eq(settlementConfirmations.transactionId, transactionId), eq(settlementConfirmations.status, "ACTIVE")));
  const sideOk = (side: "BUYER" | "SELLER") => {
    const expected = side === "BUYER" ? reps?.buyerSolicitorPartyId : reps?.sellerSolicitorPartyId;
    const c = active.find((x) => x.side === side);
    return c != null && typeof expected === "number" && c.representativePartyId === expected;
  };
  let integrity: IssuedSettlementStatementRecord["integrity"] = "OK";
  if (!sideOk("BUYER") || !sideOk("SELLER")) integrity = "CONFIRMATIONS_INCOMPLETE";
  else {
    // Lazy import: routes/financialStatements imports the collection workflow (auto-collect on issue).
    const { deriveStatement, fingerprint } = await import("../routes/financialStatements.js");
    const derived = await deriveStatement(db, transactionId, st.propertyId);
    const payer = { payerType: st.payerType, payerUserId: st.payerUserId, payerBrokerageId: st.payerBrokerageId };
    if (derived.issues.length > 0 || fingerprint(derived.lines, payer) !== st.linesFingerprint) integrity = "STALE";
  }
  return {
    statementId: st.id,
    brokerageId: st.brokerageId,
    transactionId: st.transactionId,
    status: st.status,
    issuedAt: st.issuedAt,
    issuedTo: st.payerType === "Brokerage" ? { payerType: "Brokerage", brokerageId: st.payerBrokerageId! } : { payerType: "Agent", userId: st.payerUserId! },
    // The gate compares the line's gross (amount + GST) with the payment request amount.
    lines: lines.map((l) => ({ kind: l.kind, amountCents: l.amountCents + l.gstCents, currency: st.currency, paymentRequestId: l.paymentRequestId })),
    integrity,
  };
};

let lookupIssuedSettlementStatement: SettlementStatementLookup = dbSettlementStatementLookup;

/**
 * Test seam only (S-1f/S-1g unit coverage with synthetic statements).
 * Refuses outside NODE_ENV=test; production always uses the real lookup.
 */
export function setSettlementStatementLookupForTests(fn: SettlementStatementLookup | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("settlement statement lookup override is test-only");
  lookupIssuedSettlementStatement = fn ?? dbSettlementStatementLookup;
}

export type SettlementStatementGateCode =
  | "SETTLEMENT_STATEMENT_NOT_ISSUED"
  | "SETTLEMENT_STATEMENT_PAYER_MISMATCH"
  | "SETTLEMENT_STATEMENT_FEE_MISMATCH"
  | "SETTLEMENT_CONFIRMATIONS_INCOMPLETE"
  | "SETTLEMENT_STATEMENT_STALE";

export type SettlementStatementGateResult = { ok: true; statementId: number } | { ok: false; code: SettlementStatementGateCode };

export const PC_SERVICE_FEE_LINE_KIND = "PC_SERVICE_FEE";

export async function checkSettlementStatementGate(input: {
  brokerageId: number;
  transactionId: number;
  payer: StatementPayer;
  paymentRequestId: number;
  amountCents: number;
  currency: string;
}): Promise<SettlementStatementGateResult> {
  let statement: IssuedSettlementStatementRecord | null;
  try {
    statement = await lookupIssuedSettlementStatement({ brokerageId: input.brokerageId, transactionId: input.transactionId });
  } catch {
    return { ok: false, code: "SETTLEMENT_STATEMENT_NOT_ISSUED" };
  }
  if (
    !statement ||
    statement.status !== "ISSUED" ||
    statement.issuedAt == null ||
    statement.brokerageId !== input.brokerageId ||
    statement.transactionId !== input.transactionId
  ) {
    return { ok: false, code: "SETTLEMENT_STATEMENT_NOT_ISSUED" };
  }
  if (statement.integrity === "CONFIRMATIONS_INCOMPLETE") return { ok: false, code: "SETTLEMENT_CONFIRMATIONS_INCOMPLETE" };
  if (statement.integrity !== undefined && statement.integrity !== "OK") return { ok: false, code: "SETTLEMENT_STATEMENT_STALE" };
  const to = statement.issuedTo;
  const payerOk =
    to != null &&
    to.payerType === input.payer.payerType &&
    (to.payerType === "Agent"
      ? input.payer.payerType === "Agent" && to.userId === input.payer.userId
      : input.payer.payerType === "Brokerage" && to.brokerageId === input.payer.brokerageId);
  if (!payerOk) return { ok: false, code: "SETTLEMENT_STATEMENT_PAYER_MISMATCH" };
  const feeLines = (statement.lines ?? []).filter((l) => l.kind === PC_SERVICE_FEE_LINE_KIND);
  const line = feeLines.length === 1 ? feeLines[0]! : null;
  if (
    !line ||
    !Number.isSafeInteger(line.amountCents) ||
    line.amountCents !== input.amountCents ||
    (line.currency != null && line.currency !== input.currency) ||
    (line.paymentRequestId != null && line.paymentRequestId !== input.paymentRequestId)
  ) {
    return { ok: false, code: "SETTLEMENT_STATEMENT_FEE_MISMATCH" };
  }
  return { ok: true, statementId: statement.statementId };
}
