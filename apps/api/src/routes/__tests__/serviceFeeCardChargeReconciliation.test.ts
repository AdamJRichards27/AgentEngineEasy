// Owner t181u(D): Brokerage Administrator reconciliation of UNKNOWN stored-card
// charges. The BA route queries the provider status (mock provider only; any
// other provider fails closed), the resolution must match what the provider
// reports, a mandatory reason is kept, the resolver can never be the person
// who initiated the charge, a receipt and an audit row are written, and
// resolving never charges the card again. Synthetic data, mock provider.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { auditLogs, db, financialCardCharges, financialLedgerEvents, financialReceipts } from "@aee/db";
import { paymentProvider } from "../../lib/paymentProvider.js";
import { runServiceFeeCollectionTick } from "../../lib/financial/serviceFeeScheduler.js";
import { cleanupBrokerages } from "./testSupport.js";
import {
  call,
  CARD_TOKEN_MARKER,
  cardAuthorityViaApi,
  collect,
  confirmBoth,
  elapseNotice,
  feeChain,
  makeWorld,
  prepareAndIssue,
  request,
  saveCard,
  type Chain,
  type Who,
  type World,
} from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
const REASON = "Synthetic reconciliation reason otter-amber";
const NOTE = "Synthetic provider status check (no card data)";
const charges = (c: Chain) => db.select().from(financialCardCharges).where(eq(financialCardCharges.paymentRequestId, c.requestId)).orderBy(financialCardCharges.attemptNo);
const receipts = (c: Chain) => db.select().from(financialReceipts).where(eq(financialReceipts.paymentRequestId, c.requestId)).orderBy(financialReceipts.id);
const resolved = (c: Chain) =>
  db
    .select()
    .from(financialLedgerEvents)
    .where(and(eq(financialLedgerEvents.sourceRecordId, String(c.requestId)), inArray(financialLedgerEvents.eventType, ["PC_FEE_CARD_CHARGE_RESOLVED"])));
const resolve = (who: Who, chargeId: number, outcome: string, extra: Record<string, unknown> = {}) =>
  call(w.baseUrl, "POST", `/financial/card-charges/${chargeId}/resolve`, who.cookie, { outcome, reason: REASON, evidenceNote: NOTE, ...extra });
const status = (who: Who, chargeId: number) => call(w.baseUrl, "GET", `/financial/card-charges/${chargeId}/provider-status`, who.cookie);

/** `charged`: the provider took the money but the answer was lost; otherwise it never reached the card. */
function spyLost(charged: boolean) {
  const original = paymentProvider.chargeStoredMethod.bind(paymentProvider);
  return mock.method(paymentProvider, "chargeStoredMethod", async (input: Parameters<typeof original>[0]) => {
    if (charged) await original(input);
    throw new Error("network timeout");
  });
}

async function cardReady(tag: string): Promise<Chain> {
  const card = await saveCard("Agent", w.X.agent.user.id);
  const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
  assert.equal(a.activated.status, 200, a.activated.raw);
  const c = await feeChain(w, a.id, tag);
  await confirmBoth(w, c);
  const iss = await prepareAndIssue(w, w.crew, c);
  assert.equal(iss.status, 200, iss.raw);
  await elapseNotice(c);
  return c;
}

/** UNKNOWN charge initiated by `who` (default the assigned Pit Crew). */
async function unknownCharge(tag: string, charged: boolean, who: Who = w.crew) {
  const c = await cardReady(tag);
  const spy = spyLost(charged);
  try {
    const r = await collect(w, who, c);
    assert.equal(r.json.outcome, "card_outcome_unknown", r.raw);
  } finally {
    spy.mock.restore();
  }
  const [charge] = await charges(c);
  assert.equal(charge!.status, "UNKNOWN");
  return { c, charge: charge! };
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "Recon");
});

