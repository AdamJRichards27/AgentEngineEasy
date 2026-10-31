// Owner t181u(A): the PC service fee is collected IMMEDIATELY on final
// statement issue only when the signed AE agreement AND the payment mandate
// both expressly permit it (versioned term flag); otherwise the contractual
// notice period is honoured. Fails closed for unversioned/unknown terms. The
// rule applied is audited and recorded in the ledger. Synthetic data, mock
// providers only.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, financialCardCharges, financialLedgerEvents, financialPaymentOutbox, transactions } from "@aee/db";
import { chargeServiceFeeStoredCard } from "../../lib/financial/pcFeeCardCharges.js";
import { collectionTimingFor } from "../../lib/financial/pcFeeTerms.js";
import { cleanupBrokerages } from "./testSupport.js";
import {
  activeDebitAuthority,
  call,
  cardAuthorityViaApi,
  collect,
  confirmBoth,
  feeChain,
  makeWorld,
  prepareAndIssue,
  request,
  saveCard,
  TERMS,
  type Chain,
  type World,
} from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
const outbox = (c: Chain) => db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, c.requestId));
const charges = (c: Chain) => db.select().from(financialCardCharges).where(eq(financialCardCharges.paymentRequestId, c.requestId));
const timingEvents = (c: Chain) =>
  db
    .select()
    .from(financialLedgerEvents)
    .where(and(eq(financialLedgerEvents.sourceRecordType, "PAYMENT_REQUEST"), eq(financialLedgerEvents.sourceRecordId, String(c.requestId)), eq(financialLedgerEvents.eventType, "PC_FEE_COLLECTION_TIMING")));
async function autoAudit(c: Chain) {
  const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "transaction"), eq(auditLogs.recordId, String(c.transactionId))));
  return rows.filter((r) => r.action.startsWith("pit_crew_service_fee_auto_collection")).map((r) => JSON.parse(r.updatedValue ?? "{}"));
}
async function issued(authorityId: number, tag: string) {
  const c = await feeChain(w, authorityId, tag);
  await confirmBoth(w, c);
  const iss = await prepareAndIssue(w, w.crew, c);
  assert.equal(iss.status, 200, iss.raw);
  return { c, collection: iss.json.collection };
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "Timing");
});

