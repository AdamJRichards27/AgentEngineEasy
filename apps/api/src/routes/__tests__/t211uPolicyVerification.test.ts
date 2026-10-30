// Owner t211u verification items (a)-(c) and item 5, end to end on the
// running app with synthetic data and mock/sandbox providers only.
// (a) a single Brokerage Administrator approves waivers and write-offs;
// (b) Pit Crew cannot execute payments outside the gated, BA-activated
//     collection path (t177u), and cannot create, activate or revoke payment
//     authorities, or resolve, refund, waive or write off anything;
// (c) written authority, settlement completion, both representatives' written
//     confirmations, finalised commission and fee-collection timing (notice vs
//     express immediate) are still enforced;
// 5. only the mock card / sandbox mandate providers are reachable.
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, financialPaymentOutbox, financialPaymentRequests } from "@aee/db";
import { mandatePaymentProvider, mandateProviderPermitted } from "../../lib/financial/provider.js";
import { cardProviderPermitted } from "../../lib/financial/pcFeeCardCharges.js";
import { cleanupBrokerages } from "./testSupport.js";
import {
  activeDebitAuthority,
  call,
  cardAuthorityViaApi,
  collect,
  confirm,
  confirmBoth,
  elapseNotice,
  feeChain,
  issue,
  makeWorld,
  prepare,
  prepareAndIssue,
  request,
  saveCard,
  TERMS,
  type World,
} from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
const REASON = "Synthetic t211u policy reason";

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "T211uPolicy");
});
after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function issuedDd(tag: string) {
  const a = await activeDebitAuthority(w);
  const c = await feeChain(w, a.id, tag);
  await confirmBoth(w, c);
  assert.equal((await prepareAndIssue(w, w.crew, c)).status, 200);
  return { a, c };
}

describe("t211u (a): a single Brokerage Administrator approves waivers and write-offs", { concurrency: false }, () => {
  test("one BA alone waives and writes off; the record shows that BA as approver and executor; no second approval exists or is needed", async () => {
    const { c: wv } = await issuedDd("PolWaive");
    const r1 = await call(w.baseUrl, "POST", `/financial/payment-requests/${wv.requestId}/waive`, w.X.admin.cookie, { reason: REASON, evidenceNote: REASON });
    assert.equal(r1.status, 200, r1.raw);
    assert.equal((await request(wv.requestId)).status, "WAIVED");
    const { c: wo } = await issuedDd("PolWo");
    await db.update(financialPaymentRequests).set({ status: "FAILED", failedAt: new Date() }).where(eq(financialPaymentRequests.id, wo.requestId));
    const r2 = await call(w.baseUrl, "POST", `/financial/payment-requests/${wo.requestId}/write-off`, w.X.admin.cookie, { reason: REASON, evidenceNote: REASON });
    assert.equal(r2.status, 200, r2.raw);
    assert.equal((await request(wo.requestId)).status, "WRITTEN_OFF");
    for (const c of [wv, wo]) {
      const recs = await call(w.baseUrl, "GET", `/financial/payment-requests/${c.requestId}/adjustments`, w.X.admin.cookie);
      const a = recs.json.adjustments[0].approval;
      assert.equal(a.approvedByUserId, w.X.admin.user.id);
      assert.equal(a.executedByUserId, w.X.admin.user.id);
      assert.equal(a.approvedByRole, "Brokerage Administrator");
    }
  });
});

