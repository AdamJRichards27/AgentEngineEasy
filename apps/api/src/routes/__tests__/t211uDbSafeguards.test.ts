// Owner t211u item 1: database safeguards for finalised financial records.
// Ledger events, issued statements (and their lines), receipts, waiver and
// write-off records, and payment-authority terms after activation refuse
// UPDATE/DELETE at the database, except through the audited Brokerage
// Administrator correction service (a transaction-scoped flag naming the
// correction's own audit row). Plus one ACTIVE authority per agent (partial
// unique index) and the held-raiser column. Local throwaway test DB only.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  auditLogs,
  db,
  financialLedgerEvents,
  financialPaymentOutbox,
  financialPaymentRequests,
  financialReceipts,
  pcFeeAuthorities,
  settlementStatementLines,
  settlementStatements,
} from "@aee/db";
import { mandatePaymentProvider } from "../../lib/financial/provider.js";
import { correctFinancialRecord, FinancialCorrectionRefusal } from "../../lib/financial/corrections.js";
import { createPcFeeAuthority } from "../../lib/financial/pcFeeAuthorities.js";
import { cleanupBrokerages } from "./testSupport.js";
import { activeDebitAuthority, call, cardAuthorityViaApi, collect, confirmBoth, elapseNotice, feeChain, makeWorld, prepareAndIssue, saveCard, type Chain, type World } from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
const REASON = "Synthetic t211u safeguard reason";
const FINAL = /finalised financial record|immutable/;

function dbErr(re: RegExp) {
  return (e: unknown) => {
    const err = e as { message?: string; cause?: { message?: string } };
    assert.match(`${err.message} ${err.cause?.message ?? ""}`, re);
    return true;
  };
}
const ba = () => ({ id: w.X.admin.user.id, role: "Brokerage Administrator", brokerageId: w.X.brokerageId });

let paid: Chain; // card fee PAID: receipt + ledger + ISSUED statement
let waived: Chain;
let writtenOff: Chain;
let cardAuthorityId: number;