after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t181u(A): collection timing follows the signed agreement AND mandate terms", { concurrency: false }, () => {
  test("rule table fails closed: immediate only when both versions are known and both permit it", () => {
    const t = (a: string | null, m: string | null) => collectionTimingFor({ agreementTermsVersion: a, mandateTermsVersion: m, signedEvidenceRef: "synthetic-signed", effectiveDate: new Date() });
    assert.equal(t(TERMS.agreementImmediate, TERMS.mandateImmediate).rule, "IMMEDIATE_ON_STATEMENT_ISSUE");
    assert.equal(t(TERMS.agreementImmediate, TERMS.mandateNotice).noticeReason, "MANDATE_TERMS_REQUIRE_NOTICE");
    assert.equal(t(TERMS.agreementNotice, TERMS.mandateImmediate).noticeReason, "AGREEMENT_TERMS_REQUIRE_NOTICE");
    assert.equal(t(null, TERMS.mandateImmediate).noticeReason, "AGREEMENT_TERMS_UNVERSIONED");
    assert.equal(t(TERMS.agreementImmediate, null).noticeReason, "MANDATE_TERMS_UNVERSIONED");
    assert.equal(t("AE-PCF-AGREEMENT-2099.1", TERMS.mandateImmediate).rule, "NOTICE_PERIOD", "unknown version -> notice");
    assert.equal(t(null, null).rule, "NOTICE_PERIOD", "pre-versioned authorities keep their notice period");
  });

  test("direct debit, both terms permit: debit scheduled on issue (no notice wait); rule audited and in the ledger", async () => {
    const a = await activeDebitAuthority(w, { agreementTermsVersion: TERMS.agreementImmediate, mandateTermsVersion: TERMS.mandateImmediate });
    const { c, collection } = await issued(a.id, "DdImmediate");
    assert.ok(["debit_scheduled", "debit_queued"].includes(collection.outcome), JSON.stringify(collection));
    assert.equal((await outbox(c)).filter((o) => o.action === "SCHEDULE_DEBIT").length, 1);
    const ev = await timingEvents(c);
    assert.equal(ev.length, 1);
    assert.equal((ev[0]!.metadata as { rule: string }).rule, "IMMEDIATE_ON_STATEMENT_ISSUE");
    assert.equal((await autoAudit(c)).at(-1)!.timingRule, "IMMEDIATE_ON_STATEMENT_ISSUE");
    const again = await collect(w, w.crew, c);
    assert.equal(again.json.outcome, "already_in_progress", again.raw);
    assert.equal((await outbox(c)).length, 1, "no second debit");
  });

  test("agreement permits but mandate requires notice -> notice honoured; collect inside the period refused", async () => {
    const a = await activeDebitAuthority(w, { agreementTermsVersion: TERMS.agreementImmediate, mandateTermsVersion: TERMS.mandateNotice });
    const { c, collection } = await issued(a.id, "MandateNotice");
    assert.equal(collection.outcome, "notice_started");
    assert.equal((await collect(w, w.crew, c)).json.code, "SERVICE_FEE_NOTICE_PERIOD_RUNNING");
    assert.equal((await outbox(c)).length, 0);
    const audit = (await autoAudit(c)).at(-1)!;
    assert.equal(audit.timingRule, "NOTICE_PERIOD");
    assert.equal(audit.noticeReason, "MANDATE_TERMS_REQUIRE_NOTICE");
    const view = await call(w.baseUrl, "GET", `/payments/pit-crew-service-fee/${c.transactionId}`, w.crew.cookie);
    assert.deepEqual(view.json.serviceFee.collectionTiming, { rule: "NOTICE_PERIOD", noticeReason: "MANDATE_TERMS_REQUIRE_NOTICE" });
  });

  test("existing (unversioned) and notice-version agreements keep the notice period", async () => {
    const legacy = await activeDebitAuthority(w);
    const r1 = await issued(legacy.id, "Legacy");
    assert.equal(r1.collection.outcome, "notice_started");
    assert.equal((await autoAudit(r1.c)).at(-1)!.noticeReason, "AGREEMENT_TERMS_UNVERSIONED");
    const old = await activeDebitAuthority(w, { agreementTermsVersion: TERMS.agreementNotice, mandateTermsVersion: TERMS.mandateImmediate });
    const r2 = await issued(old.id, "OldAgreement");
    assert.equal(r2.collection.outcome, "notice_started");
    assert.equal((await outbox(r1.c)).length + (await outbox(r2.c)).length, 0);
  });

  test("unknown terms versions are refused when an authority is drafted", async () => {
    const card = await saveCard("Agent", w.X.agent.user.id);
    for (const body of [{ agreementTermsVersion: "AE-PCF-AGREEMENT-2099.1" }, { mandateTermsVersion: "made-up" }]) {
      const r = await call(w.baseUrl, "POST", "/financial/pc-fee-authorities", w.X.admin.cookie, {
        agentUserId: w.X.agent.user.id,
        rateBps: 690,
        signedEvidenceRef: "synthetic",
        authorisedPaymentMethod: "STORED_CARD",
        payerType: "Agent",
        paymentMethodId: card.id,
        ...body,
      });
      assert.equal(r.status, 422, r.raw);
      assert.equal(r.json.reason, "INVALID_TERMS_VERSION");
    }
  });

  test("stored card, both terms permit: charged once on issue; every other gate still applies", async () => {
    const card = await saveCard("Agent", w.X.agent.user.id);
    const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id, agreementTermsVersion: TERMS.agreementImmediate, mandateTermsVersion: TERMS.mandateImmediate });
    assert.equal(a.activated.status, 200, a.activated.raw);
    const { c, collection } = await issued(a.id, "CardImmediate");
    assert.equal(collection.outcome, "card_charged", JSON.stringify(collection));
    assert.equal((await charges(c)).length, 1);
    assert.equal((await request(c.requestId)).status, "PAID");
    assert.equal((await collect(w, w.crew, c)).json.outcome, "already_paid");

    // Immediate terms never bypass settlement / statement gates.
    const c2 = await feeChain(w, a.id, "CardImmediateUnsettled", { settled: false });
    await confirmBoth(w, c2);
    assert.equal((await collect(w, w.crew, c2)).json.code, "SETTLEMENT_NOT_VERIFIED");
    await db.update(transactions).set({ status: "Settled", settlementCompletedAt: new Date() }).where(eq(transactions.id, c2.transactionId));
    assert.equal((await collect(w, w.crew, c2)).json.code, "SETTLEMENT_STATEMENT_NOT_ISSUED", "no statement -> no collection, even with immediate terms");
    assert.equal((await charges(c2)).length, 0);
  });

  test("the card path itself refuses to charge inside a notice period (defence in depth)", async () => {
    const card = await saveCard("Agent", w.X.agent.user.id);
    const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
    const { c, collection } = await issued(a.id, "CardNoticeDefence");
    assert.equal(collection.outcome, "notice_started");
    const { pcFeeAuthorities } = await import("@aee/db");
    const [auth] = await db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, a.id));
    await assert.rejects(chargeServiceFeeStoredCard({ paymentRequestId: c.requestId, authority: auth!, actorUserId: null, trigger: "collect" }), /notice period/);
    assert.equal((await charges(c)).length, 0);
  });
});
