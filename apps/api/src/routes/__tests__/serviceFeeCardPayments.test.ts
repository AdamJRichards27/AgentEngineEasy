// Owner t180u(3) (slice 6): stored-card and brokerage payments for the AE Pit
// Crew service fee. Single nominated method (D8, no fallback), brokerage card
// only with Brokerage Administrator approval under a signed mandate (D3),
// mock provider only, exactly one charge under concurrency, failure receipt +
// controlled retry with no double debit, no card data anywhere. Synthetic data.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  db,
  financialCardCharges,
  financialPaymentOutbox,
  financialReceipts,
  paymentMethods,
  payments,
  pcFeeAuthorities,
  serviceOrders,
} from "@aee/db";
import { paymentProvider } from "../../lib/paymentProvider.js";
import { reverseDebit, scheduleDebitForPaymentRequest } from "../../lib/financial/paymentOutbox.js";
import { cleanupBrokerages } from "./testSupport.js";
import {
  activeDebitAuthority,
  call,
  CARD_TOKEN_MARKER,
  cardAuthorityViaApi,
  collect,
  confirmBoth,
  elapseNotice,
  feeChain,
  makeWorld,
  prepare,
  prepareAndIssue,
  request,
  saveCard,
  issue,
  type Chain,
  type World,
} from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
let captured = "";
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);

function dbErr(re: RegExp) {
  return (e: unknown) => {
    const err = e as { message?: string; cause?: { message?: string; constraint?: string } };
    assert.match(`${err.message} ${err.cause?.message ?? ""} ${err.cause?.constraint ?? ""}`, re);
    return true;
  };
}
const charges = (c: Chain) => db.select().from(financialCardCharges).where(eq(financialCardCharges.paymentRequestId, c.requestId)).orderBy(financialCardCharges.attemptNo);
const outbox = (c: Chain) => db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, c.requestId));
const receipts = (c: Chain) => db.select().from(financialReceipts).where(eq(financialReceipts.paymentRequestId, c.requestId)).orderBy(financialReceipts.id);

/** Chain under `authorityId`, confirmed, statement issued (auto notice), notice elapsed. */
async function ready(authorityId: number, tag: string, payer: Record<string, unknown> = {}): Promise<Chain> {
  const c = await feeChain(w, authorityId, tag);
  await confirmBoth(w, c);
  const iss = await prepareAndIssue(w, w.crew, c, payer);
  assert.equal(iss.status, 200, iss.raw);
  assert.equal(iss.json.collection?.outcome, "notice_started", JSON.stringify(iss.json.collection));
  await elapseNotice(c);
  return c;
}

/** Count real provider calls while delegating to the mock (or a scripted result). */
function spyCharges(script?: Array<"Succeeded" | "Failed" | "throw">) {
  const original = paymentProvider.chargeStoredMethod.bind(paymentProvider);
  let i = 0;
  return mock.method(paymentProvider, "chargeStoredMethod", async (input: Parameters<typeof original>[0]) => {
    const step = script?.[i++];
    if (step === "Failed") return { providerChargeRef: `mock-failed-${input.idempotencyKey}`, status: "Failed" as const, failureReason: "card_declined: insufficient_funds on 4242 4242 4242 4242" };
    if (step === "throw") throw new Error(`network timeout talking to provider for ${input.paymentMethodProviderRef}`);
    return original(input);
  });
}