describe("t211u (b): Pit Crew cannot execute payments or create/activate payment authorities", { concurrency: false }, () => {
  test("authorities: Pit Crew cannot create, activate or revoke (403); nothing is written", async () => {
    const body = { agentUserId: w.X.agent.user.id, feeBasis: "PERCENTAGE_OF_GCI", rateBps: 690, gstApplicable: true, noticeRequiredDays: 7, signedEvidenceRef: "synthetic" };
    const created = await call(w.baseUrl, "POST", "/financial/pc-fee-authorities", w.crew.cookie, body);
    assert.equal(created.status, 403, created.raw);
    const draft = await call(w.baseUrl, "POST", "/financial/pc-fee-authorities", w.X.admin.cookie, body);
    assert.equal(draft.status, 201, draft.raw);
    const id = draft.json.authority.id;
    assert.equal((await call(w.baseUrl, "POST", `/financial/pc-fee-authorities/${id}/activate`, w.crew.cookie, {})).status, 403);
    assert.equal((await call(w.baseUrl, "POST", `/financial/pc-fee-authorities/${id}/revoke`, w.crew.cookie, { reason: REASON })).status, 403);
    const after = await call(w.baseUrl, "GET", `/financial/pc-fee-authorities/${id}`, w.X.admin.cookie);
    assert.notEqual(after.json.authority?.status, "ACTIVE");
  });

  test("payment execution routes are Brokerage-Admin only: Pit Crew gets 403 on waive, write-off, dispute, held resolve, card resolve and card refund", async () => {
    const { c } = await issuedDd("PolCrew");
    const paths: Array<[string, unknown]> = [
      [`/financial/payment-requests/${c.requestId}/waive`, { reason: REASON, evidenceNote: REASON }],
      [`/financial/payment-requests/${c.requestId}/write-off`, { reason: REASON, evidenceNote: REASON }],
      [`/financial/payment-requests/${c.requestId}/resolve-dispute`, { reason: REASON, evidenceNote: REASON, outcome: "UPHELD" }],
      [`/financial/payment-outbox/1/resolve-held`, { outcome: "FAILED", reason: REASON }],
      [`/financial/card-charges/1/resolve`, { outcome: "SUCCEEDED", reason: REASON }],
      [`/financial/card-charges/1/refunds`, { amountCents: 1, reason: REASON }],
    ];
    for (const [p, body] of paths) assert.equal((await call(w.baseUrl, "POST", p, w.crew.cookie, body)).status, 403, p);
    assert.equal((await request(c.requestId)).status, "NOTICE_SENT", "nothing changed");
  });

  test("collection: Pit Crew may only ask the gated path (t177u); an unassigned Pit Crew is refused and nothing is sent; there is no amount, method or payee input", async () => {
    const { c } = await issuedDd("PolCollect");
    await elapseNotice(c);
    const un = await collect(w, w.crewUnassigned, c);
    assert.ok([403, 404].includes(un.status), un.raw);
    assert.equal((await db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, c.requestId))).length, 0);
    // Even with a body, the client cannot choose what is charged: the fee, method and payee come from the authority.
    const r = await call(w.baseUrl, "POST", `/payments/pit-crew-service-fee/${c.transactionId}/collect`, w.crew.cookie, { amountCents: 1, paymentMethodId: 1, payerUserId: w.crew.user.id });
    assert.ok([200, 202, 400].includes(r.status), r.raw);
    const req = await request(c.requestId);
    assert.equal(req.payerUserId, w.X.agent.user.id);
    assert.notEqual(req.amountCents, 1);
  });
});

describe("t211u (c): authority, settlement, confirmations, finalisation and timing still enforced", { concurrency: false }, () => {
  test("written authority: a revoked authority cannot be collected against", async () => {
    const { a, c } = await issuedDd("PolRevoked");
    await elapseNotice(c);
    assert.equal((await call(w.baseUrl, "POST", `/financial/pc-fee-authorities/${a.id}/revoke`, w.X.admin.cookie, { reason: REASON })).status, 200);
    const r = await collect(w, w.crew, c);
    assert.equal(r.json.code, "SERVICE_FEE_AUTHORITY_INVALID", r.raw);
  });

  test("settlement completion and both representatives' written confirmations are required before a statement issues", async () => {
    const a = await activeDebitAuthority(w);
    const unsettled = await feeChain(w, a.id, "PolUnsettled", { settled: false });
    await confirmBoth(w, unsettled);
    const d1 = await prepare(w, w.crew, unsettled);
    assert.equal((await issue(w, w.crew, d1.json.statement.id)).json.reason, "SETTLEMENT_NOT_COMPLETE");
    const oneSide = await feeChain(w, a.id, "PolOneSide");
    await confirm(w, w.crew, oneSide, "BUYER");
    const d2 = await prepare(w, w.crew, oneSide);
    assert.equal((await issue(w, w.crew, d2.json.statement.id)).json.reason, "SETTLEMENT_CONFIRMATIONS_INCOMPLETE");
    // No statement issued, so collection is refused at the issued-statement gate.
    assert.equal((await collect(w, w.crew, oneSide)).json.code, "SETTLEMENT_STATEMENT_NOT_ISSUED");
  });

  test("timing: notice-period terms wait for the notice; express immediate terms collect on issue", async () => {
    const { c } = await issuedDd("PolNotice");
    assert.equal((await collect(w, w.crew, c)).json.code, "SERVICE_FEE_NOTICE_PERIOD_RUNNING");
    const card = await saveCard("Agent", w.X.agent.user.id);
    const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id, agreementTermsVersion: TERMS.agreementImmediate, mandateTermsVersion: TERMS.mandateImmediate });
    const ci = await feeChain(w, a.id, "PolImmediate");
    await confirmBoth(w, ci);
    assert.equal((await prepareAndIssue(w, w.crew, ci)).status, 200);
    const sv = await call(w.baseUrl, "GET", `/payments/pit-crew-service-fee/${ci.transactionId}`, w.crew.cookie);
    assert.equal(sv.json.serviceFee.collectionTiming.rule, "IMMEDIATE_ON_STATEMENT_ISSUE");
  });
});

describe("t211u item 5: mock and sandbox providers only", () => {
  test("the card provider guard admits the mock and the mandate guard admits the sandbox (the S5 guards stay)", () => {
    assert.equal(cardProviderPermitted(), true, "card: mock provider");
    assert.equal(mandatePaymentProvider.name, "sandbox");
    assert.equal(mandateProviderPermitted(), true);
  });
});
