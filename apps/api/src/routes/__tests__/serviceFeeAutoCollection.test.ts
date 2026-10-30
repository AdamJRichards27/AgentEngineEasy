// Owner t180u(1) (slice 4): issuing the final settlement statement starts
// the gated Pit Crew service-fee collection automatically; the collection
// gate reads the real ISSUED statement (0041) and re-verifies confirmations
// and finalised figures at collection time. Synthetic data only.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, financialPaymentOutbox, financialPaymentRequests, pcFeeAuthorities, transactionFees, transactions } from "@aee/db";
import { cleanupBrokerages, forceAuthorityFixture } from "./testSupport.js";
import { activeDebitAuthority, call, collect, confirm, confirmBoth, elapseNotice, feeChain, issue, makeWorld, prepare, prepareAndIssue, request, type World } from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
let authorityId: number;
const outbox = async (id: number) => db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, id));

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "AutoCollect");
  authorityId = (await activeDebitAuthority(w)).id;
});

after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t180u slice 4: statement issue drives collection", { concurrency: false }, () => {
  test("real gate: no issued statement -> no collection (manual call refused, nothing queued)", async () => {
    const c = await feeChain(w, authorityId, "NoStatement");
    const r = await collect(w, w.crew, c);
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.json.code, "SETTLEMENT_STATEMENT_NOT_ISSUED");
    assert.equal((await request(c.requestId)).status, "CALCULATED");
    // A DRAFT statement is not enough either.
    await confirmBoth(w, c);
    await prepare(w, w.crew, c);
    assert.equal((await collect(w, w.crew, c)).json.code, "SETTLEMENT_STATEMENT_NOT_ISSUED");
  });

  test("no collection before settlement or both written confirmations (issue itself is refused, nothing starts)", async () => {
    const c = await feeChain(w, authorityId, "NotSettled", { settled: false });
    await confirm(w, w.crew, c, "BUYER");
    const d = await prepare(w, w.crew, c);
    assert.equal((await issue(w, w.crew, d.json.statement.id)).json.reason, "SETTLEMENT_NOT_COMPLETE");
    await db.update(transactions).set({ status: "Settled", settlementCompletedAt: new Date() }).where(eq(transactions.id, c.transactionId));
    assert.equal((await issue(w, w.crew, d.json.statement.id)).json.reason, "SETTLEMENT_CONFIRMATIONS_INCOMPLETE");
    assert.equal((await request(c.requestId)).status, "CALCULATED");
    assert.equal((await outbox(c.requestId)).length, 0);
  });

  test("D2: issuing by assigned Pit Crew starts collection automatically (notice), audited; the debit follows the notice period exactly once", async () => {
    const c = await feeChain(w, authorityId, "Auto");
    await confirmBoth(w, c);
    const r = await prepareAndIssue(w, w.crew, c);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.json.collection.outcome, "notice_started");
    assert.equal((await request(c.requestId)).status, "NOTICE_SENT");
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "pit_crew_service_fee_auto_collection"), eq(auditLogs.recordId, String(c.transactionId))));
    const v = JSON.parse(audit!.updatedValue!);
    assert.equal(v.trigger, "statement_issued");
    assert.equal(v.statementId, r.json.statement.id);
    assert.equal(v.policy, "t180u");
    assert.ok(!audit!.updatedValue!.includes("sandbox-mandate"), "no mandate reference in audit");
    // Notice period still applies after issue (N1).
    assert.equal((await collect(w, w.crew, c)).json.code, "SERVICE_FEE_NOTICE_PERIOD_RUNNING");
    await elapseNotice(c);
    const results = await Promise.all([1, 2, 3, 4].map(() => collect(w, w.crew, c)));
    assert.ok(results.every((x) => x.status === 200 || x.status === 202), results.map((x) => x.raw).join("|"));
    const rows = await outbox(c.requestId);
    assert.equal(rows.filter((o) => o.action === "SCHEDULE_DEBIT").length, 1, "exactly one debit under concurrency");
  });

  test("listing agent may issue; auto-collection runs on the system trigger (agents still cannot call collect)", async () => {
    const c = await feeChain(w, authorityId, "AgentIssue");
    await confirmBoth(w, c, w.X.agent);
    const r = await prepareAndIssue(w, w.X.agent, c);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.json.collection.outcome, "notice_started");
    assert.equal((await collect(w, w.X.agent, c)).status, 404);
  });

  test("drift after issue refuses collection: confirmations no longer match, or figures changed (fees not finalised)", async () => {
    const c = await feeChain(w, authorityId, "Drift");
    await confirmBoth(w, c);
    await prepareAndIssue(w, w.crew, c);
    await elapseNotice(c);
    const [txn] = await db.select().from(transactions).where(eq(transactions.id, c.transactionId));
    await db.update(transactions).set({ legalRepresentatives: { buyerSolicitorPartyId: c.sellerRep, sellerSolicitorPartyId: c.sellerRep } }).where(eq(transactions.id, c.transactionId));
    assert.equal((await collect(w, w.crew, c)).json.code, "SETTLEMENT_CONFIRMATIONS_INCOMPLETE");
    await db.update(transactions).set({ legalRepresentatives: txn!.legalRepresentatives }).where(eq(transactions.id, c.transactionId));
    await db.insert(transactionFees).values({ brokerageId: w.X.brokerageId, propertyId: c.propertyId, transactionId: c.transactionId, kind: "DEDUCTION", description: "Late courier (synthetic)", amountCents: 1_000, createdByUserId: w.X.admin.user.id });
    assert.equal((await collect(w, w.crew, c)).json.code, "SETTLEMENT_STATEMENT_STALE");
    assert.equal((await outbox(c.requestId)).length, 0);
  });

  test("a revoked or expired authority is refused at issue-time auto-collection and on manual collect", async () => {
    const c = await feeChain(w, authorityId, "Revoked");
    await confirmBoth(w, c);
    await db.update(pcFeeAuthorities).set({ revokedAt: new Date(), status: "REVOKED" }).where(eq(pcFeeAuthorities.id, authorityId));
    try {
      const r = await prepareAndIssue(w, w.crew, c);
      assert.equal(r.status, 200, "the statement still issues");
      assert.equal(r.json.collection.code, "SERVICE_FEE_AUTHORITY_INVALID");
      assert.equal((await request(c.requestId)).status, "CALCULATED");
      const refused = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "pit_crew_service_fee_auto_collection_refused"), eq(auditLogs.recordId, String(c.transactionId))));
      assert.equal(refused.length, 1);
      await forceAuthorityFixture(authorityId, { revokedAt: null, status: "ACTIVE", expiresAt: new Date(Date.now() - 1000) });
      assert.equal((await collect(w, w.crew, c)).json.code, "SERVICE_FEE_AUTHORITY_INVALID");
    } finally {
      await forceAuthorityFixture(authorityId, { revokedAt: null, status: "ACTIVE", expiresAt: null });
    }
  });

  test("a corrected statement (BA v2) never re-collects an already-paid fee", async () => {
    const c = await feeChain(w, authorityId, "Corrected");
    await confirmBoth(w, c);
    await prepareAndIssue(w, w.crew, c);
    await db.update(financialPaymentRequests).set({ status: "PAID", paidAt: new Date() }).where(eq(financialPaymentRequests.id, c.requestId));
    const v2 = await prepareAndIssue(w, w.X.admin, c, { supersedeReason: "Corrected marketing description" });
    assert.equal(v2.status, 200, v2.raw);
    assert.equal(v2.json.collection.outcome, "already_paid");
    assert.equal((await request(c.requestId)).status, "PAID");
    assert.equal((await outbox(c.requestId)).length, 0);
  });

  test("cross-brokerage: another brokerage cannot collect (404) or read the statement", async () => {
    const c = await feeChain(w, authorityId, "Cross");
    assert.equal((await collect(w, w.Y.admin, c)).status, 404);
    assert.equal((await call(w.baseUrl, "GET", `/financial/settlement-statements?transactionId=${c.transactionId}`, w.Y.admin.cookie)).status, 404);
  });
});
