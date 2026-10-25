// Owner t178u(1) (CC #37): statement-first fee collection. The AE Pit Crew
// service fee may be collected only after a finalised, itemised settlement
// statement has been ISSUED to the authorised payer, with a PC_SERVICE_FEE
// line equal to the payment request amount.
//
// No settlement-statement table exists yet (schema proposal S1, Owner
// approval pending). Every lookup therefore goes through ONE function,
// `lookupIssuedSettlementStatement`, which returns "no issued statement"
// until S1 is built. Collection is blocked (409 SETTLEMENT_STATEMENT_NOT_ISSUED)
// in every environment. When S1 lands, only the default lookup changes; the
// checks below stay as they are.
//
// Fails closed: a missing statement, a non-ISSUED statement, a statement for
// another transaction or brokerage, a different payer, a missing, duplicated
// or different PC_SERVICE_FEE line, a lookup error, all refuse.

export type StatementPayer = { payerType: "Agent"; userId: number } | { payerType: "Brokerage"; brokerageId: number };

export interface IssuedSettlementStatementRecord {
  statementId: number;
  brokerageId: number;
  transactionId: number;
  status: string; // DRAFT | ISSUED | SUPERSEDED (S1)
  issuedAt: Date | null;
  issuedTo: StatementPayer;
  lines: Array<{ kind: string; amountCents: number; currency?: string; paymentRequestId?: number | null }>;
}

export type SettlementStatementLookup = (q: { brokerageId: number; transactionId: number }) => Promise<IssuedSettlementStatementRecord | null>;

/** S1 not built: there is no statement record, so nothing has been issued. */
const noStatementRecordYet: SettlementStatementLookup = async () => null;

let lookupIssuedSettlementStatement: SettlementStatementLookup = noStatementRecordYet;

/**
 * Test seam only, so the post-statement path stays covered until S1 exists.
 * Refuses outside NODE_ENV=test; production always uses the default lookup.
 */
export function setSettlementStatementLookupForTests(fn: SettlementStatementLookup | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("settlement statement lookup override is test-only");
  lookupIssuedSettlementStatement = fn ?? noStatementRecordYet;
}

export type SettlementStatementGateCode = "SETTLEMENT_STATEMENT_NOT_ISSUED" | "SETTLEMENT_STATEMENT_PAYER_MISMATCH" | "SETTLEMENT_STATEMENT_FEE_MISMATCH";

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