after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t181u(D): BA reconciliation of UNKNOWN card charges", { concurrency: false }, () => {
  test("provider status: BA only (Pit Crew/agents 403, other brokerage 404); mock answer, no token or idempotency key", async () => {
    const { charge } = await unknownCharge("ReconStatus", false);
    for (const who of [w.crew, w.X.agent, w.otherAgent]) assert.equal((await status(who, charge.id)).status, 403);
    assert.equal((await status(w.Y.admin, charge.id)).status, 404);
    const r = await status(w.X.admin, charge.id);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.json.providerStatus, "NotFound");
    assert.equal(r.json.chargeStatus, "UNKNOWN");
    assert.equal(r.json.suggestedOutcome, "FAILED");
    assert.ok(!r.raw.includes(CARD_TOKEN_MARKER) && !r.raw.includes(charge.idempotencyKey), "no token or provider key in the response");
  });

  test("provider took the money: FAILED is refused (outcome mismatch, nothing changes); SUCCEEDED -> PAID, one receipt, never charged again", async () => {
    const { c, charge } = await unknownCharge("ReconCharged", true);
    assert.equal((await status(w.X.admin, charge.id)).json.providerStatus, "Succeeded");
    const spy = mock.method(paymentProvider, "chargeStoredMethod");
    try {
      const bad = await resolve(w.X.admin, charge.id, "FAILED");
      assert.equal(bad.status, 409, bad.raw);
      assert.equal(bad.json.code, "CARD_CHARGE_OUTCOME_MISMATCH");
      assert.equal((await request(c.requestId)).status, "PROCESSING");
      assert.equal((await charges(c))[0]!.status, "UNKNOWN");
      assert.equal((await resolve(w.X.admin, charge.id, "SUCCEEDED", { reason: "" })).json.code, "RECOVERY_REASON_REQUIRED", "reason is mandatory");
      const ok = await resolve(w.X.admin, charge.id, "SUCCEEDED");
      assert.equal(ok.status, 200, ok.raw);
      assert.equal(ok.json.idempotent, false);
      assert.equal((await collect(w, w.crew, c)).json.outcome, "already_paid");
      await runServiceFeeCollectionTick({ brokerageIds: [w.X.brokerageId] });
      assert.equal(spy.mock.callCount(), 0, "resolution and later collects never charge the card again");
    } finally {
      spy.mock.restore();
    }
    assert.equal((await request(c.requestId)).status, "PAID");
    const rc = await receipts(c);
    assert.deepEqual(rc.map((r) => r.kind), ["PAYMENT_SUCCEEDED"]);
    const ev = await resolved(c);
    assert.equal(ev.length, 1);
    const meta = ev[0]!.metadata as Record<string, unknown>;
    assert.equal(meta.providerStatus, "Succeeded");
    assert.equal(meta.outcome, "SUCCEEDED");
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.brokerageId, w.X.brokerageId), eq(auditLogs.action, "financial_card_charge_resolved")));
    const mine = audits.filter((a) => (a.updatedValue ?? "").includes(`"chargeId":${charge.id}`));
    assert.equal(mine.length, 1, "one audit row");
    assert.ok((mine[0]!.updatedValue ?? "").includes('"providerStatus":"Succeeded"'));
  });

  test("provider never charged: SUCCEEDED is refused; FAILED -> failure receipt, RETRY_SCHEDULED with backoff", async () => {
    const { c, charge } = await unknownCharge("ReconNotCharged", false);
    const bad = await resolve(w.X.admin, charge.id, "SUCCEEDED");
    assert.equal(bad.status, 409, bad.raw);
    assert.equal(bad.json.code, "CARD_CHARGE_OUTCOME_MISMATCH");
    const ok = await resolve(w.X.admin, charge.id, "FAILED");
    assert.equal(ok.status, 200, ok.raw);
    const req = await request(c.requestId);
    assert.equal(req.status, "RETRY_SCHEDULED");
    assert.ok(req.nextAttemptAt && req.nextAttemptAt.getTime() > Date.now());
    assert.deepEqual((await receipts(c)).map((r) => r.kind), ["PAYMENT_FAILED"]);
    assert.equal(((await resolved(c))[0]!.metadata as Record<string, unknown>).providerStatus, "NotFound");
  });

  test("separation of duties: the BA who initiated the charge cannot resolve it (403, audited); another BA can; system-initiated charges resolvable by any BA", async () => {
    const { c, charge } = await unknownCharge("ReconSelf", false, w.X.admin);
    assert.equal(charge.initiatedByUserId, w.X.admin.user.id);
    const self = await resolve(w.X.admin, charge.id, "FAILED");
    assert.equal(self.status, 403, self.raw);
    assert.equal(self.json.code, "CARD_CHARGE_RESOLVER_IS_INITIATOR");
    assert.equal((await request(c.requestId)).status, "PROCESSING");
    const refusals = await db.select().from(auditLogs).where(and(eq(auditLogs.brokerageId, w.X.brokerageId), eq(auditLogs.userId, w.X.admin.user.id)));
    assert.ok(refusals.some((a) => (a.updatedValue ?? "").includes("CARD_CHARGE_RESOLVER_IS_INITIATOR")), "refusal audited");
    const other = await resolve(w.admin2, charge.id, "FAILED");
    assert.equal(other.status, 200, other.raw);
    assert.equal((await resolve(w.X.admin, charge.id, "FAILED")).status, 403, "the initiator cannot even replay it");

    // A scheduler (system) charge has no initiator: any BA may resolve it.
    const c2 = await cardReady("ReconSystem");
    const spy = spyLost(false);
    try {
      const t = await runServiceFeeCollectionTick({ brokerageIds: [w.X.brokerageId] });
      assert.ok(t.results.some((x) => x.paymentRequestId === c2.requestId && x.outcome === "card_outcome_unknown"), JSON.stringify(t));
    } finally {
      spy.mock.restore();
    }
    const [sys] = await charges(c2);
    assert.equal(sys!.initiatedByUserId, null);
    assert.equal((await resolve(w.X.admin, sys!.id, "FAILED")).status, 200);
  });

  test("fail closed: when the provider cannot report a status, resolution is refused and nothing changes", async () => {
    const { c, charge } = await unknownCharge("ReconUnavailable", true);
    const p = paymentProvider as unknown as { charged?: unknown };
    const saved = p.charged;
    p.charged = undefined;
    try {
      const s = await status(w.X.admin, charge.id);
      assert.equal(s.status, 200, s.raw);
      assert.equal(s.json.providerStatus, "Unavailable");
      assert.equal(s.json.suggestedOutcome, null);
      const r = await resolve(w.X.admin, charge.id, "SUCCEEDED");
      assert.equal(r.status, 409, r.raw);
      assert.equal(r.json.code, "CARD_CHARGE_PROVIDER_STATUS_UNAVAILABLE");
    } finally {
      p.charged = saved;
    }
    assert.equal((await request(c.requestId)).status, "PROCESSING");
    assert.equal((await charges(c))[0]!.status, "UNKNOWN");
  });
});