before(async () => {
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured += String(chunk);
    return (origOut as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    captured += String(chunk);
    return (origErr as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "Cards");
});

after(async () => {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t180u slice 6: stored-card and brokerage payments", { concurrency: false }, () => {
  test("agent card: no charge before the notice elapses; 5 concurrent collects -> exactly one charge; card receipt; no fallback outbox; corrected statement does not re-collect", async () => {
    const card = await saveCard("Agent", w.X.agent.user.id);
    const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
    assert.equal(a.activated.status, 200, a.activated.raw);
    assert.equal(a.activated.json.authority.status, "ACTIVE");
    assert.equal(a.activated.json.authority.hasMandate, false);
    assert.ok(!a.created.raw.includes(CARD_TOKEN_MARKER) && !a.activated.raw.includes(CARD_TOKEN_MARKER), "no token in authority responses");

    const c = await feeChain(w, a.id, "AgentCard");
    await confirmBoth(w, c);
    const spy = spyCharges();
    try {
      const iss = await prepareAndIssue(w, w.crew, c);
      assert.equal(iss.json.collection.outcome, "notice_started");
      const early = await collect(w, w.crew, c);
      assert.equal(early.json.code, "SERVICE_FEE_NOTICE_PERIOD_RUNNING");
      assert.equal(spy.mock.callCount(), 0, "no card charge during the notice period");
      await elapseNotice(c);
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => collect(w, w.crew, c)));
      const outcomes = results.map((r) => r.json.outcome);
      assert.equal(outcomes.filter((o) => o === "card_charged").length, 1, JSON.stringify(outcomes));
      assert.ok(outcomes.every((o) => ["card_charged", "already_in_progress", "already_paid"].includes(o)), JSON.stringify(outcomes));
      assert.equal(spy.mock.callCount(), 1, "provider charged exactly once");
    } finally {
      spy.mock.restore();
    }
    const rows = await charges(c);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "SUCCEEDED");
    assert.equal(rows[0]!.payerType, "Agent");
    assert.equal((await request(c.requestId)).status, "PAID");
    assert.equal((await outbox(c)).length, 0, "no direct-debit outbox row for a card authority");
    const view = await call(w.baseUrl, "GET", `/payments/pit-crew-service-fee/${c.transactionId}`, w.crew.cookie);
    assert.deepEqual(view.json.serviceFee.paymentMethod, { type: "STORED_CARD", label: "Visa ending 4242" });
    assert.ok(!view.raw.includes(CARD_TOKEN_MARKER));
    const rc = await receipts(c);
    assert.equal(rc.length, 1);
    assert.equal(rc[0]!.kind, "PAYMENT_SUCCEEDED");
    assert.equal(rc[0]!.paymentMethodType, "STORED_CARD");
    assert.equal(rc[0]!.paymentMethodLabel, "Visa ending 4242");
    assert.ok(!JSON.stringify(rc).includes(CARD_TOKEN_MARKER));
    const pdf = await fetch(`${w.baseUrl}/api/financial/receipts/${rc[0]!.id}/pdf`, { headers: { cookie: w.X.agent.cookie } });
    const bytes = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
    assert.ok(bytes.includes("Visa ending 4242") && !bytes.includes(CARD_TOKEN_MARKER));
    assert.equal((await collect(w, w.crew, c)).json.outcome, "already_paid");

    // N9 correction by a BA: the paid fee is not collected again.
    const v2 = await prepare(w, w.X.admin, c, { supersedeReason: "Synthetic correction" });
    assert.equal(v2.status, 201, v2.raw);
    const iss2 = await issue(w, w.X.admin, v2.json.statement.id);
    assert.equal(iss2.status, 200, iss2.raw);
    assert.equal(iss2.json.collection.outcome, "already_paid");
    assert.equal((await charges(c)).length, 1, "no second card charge after a corrected statement");
  });

  test("wrong payer or wrong method is refused at authority creation (and by the database)", async () => {
    const brokerageCard = await saveCard("Brokerage", w.X.brokerageId, "Mastercard ending 5454");
    const otherAgentsCard = await saveCard("Agent", w.otherAgent.user.id, "Visa ending 1111");
    const yCard = await saveCard("Brokerage", w.Y.brokerageId, "Visa ending 9999");
    const agentCard = await saveCard("Agent", w.X.agent.user.id, "Visa ending 4242");
    const base = { agentUserId: w.X.agent.user.id, feeBasis: "PERCENTAGE_OF_GCI", rateBps: 690, signedEvidenceRef: "synthetic" };
    const post = (body: Record<string, unknown>, who = w.X.admin) => call(w.baseUrl, "POST", "/financial/pc-fee-authorities", who.cookie, { ...base, ...body });
    const cases: Array<[string, Record<string, unknown>, number]> = [
      ["agent authority on the brokerage card", { authorisedPaymentMethod: "STORED_CARD", payerType: "Agent", paymentMethodId: brokerageCard.id }, 422],
      ["agent authority on another agent's card", { authorisedPaymentMethod: "STORED_CARD", payerType: "Agent", paymentMethodId: otherAgentsCard.id }, 422],
      ["brokerage authority on an agent card", { authorisedPaymentMethod: "STORED_CARD", payerType: "Brokerage", paymentMethodId: agentCard.id }, 422],
      ["brokerage authority on another brokerage's card", { authorisedPaymentMethod: "STORED_CARD", payerType: "Brokerage", paymentMethodId: yCard.id }, 422],
      ["card authority without a card", { authorisedPaymentMethod: "STORED_CARD", payerType: "Agent" }, 422],
      ["direct debit that also names a card (two methods)", { authorisedPaymentMethod: "GENERAL_ACCOUNT_DEBIT_MANDATE", paymentMethodId: agentCard.id }, 422],
      ["brokerage payer on direct debit", { payerType: "Brokerage" }, 422],
      ["trust/bank account method", { authorisedPaymentMethod: "TRUST_ACCOUNT_DEBIT" }, 400],
    ];
    for (const [name, body, status] of cases) {
      const r = await post(body);
      assert.equal(r.status, status, `${name}: ${r.raw}`);
      assert.ok(!r.raw.includes(CARD_TOKEN_MARKER));
    }
    const inactive = await saveCard("Agent", w.X.agent.user.id, "Visa ending 0000");
    await db.update(paymentMethods).set({ isActive: false }).where(eq(paymentMethods.id, inactive.id));
    assert.equal((await post({ authorisedPaymentMethod: "STORED_CARD", payerType: "Agent", paymentMethodId: inactive.id })).status, 422, "inactive card");
    // Pit Crew and agents cannot author or activate authorities at all.
    assert.equal((await post({ authorisedPaymentMethod: "STORED_CARD", payerType: "Agent", paymentMethodId: agentCard.id }, w.crew)).status, 403);
    assert.equal((await post({ authorisedPaymentMethod: "STORED_CARD", payerType: "Agent", paymentMethodId: agentCard.id }, w.X.agent)).status, 403);
    // Database CHECKs back the service rules.
    await assert.rejects(
      db.insert(pcFeeAuthorities).values({ brokerageId: w.X.brokerageId, agentUserId: w.X.agent.user.id, version: 900, status: "PENDING", authorisedPaymentMethod: "STORED_CARD" }),
      dbErr(/pc_fee_authorities_card_method_check/),
    );
    await assert.rejects(
      db.insert(pcFeeAuthorities).values({ brokerageId: w.X.brokerageId, agentUserId: w.X.agent.user.id, version: 901, status: "PENDING", payerType: "Brokerage" }),
      dbErr(/pc_fee_authorities_brokerage_payer_check/),
    );
    await assert.rejects(
      db.insert(pcFeeAuthorities).values({ brokerageId: w.X.brokerageId, agentUserId: w.X.agent.user.id, version: 902, status: "PENDING", authorisedPaymentMethod: "BANK_TRANSFER" }),
      dbErr(/pc_fee_authorities_method_check/),
    );
  });

  test("brokerage card: refused without independent BA approval and signed mandate; approved -> statement must be addressed to the brokerage; charged once", async () => {
    const card = await saveCard("Brokerage", w.X.brokerageId, "Mastercard ending 5454");
    const self = await cardAuthorityViaApi(w, { payerType: "Brokerage", paymentMethodId: card.id }, w.X.admin, w.X.admin);
    assert.equal(self.activated.status, 403, "the drafter cannot approve");
    const byCrew = await call(w.baseUrl, "POST", `/financial/pc-fee-authorities/${self.id}/activate`, w.crew.cookie, {});
    assert.equal(byCrew.status, 403, "Pit Crew cannot approve");
    const byAgent = await call(w.baseUrl, "POST", `/financial/pc-fee-authorities/${self.id}/activate`, w.X.agent.cookie, {});
    assert.equal(byAgent.status, 403, "an agent cannot approve");
    const byY = await call(w.baseUrl, "POST", `/financial/pc-fee-authorities/${self.id}/activate`, w.Y.admin.cookie, {});
    assert.equal(byY.status, 404, "cross-brokerage approval is 404");
    const withMandate = await call(w.baseUrl, "POST", `/financial/pc-fee-authorities/${self.id}/activate`, w.admin2.cookie, { mandateProviderRef: "sandbox-x", mandateProvider: "sandbox" });
    assert.equal(withMandate.status, 422, "a card authority cannot carry a mandate too (single method)");
    await assert.rejects(
      db.update(pcFeeAuthorities).set({ status: "ACTIVE" }).where(eq(pcFeeAuthorities.id, self.id)),
      dbErr(/pc_fee_authorities_brokerage_approval_check/),
      "the database refuses an ACTIVE brokerage card without approval",
    );
    const noMandate = await cardAuthorityViaApi(w, { payerType: "Brokerage", paymentMethodId: card.id, signedEvidenceRef: null });
    assert.equal(noMandate.activated.status, 409, "no signed brokerage mandate -> refused");

    const ok = await call(w.baseUrl, "POST", `/financial/pc-fee-authorities/${self.id}/activate`, w.admin2.cookie, {});
    assert.equal(ok.status, 200, ok.raw);
    const [row] = await db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, self.id));
    assert.equal(row!.brokerageCardApprovedByUserId, w.admin2.user.id);
    assert.ok(row!.brokerageCardApprovedAt);

    const c = await feeChain(w, self.id, "BrokerageCard");
    await confirmBoth(w, c);
    const toAgent = await prepareAndIssue(w, w.crew, c);
    assert.equal(toAgent.status, 409);
    assert.equal(toAgent.json.code ?? toAgent.json.reason, "STATEMENT_PAYER_MISMATCH", toAgent.raw);
    const d = await prepare(w, w.crew, c, { payerType: "Brokerage", payerUserId: undefined });
    assert.equal(d.status, 201, d.raw);
    const iss = await issue(w, w.crew, d.json.statement.id);
    assert.equal(iss.status, 200, iss.raw);
    assert.equal(iss.json.collection.outcome, "notice_started");
    await elapseNotice(c);
    const spy = spyCharges();
    try {
      const rs = await Promise.all([1, 2, 3].map(() => collect(w, w.crew, c)));
      assert.equal(rs.filter((r) => r.json.outcome === "card_charged").length, 1, rs.map((r) => r.raw).join("\n"));
      assert.equal(spy.mock.callCount(), 1);
    } finally {
      spy.mock.restore();
    }
    const rc = await receipts(c);
    assert.equal(rc.length, 1);
    assert.equal(rc[0]!.payerType, "Brokerage");
    assert.equal(rc[0]!.payerBrokerageId, w.X.brokerageId);
    assert.equal(rc[0]!.paymentMethodLabel, "Mastercard ending 5454");
    assert.equal((await charges(c))[0]!.payerType, "Brokerage");
  });

  test("failed charge: failure receipt (sanitised), controlled retry by a new collect, concurrent retries charge once, never a second success", async () => {
    const card = await saveCard("Agent", w.X.agent.user.id);
    const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
    const c = await ready(a.id, "CardRetry");
    const spy = spyCharges(["Failed", "Succeeded", "Succeeded", "Succeeded"]);
    try {
      const first = await collect(w, w.crew, c);
      assert.equal(first.json.outcome, "card_failed_retry_scheduled", first.raw);
      const req1 = await request(c.requestId);
      assert.equal(req1.status, "RETRY_SCHEDULED");
      assert.equal(req1.retryCount, 1);
      const failRc = (await receipts(c)).filter((r) => r.kind === "PAYMENT_FAILED");
      assert.equal(failRc.length, 1);
      assert.equal(failRc[0]!.retryScheduled, true);
      assert.ok(failRc[0]!.failureMessage!.includes("[redacted]") && !failRc[0]!.failureMessage!.includes("4242 4242"), failRc[0]!.failureMessage!);
      // A statement correction never retries a card by itself.
      const v2 = await prepare(w, w.X.admin, c, { supersedeReason: "Synthetic correction during retry" });
      const iss2 = await issue(w, w.X.admin, v2.json.statement.id);
      assert.equal(iss2.json.collection.outcome, "already_in_progress", iss2.raw);
      assert.equal(spy.mock.callCount(), 1);
      // Controlled retry: concurrent explicit collects -> exactly one new attempt.
      const rs = await Promise.all([1, 2, 3].map(() => collect(w, w.crew, c)));
      assert.equal(rs.filter((r) => r.json.outcome === "card_charged").length, 1, rs.map((r) => r.raw).join("\n"));
      assert.equal(spy.mock.callCount(), 2, "one retry attempt only");
    } finally {
      spy.mock.restore();
    }
    const rows = await charges(c);
    assert.deepEqual(rows.map((r) => [r.attemptNo, r.status]), [[1, "FAILED"], [2, "SUCCEEDED"]]);
    assert.notEqual(rows[0]!.idempotencyKey, rows[1]!.idempotencyKey);
    assert.equal(rows.filter((r) => r.status === "SUCCEEDED").length, 1);
    await assert.rejects(db.update(financialCardCharges).set({ status: "PENDING" }).where(eq(financialCardCharges.id, rows[1]!.id)), dbErr(/immutable/));
    await assert.rejects(
      db.insert(financialCardCharges).values({ ...rows[1]!, id: undefined, attemptNo: 3, idempotencyKey: `dup-${w.suffix}` } as never),
      dbErr(/financial_card_charges_one_succeeded_uq/),
      "database refuses a second SUCCEEDED charge",
    );
    const kinds = (await receipts(c)).map((r) => r.kind);
    assert.deepEqual(kinds.sort(), ["PAYMENT_FAILED", "PAYMENT_SUCCEEDED"]);
    assert.equal((await outbox(c)).length, 0);
    await assert.rejects(reverseDebit({ paymentRequestId: c.requestId, reason: "synthetic" }), /stored card/, "card fee is never reversed through the mandate path");
  });

  test("no fallback: exhausted card failures end FAILED with no direct debit; inactive card refuses; DD authority never charges a card", async () => {
    const card = await saveCard("Agent", w.X.agent.user.id);
    const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
    const c = await ready(a.id, "CardExhaust");
    const spy = spyCharges(["Failed", "Failed", "Failed", "Failed"]);
    try {
      const outcomes: string[] = [];
      for (let i = 0; i < 3; i++) outcomes.push((await collect(w, w.crew, c)).json.outcome);
      assert.deepEqual(outcomes, ["card_failed_retry_scheduled", "card_failed_retry_scheduled", "card_failed_final"]);
      const after = await collect(w, w.crew, c);
      assert.equal(after.json.code, "SERVICE_FEE_NOT_COLLECTABLE");
      assert.equal(spy.mock.callCount(), 3);
    } finally {
      spy.mock.restore();
    }
    assert.equal((await request(c.requestId)).status, "FAILED");
    assert.equal((await outbox(c)).length, 0, "no fallback to the direct-debit mandate");
    await assert.rejects(scheduleDebitForPaymentRequest({ paymentRequestId: c.requestId }));
    const finalRc = (await receipts(c)).filter((r) => r.kind === "PAYMENT_FAILED");
    assert.equal(finalRc.length, 3);
    assert.equal(finalRc.at(-1)!.retryScheduled, false);

    // Card withdrawn after activation -> refused, nothing charged, no debit either.
    const card2 = await saveCard("Agent", w.X.agent.user.id);
    const a2 = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card2.id });
    const c2 = await ready(a2.id, "CardWithdrawn");
    await db.update(paymentMethods).set({ isActive: false }).where(eq(paymentMethods.id, card2.id));
    const r2 = await collect(w, w.crew, c2);
    assert.equal(r2.json.code, "SERVICE_FEE_AUTHORITY_INVALID", r2.raw);
    assert.equal((await charges(c2)).length + (await outbox(c2)).length, 0);

    // Direct-debit authority: the agent's saved card is never touched.
    await saveCard("Agent", w.X.agent.user.id, "Visa ending 7777");
    const dd = await activeDebitAuthority(w);
    const c3 = await ready(dd.id, "DebitOnly");
    const spy3 = spyCharges();
    try {
      const r3 = await collect(w, w.crew, c3);
      assert.ok(["debit_scheduled", "debit_queued"].includes(r3.json.outcome), r3.raw);
      assert.equal(spy3.mock.callCount(), 0);
    } finally {
      spy3.mock.restore();
    }
    assert.equal((await charges(c3)).length, 0);
    assert.equal((await outbox(c3)).filter((o) => o.action === "SCHEDULE_DEBIT").length, 1);
  });

  test("provider gave no answer -> UNKNOWN, never retried automatically; live provider refused; revoked/expired authority refused", async () => {
    const card = await saveCard("Agent", w.X.agent.user.id);
    const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
    const c = await ready(a.id, "CardUnknown");
    const spy = spyCharges(["throw", "Succeeded"]);
    try {
      const r = await collect(w, w.crew, c);
      assert.equal(r.json.outcome, "card_outcome_unknown", r.raw);
      assert.equal((await request(c.requestId)).status, "PROCESSING");
      assert.equal((await collect(w, w.crew, c)).json.outcome, "already_in_progress");
      assert.equal(spy.mock.callCount(), 1, "no automatic retry after an unknown outcome");
    } finally {
      spy.mock.restore();
    }
    const [unk] = await charges(c);
    assert.equal(unk!.status, "UNKNOWN");
    assert.ok(!(unk!.failureMessage ?? "").includes(CARD_TOKEN_MARKER), "provider error text (which named the token) is not stored");

    // Live provider: refused before any row is written.
    const card2 = await saveCard("Agent", w.X.agent.user.id);
    const a2 = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card2.id });
    const c2 = await ready(a2.id, "CardLive");
    const proto = Object.getPrototypeOf(paymentProvider);
    Object.setPrototypeOf(paymentProvider, { chargeStoredMethod: proto.chargeStoredMethod }); // not a MockPaymentProvider any more
    try {
      const r2 = await collect(w, w.crew, c2);
      assert.equal(r2.json.code, "SERVICE_FEE_PROVIDER_NOT_PERMITTED", r2.raw);
    } finally {
      Object.setPrototypeOf(paymentProvider, proto);
    }
    assert.equal((await charges(c2)).length, 0);

    // Revoked, then expired, authority.
    const card3 = await saveCard("Agent", w.X.agent.user.id);
    const a3 = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card3.id });
    const c3 = await ready(a3.id, "CardRevoked");
    const rev = await call(w.baseUrl, "POST", `/financial/pc-fee-authorities/${a3.id}/revoke`, w.X.admin.cookie, { reason: "synthetic revoke" });
    assert.equal(rev.status, 200, rev.raw);
    assert.equal((await collect(w, w.crew, c3)).json.code, "SERVICE_FEE_AUTHORITY_INVALID");
    const card4 = await saveCard("Agent", w.X.agent.user.id);
    const a4 = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card4.id });
    const c4 = await ready(a4.id, "CardExpired");
    await db.update(pcFeeAuthorities).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(pcFeeAuthorities.id, a4.id));
    assert.equal((await collect(w, w.crew, c4)).json.code, "SERVICE_FEE_AUTHORITY_INVALID");
    assert.equal((await charges(c3)).length + (await charges(c4)).length, 0);
  });

  test("access: unassigned Pit Crew 403, agent 404, other brokerage 404; Pit Crew service-order charge stays 403; no card data in audit or logs", async () => {
    const card = await saveCard("Agent", w.X.agent.user.id);
    const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
    const c = await ready(a.id, "CardAccess");
    assert.equal((await collect(w, w.crewUnassigned, c)).status, 403);
    assert.equal((await collect(w, w.X.agent, c)).status, 404);
    assert.equal((await collect(w, w.otherAgent, c)).status, 404);
    assert.equal((await collect(w, w.Y.admin, c)).status, 404);
    assert.equal((await charges(c)).length, 0);
    const [so] = await db.insert(serviceOrders).values({ propertyId: c.propertyId, serviceType: "TitleSearch", provider: "mock", wholesaleCostCents: 1000, customerPriceCents: 2000 }).returning();
    const soCharge = await call(w.baseUrl, "POST", `/service-orders/${so!.id}/charge`, w.crew.cookie, {});
    assert.equal(soCharge.status, 403, soCharge.raw);
    assert.equal((await db.select().from(payments).where(eq(payments.serviceOrderId, so!.id))).length, 0);
    await db.delete(serviceOrders).where(eq(serviceOrders.id, so!.id));

    const audit = await db.select().from(auditLogs).where(inArray(auditLogs.brokerageId, [w.X.brokerageId, w.Y.brokerageId]));
    const cardAudits = audit.filter((r) => r.action === "pit_crew_service_fee_card_charge");
    assert.ok(cardAudits.length >= 5, `card-charge audit rows: ${cardAudits.length}`);
    assert.ok(!JSON.stringify(audit).includes(CARD_TOKEN_MARKER), "no provider token or customer reference in audit_logs");
    const allReceipts = await db.select().from(financialReceipts).where(eq(financialReceipts.brokerageId, w.X.brokerageId));
    assert.ok(!JSON.stringify(allReceipts).includes(CARD_TOKEN_MARKER), "no token on any receipt");
    const allCharges = await db.select().from(financialCardCharges).where(eq(financialCardCharges.brokerageId, w.X.brokerageId));
    assert.ok(allCharges.length >= 8);
    assert.ok(!JSON.stringify(allCharges).includes(CARD_TOKEN_MARKER), "no token on card charge rows (FK only, failure text sanitised)");
    assert.ok(!captured.includes(CARD_TOKEN_MARKER), "no token in captured logs");
  });
});