async function issuedCardFee(tag: string) {
  const c = await feeChain(w, cardAuthorityId, tag);
  await confirmBoth(w, c);
  assert.equal((await prepareAndIssue(w, w.crew, c)).status, 200);
  await elapseNotice(c);
  return c;
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "T211uDb");
  const card = await saveCard("Agent", w.X.agent.user.id);
  cardAuthorityId = (await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id })).id;
  paid = await issuedCardFee("DbPaid");
  assert.equal((await collect(w, w.crew, paid)).json.outcome, "card_charged");
  waived = await issuedCardFee("DbWaived");
  assert.equal((await call(w.baseUrl, "POST", `/financial/payment-requests/${waived.requestId}/waive`, w.X.admin.cookie, { reason: REASON, evidenceNote: REASON })).status, 200);
  writtenOff = await issuedCardFee("DbWo");
  await db.update(financialPaymentRequests).set({ status: "FAILED", failedAt: new Date() }).where(eq(financialPaymentRequests.id, writtenOff.requestId));
  const wo = await call(w.baseUrl, "POST", `/financial/payment-requests/${writtenOff.requestId}/write-off`, w.X.admin.cookie, { reason: REASON, evidenceNote: REASON });
  assert.equal(wo.status, 200, wo.raw);
});
after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t211u item 1: finalised financial records are protected by the database", { concurrency: false }, () => {
  test("ledger events: UPDATE and DELETE refused", async () => {
    const [ev] = await db.select().from(financialLedgerEvents).where(eq(financialLedgerEvents.sourceRecordId, String(paid.requestId))).limit(1);
    assert.ok(ev);
    await assert.rejects(db.update(financialLedgerEvents).set({ amountCents: 1 }).where(eq(financialLedgerEvents.id, ev.id)), dbErr(FINAL));
    await assert.rejects(db.delete(financialLedgerEvents).where(eq(financialLedgerEvents.id, ev.id)), dbErr(FINAL));
  });

  test("receipts: DELETE refused (UPDATE already refused by 0042)", async () => {
    const [r] = await db.select().from(financialReceipts).where(eq(financialReceipts.paymentRequestId, paid.requestId)).limit(1);
    assert.ok(r);
    await assert.rejects(db.delete(financialReceipts).where(eq(financialReceipts.id, r.id)), dbErr(FINAL));
    await assert.rejects(db.update(financialReceipts).set({ amountCents: 1 }).where(eq(financialReceipts.id, r.id)), dbErr(FINAL));
  });

  test("issued statements and their lines: DELETE refused", async () => {
    const [s] = await db.select().from(settlementStatements).where(and(eq(settlementStatements.transactionId, paid.transactionId), eq(settlementStatements.status, "ISSUED")));
    assert.ok(s);
    await assert.rejects(db.delete(settlementStatementLines).where(eq(settlementStatementLines.statementId, s.id)), dbErr(FINAL));
    await assert.rejects(db.delete(settlementStatements).where(eq(settlementStatements.id, s.id)), dbErr(FINAL));
  });

  test("waiver and write-off records: the recorded decision cannot be edited, reopened or deleted", async () => {
    await assert.rejects(db.update(financialPaymentRequests).set({ waiveReason: "edited" }).where(eq(financialPaymentRequests.id, waived.requestId)), dbErr(FINAL));
    await assert.rejects(db.update(financialPaymentRequests).set({ status: "NOTICE_SENT", waivedAt: null }).where(eq(financialPaymentRequests.id, waived.requestId)), dbErr(FINAL));
    await assert.rejects(db.update(financialPaymentRequests).set({ writeOffReason: "edited" }).where(eq(financialPaymentRequests.id, writtenOff.requestId)), dbErr(FINAL));
    await assert.rejects(db.update(financialPaymentRequests).set({ status: "RETRY_SCHEDULED" }).where(eq(financialPaymentRequests.id, writtenOff.requestId)), dbErr(FINAL));
    await assert.rejects(db.delete(financialPaymentRequests).where(eq(financialPaymentRequests.id, waived.requestId)), dbErr(FINAL));
  });

  test("authority terms after activation: terms refused; ACTIVE -> REVOKED/REPLACED allowed once; terminal states stay terminal; DELETE refused", async () => {
    const a = await activeDebitAuthority(w);
    for (const patch of [{ rateBps: 1 }, { maximumAmountCents: 1 }, { signedEvidenceRef: null }, { agreementTermsVersion: "X" }, { effectiveDate: new Date() }, { expiresAt: new Date() }, { noticeRequiredDays: 0 }]) {
      await assert.rejects(db.update(pcFeeAuthorities).set(patch).where(eq(pcFeeAuthorities.id, a.id)), dbErr(FINAL), JSON.stringify(patch));
    }
    await assert.rejects(db.delete(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, a.id)), dbErr(FINAL));
    await db.update(pcFeeAuthorities).set({ status: "REVOKED", revokedAt: new Date(), revokeReason: REASON, updatedAt: new Date() }).where(eq(pcFeeAuthorities.id, a.id));
    await assert.rejects(db.update(pcFeeAuthorities).set({ status: "ACTIVE", revokedAt: null }).where(eq(pcFeeAuthorities.id, a.id)), dbErr(FINAL));
    await assert.rejects(db.update(pcFeeAuthorities).set({ revokeReason: "edited" }).where(eq(pcFeeAuthorities.id, a.id)), dbErr(FINAL));
    // A not-yet-active draft is still editable.
    const draft = await createPcFeeAuthority({ brokerageId: w.X.brokerageId, agentUserId: w.X.agent.user.id, feeBasis: "PERCENTAGE_OF_GCI", rateBps: 690, gstApplicable: true, noticeRequiredDays: 7, createdByUserId: w.X.admin.user.id });
    await db.update(pcFeeAuthorities).set({ rateBps: 700 }).where(eq(pcFeeAuthorities.id, draft.id));
  });

  test("one ACTIVE authority per agent: the partial unique index refuses a second ACTIVE row", async () => {
    await activeDebitAuthority(w);
    const draft = await createPcFeeAuthority({ brokerageId: w.X.brokerageId, agentUserId: w.X.agent.user.id, feeBasis: "PERCENTAGE_OF_GCI", rateBps: 690, gstApplicable: true, noticeRequiredDays: 7, signedEvidenceRef: "synthetic", createdByUserId: w.X.admin.user.id });
    await assert.rejects(
      db.update(pcFeeAuthorities).set({ status: "ACTIVE", mandateProviderRef: "sandbox-dup", mandateProvider: "sandbox" }).where(eq(pcFeeAuthorities.id, draft.id)),
      dbErr(/pc_fee_authorities_one_active_per_agent_idx/),
    );
  });

  test("correction path: a Brokerage Administrator with a justification can correct; it writes the audit row first; the flag is transaction-scoped", async () => {
    const [ev] = await db.select().from(financialLedgerEvents).where(eq(financialLedgerEvents.sourceRecordId, String(paid.requestId))).orderBy(desc(financialLedgerEvents.id)).limit(1);
    const before = ev!.reason;
    const r = await correctFinancialRecord(ba(), { table: "financial_ledger_events", id: ev!.id, patch: { reason: "Corrected reason (synthetic)" }, evidence: { kind: "reference", ref: "synthetic-evidence-ref" }, justification: "Typo in the recorded reason; see ticket SYN-1" });
    const [after] = await db.select().from(financialLedgerEvents).where(eq(financialLedgerEvents.id, ev!.id));
    assert.equal(after!.reason, "Corrected reason (synthetic)");
    const [audit] = await db.select().from(auditLogs).where(eq(auditLogs.id, r.auditId));
    assert.equal(audit!.action, "financial_record_correction");
    assert.equal(audit!.recordType, "financial_ledger_events");
    assert.equal(audit!.recordId, String(ev!.id));
    assert.equal(audit!.userId, w.X.admin.user.id);
    assert.deepEqual(JSON.parse(audit!.previousValue!), { reason: before });
    assert.match(audit!.updatedValue!, /SYN-1/);
    // The flag does not outlive the correction's transaction.
    await assert.rejects(db.update(financialLedgerEvents).set({ reason: "again" }).where(eq(financialLedgerEvents.id, ev!.id)), dbErr(FINAL));
  });

  test("correction path refusals: non-BA, blank justification, other brokerage, protected columns, DELETE; a forged flag is refused", async () => {
    const [ev] = await db.select().from(financialLedgerEvents).where(eq(financialLedgerEvents.sourceRecordId, String(paid.requestId))).limit(1);
    const code = (c: string) => (e: unknown) => e instanceof FinancialCorrectionRefusal && e.code === c;
    await assert.rejects(correctFinancialRecord({ id: w.crew.user.id, role: "Pit Crew", brokerageId: w.X.brokerageId }, { table: "financial_ledger_events", id: ev!.id, patch: { reason: "x" }, evidence: { kind: "reference", ref: "synthetic-evidence-ref" }, justification: REASON }), code("CORRECTION_FORBIDDEN"));
    await assert.rejects(correctFinancialRecord(ba(), { table: "financial_ledger_events", id: ev!.id, patch: { reason: "x" }, evidence: { kind: "reference", ref: "synthetic-evidence-ref" }, justification: "   " }), code("CORRECTION_JUSTIFICATION_REQUIRED"));
    await assert.rejects(correctFinancialRecord({ id: w.Y.admin.user.id, role: "Brokerage Administrator", brokerageId: w.Y.brokerageId }, { table: "financial_ledger_events", id: ev!.id, patch: { reason: "x" }, evidence: { kind: "reference", ref: "synthetic-evidence-ref" }, justification: REASON }), code("CORRECTION_NOT_FOUND"));
    await assert.rejects(correctFinancialRecord(ba(), { table: "financial_ledger_events", id: ev!.id, patch: { brokerage_id: w.Y.brokerageId }, evidence: { kind: "reference", ref: "synthetic-evidence-ref" }, justification: REASON }), code("CORRECTION_COLUMN_NOT_ALLOWED"));
    await assert.rejects(correctFinancialRecord(ba(), { table: "users" as never, id: 1, patch: { role: "x" }, evidence: { kind: "reference", ref: "synthetic-evidence-ref" }, justification: REASON }), code("CORRECTION_TABLE_NOT_ALLOWED"));
    // Forged: pointing the flag at an existing (older) correction audit row from another transaction.
    const [old] = await db.select().from(auditLogs).where(eq(auditLogs.action, "financial_record_correction")).orderBy(desc(auditLogs.id)).limit(1);
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('aee.financial_correction_audit_id', ${String(old!.id)}, true)`);
        await tx.update(financialLedgerEvents).set({ reason: "forged" }).where(eq(financialLedgerEvents.id, ev!.id));
      }),
      dbErr(FINAL),
    );
  });

  test("held-raiser column: an uncertain dispatch records who raised the hold", async () => {
    const a = await activeDebitAuthority(w);
    const c = await feeChain(w, a.id, "DbHeld");
    await confirmBoth(w, c);
    assert.equal((await prepareAndIssue(w, w.crew, c)).status, 200);
    await elapseNotice(c);
    const spy = mock.method(mandatePaymentProvider, "scheduleDebit", async () => {
      throw new Error("network timeout");
    });
    try {
      await collect(w, w.crew, c);
    } finally {
      spy.mock.restore();
    }
    const [e] = await db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, c.requestId));
    assert.equal(e!.heldByUserId, w.crew.user.id);
    assert.ok(e!.heldAt instanceof Date);
  });
});
