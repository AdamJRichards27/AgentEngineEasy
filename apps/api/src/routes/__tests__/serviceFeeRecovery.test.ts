// Owner t181u (t178-plan slice 7): controlled recovery routes for the AE Pit
// Crew service fee. Brokerage-Administrator-only dispute resolution, waiver
// and write-off of a payment request, and resolution of an UNKNOWN stored-card
// charge (gap G2), each with a reason and evidence, an audit row (value-free)
// and a ledger event that appears in the receipt history (0042 hooks).
// State machine enforced (409), duplicate resolution idempotent, never an
// automatic retry, Owner safeguards preserved (no issue while disputed; only a
// BA corrects an issued statement). Mock provider only. Synthetic data.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { auditLogs, db, documents, financialCardCharges, financialDisputes, financialLedgerEvents, financialPaymentRequests, financialReceipts } from "@aee/db";
import { paymentProvider } from "../../lib/paymentProvider.js";
import { cleanupBrokerages } from "./testSupport.js";
import {
  activeDebitAuthority,
  call,
  CARD_TOKEN_MARKER,
  cardAuthorityViaApi,
  collect,
  confirmBoth,
  elapseNotice,
  elapseRetry,
  feeChain,
  makeWorld,
  prepare,
  prepareAndIssue,
  request,
  saveCard,
  issue,
  type Chain,
  type World,
  type Who,
} from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
let captured = "";
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);

const REASON = "Synthetic recovery reason zebra-quartz";
const NOTE = "Synthetic evidence note heron-violet";
const charges = (c: Chain) => db.select().from(financialCardCharges).where(eq(financialCardCharges.paymentRequestId, c.requestId)).orderBy(financialCardCharges.attemptNo);
const receipts = (c: Chain) => db.select().from(financialReceipts).where(eq(financialReceipts.paymentRequestId, c.requestId)).orderBy(financialReceipts.id);
const ledger = (c: Chain, types: string[]) =>
  db
    .select()
    .from(financialLedgerEvents)
    .where(and(eq(financialLedgerEvents.sourceRecordId, String(c.requestId)), inArray(financialLedgerEvents.eventType, types)));
const RECOVERY_EVENTS = ["PC_FEE_WAIVED", "PC_FEE_WRITTEN_OFF", "PC_FEE_DISPUTE_RESOLVED", "PC_FEE_CARD_CHARGE_RESOLVED"];

const waive = (who: Who, c: Chain, body: Record<string, unknown> = { reason: REASON, evidenceNote: NOTE }) =>
  call(w.baseUrl, "POST", `/financial/payment-requests/${c.requestId}/waive`, who.cookie, body);
const writeOff = (who: Who, c: Chain, body: Record<string, unknown> = { reason: REASON, evidenceNote: NOTE }) =>
  call(w.baseUrl, "POST", `/financial/payment-requests/${c.requestId}/write-off`, who.cookie, body);
const resolveDispute = (who: Who, c: Chain, outcome: string, extra: Record<string, unknown> = {}) =>
  call(w.baseUrl, "POST", `/financial/payment-requests/${c.requestId}/resolve-dispute`, who.cookie, { outcome, reason: REASON, evidenceDocumentId: c.docId, ...extra });
const resolveCharge = (who: Who, chargeId: number, outcome: string, extra: Record<string, unknown> = {}) =>
  call(w.baseUrl, "POST", `/financial/card-charges/${chargeId}/resolve`, who.cookie, { outcome, reason: REASON, evidenceNote: NOTE, ...extra });

/** Chain under `authorityId`, confirmed, statement issued (auto notice), notice elapsed. */
async function ready(authorityId: number, tag: string): Promise<Chain> {
  const c = await feeChain(w, authorityId, tag);
  await confirmBoth(w, c);
  const iss = await prepareAndIssue(w, w.crew, c);
  assert.equal(iss.status, 200, iss.raw);
  assert.equal(iss.json.collection?.outcome, "notice_started", JSON.stringify(iss.json.collection));
  await elapseNotice(c);
  return c;
}

async function cardReady(tag: string): Promise<Chain> {
  const card = await saveCard("Agent", w.X.agent.user.id);
  const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
  assert.equal(a.activated.status, 200, a.activated.raw);
  return ready(a.id, tag);
}

function spyCharges(script?: Array<"Succeeded" | "Failed" | "throw" | "chargedThenThrow">) {
  const original = paymentProvider.chargeStoredMethod.bind(paymentProvider);
  let i = 0;
  return mock.method(paymentProvider, "chargeStoredMethod", async (input: Parameters<typeof original>[0]) => {
    const step = script?.[i++];
    if (step === "Failed") return { providerChargeRef: `mock-failed-${input.idempotencyKey}`, status: "Failed" as const, failureReason: "card_declined" };
    if (step === "throw") throw new Error(`network timeout talking to provider for ${input.paymentMethodProviderRef}`);
    if (step === "chargedThenThrow") {
      await original(input); // t181u(D): the provider took the money, the answer was lost
      throw new Error(`network timeout talking to provider for ${input.paymentMethodProviderRef}`);
    }
    return original(input);
  });
}

/** Charge once with no definite provider answer -> UNKNOWN charge, request PROCESSING. */
async function unknownCharge(tag: string, step: "throw" | "chargedThenThrow" = "throw") {
  const c = await cardReady(tag);
  const spy = spyCharges([step]);
  try {
    const r = await collect(w, w.crew, c);
    assert.equal(r.json.outcome, "card_outcome_unknown", r.raw);
  } finally {
    spy.mock.restore();
  }
  const [charge] = await charges(c);
  assert.equal(charge!.status, "UNKNOWN");
  assert.equal((await request(c.requestId)).status, "PROCESSING");
  return { c, charge: charge! };
}

async function markDisputed(c: Chain) {
  const req = await request(c.requestId);
  await db.update(financialPaymentRequests).set({ status: "DISPUTED", providerStatus: "Disputed" }).where(eq(financialPaymentRequests.id, c.requestId));
  const [d] = await db
    .insert(financialDisputes)
    .values({ brokerageId: w.X.brokerageId, paymentRequestId: c.requestId, disputedAmountCents: req.amountCents, reason: "Disputed by provider (synthetic)", status: "OPEN" })
    .returning();
  return d!;
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
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "Recovery");
});

after(async () => {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t181u slice 7: controlled recovery routes", { concurrency: false }, () => {
  test("access: Pit Crew, listing agent and other agents 403; other brokerage BA 404; nothing changes", async () => {
    const { c, charge } = await unknownCharge("Access");
    const before = await request(c.requestId);
    for (const who of [w.crew, w.crewUnassigned, w.X.agent, w.otherAgent]) {
      assert.equal((await waive(who, c)).status, 403, "waive");
      assert.equal((await writeOff(who, c)).status, 403, "write-off");
      assert.equal((await resolveDispute(who, c, "PAYABLE")).status, 403, "resolve-dispute");
      assert.equal((await resolveCharge(who, charge.id, "SUCCEEDED")).status, 403, "card resolve");
      assert.equal((await call(w.baseUrl, "GET", "/financial/card-charges?status=UNKNOWN", who.cookie)).status, 403, "card list");
    }
    assert.equal((await waive(w.Y.admin, c)).status, 404);
    assert.equal((await writeOff(w.Y.admin, c)).status, 404);
    assert.equal((await resolveDispute(w.Y.admin, c, "PAYABLE")).status, 404);
    assert.equal((await resolveCharge(w.Y.admin, charge.id, "SUCCEEDED")).status, 404);
    const yList = await call(w.baseUrl, "GET", "/financial/card-charges?status=UNKNOWN", w.Y.admin.cookie);
    assert.equal(yList.status, 200);
    assert.ok(!yList.json.cardCharges.some((r: { id: number }) => r.id === charge.id), "other brokerage never sees the charge");
    const xList = await call(w.baseUrl, "GET", "/financial/card-charges?status=UNKNOWN", w.X.admin.cookie);
    assert.ok(xList.json.cardCharges.some((r: { id: number }) => r.id === charge.id));
    assert.ok(!xList.raw.includes(CARD_TOKEN_MARKER));
    const after = await request(c.requestId);
    assert.equal(after.status, before.status);
    assert.equal((await charges(c))[0]!.status, "UNKNOWN");
    assert.equal((await ledger(c, RECOVERY_EVENTS)).length, 0);
  });

  test("waive: reason and evidence required; BA-only; ledger + value-free audit; idempotent; concurrent once; collection stops; only a BA corrects the issued statement", async () => {
    const dd = await activeDebitAuthority(w);
    const c = await feeChain(w, dd.id, "Waive");
    await confirmBoth(w, c);
    const iss = await prepareAndIssue(w, w.crew, c);
    assert.equal(iss.json.collection.outcome, "notice_started");
    assert.equal((await request(c.requestId)).status, "NOTICE_SENT");

    assert.equal((await waive(w.X.admin, c, { evidenceNote: NOTE })).status, 422, "no reason");
    assert.equal((await waive(w.X.admin, c, { reason: "   ", evidenceNote: NOTE })).json.code, "RECOVERY_REASON_REQUIRED");
    assert.equal((await waive(w.X.admin, c, { reason: REASON })).json.code, "RECOVERY_EVIDENCE_REQUIRED");
    const other = await feeChain(w, dd.id, "WaiveOther");
    const foreignDoc = await waive(w.X.admin, c, { reason: REASON, evidenceDocumentId: other.docId });
    assert.equal(foreignDoc.status, 422);
    assert.equal(foreignDoc.json.code, "RECOVERY_EVIDENCE_INVALID");
    assert.equal((await request(c.requestId)).status, "NOTICE_SENT", "refusals change nothing");

    const rs = await Promise.all([1, 2, 3].map(() => waive(w.X.admin, c, { reason: REASON, evidenceDocumentId: c.docId })));
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200], rs.map((r) => r.raw).join("\n"));
    assert.equal(rs.filter((r) => r.json.idempotent === false).length, 1, "exactly one transition");
    const row = await request(c.requestId);
    assert.equal(row.status, "WAIVED");
    assert.equal(row.waivedByUserId, w.X.admin.user.id);
    assert.equal(row.waiveReason, REASON);
    assert.ok(row.waivedAt);
    const ev = await ledger(c, ["PC_FEE_WAIVED"]);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.actorUserId, w.X.admin.user.id);
    assert.equal(ev[0]!.reason, REASON);
    assert.deepEqual((ev[0]!.metadata as Record<string, unknown>).evidence, { kind: "document", documentId: c.docId });

    const again = await waive(w.X.admin, c);
    assert.equal(again.status, 200);
    assert.equal(again.json.idempotent, true);
    assert.equal((await ledger(c, ["PC_FEE_WAIVED"])).length, 1, "replay writes no second event");
    const wo = await writeOff(w.X.admin, c);
    assert.equal(wo.status, 409);
    assert.equal(wo.json.code, "RECOVERY_INVALID_TRANSITION");

    // A waived fee is never collected: the issued statement is now stale (N16) and the request is not collectable.
    const blockedCollect = await collect(w, w.crew, c);
    assert.equal(blockedCollect.status, 409, blockedCollect.raw);
    assert.ok(["SETTLEMENT_STATEMENT_STALE", "SERVICE_FEE_NOT_COLLECTABLE"].includes(blockedCollect.json.code), blockedCollect.raw);
    // Correction of the issued statement: Pit Crew cannot supersede; a BA can, and the waived fee drops off.
    assert.notEqual((await prepare(w, w.crew, c, { supersedeReason: "Synthetic" })).status, 201);
    const v2 = await prepare(w, w.X.admin, c, { supersedeReason: "Fee waived (synthetic)" });
    assert.equal(v2.status, 201, v2.raw);
    assert.ok(!v2.json.lines.some((l: { kind: string }) => l.kind === "PC_SERVICE_FEE"), "waived fee is not on the corrected statement");
    const iss2 = await issue(w, w.X.admin, v2.json.statement.id);
    assert.equal(iss2.status, 200, iss2.raw);
    assert.equal((await request(c.requestId)).status, "WAIVED");
    const after = await collect(w, w.crew, c);
    assert.equal(after.status, 409, after.raw);
    assert.notEqual(after.json.code, "SETTLEMENT_STATEMENT_STALE", "corrected statement no longer carries the fee");

    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.brokerageId, w.X.brokerageId), eq(auditLogs.recordId, String(c.requestId))));
    const done = audits.filter((a) => a.action === "financial_pc_fee_waived");
    assert.equal(done.length, 1);
    const refused = audits.filter((a) => a.action === "financial_pc_fee_recovery_refused");
    assert.ok(refused.length >= 4, `refusal audits: ${refused.length}`);
    const replay = audits.filter((a) => a.action === "financial_pc_fee_recovery_replayed");
    assert.ok(replay.length >= 2);
    for (const a of [...done, ...refused, ...replay]) {
      const v = a.updatedValue ?? "";
      assert.ok(!/amount|cents/i.test(v), `value-free: ${v}`);
      assert.ok(!v.includes("zebra-quartz") && !v.includes("heron-violet"), `no reason/evidence text: ${v}`);
    }
  });

  test("write-off: only after a failed collection; refused while a card charge is unresolved; no new receipt; idempotent", async () => {
    const dd = await activeDebitAuthority(w);
    const early = await ready(dd.id, "WriteOffEarly");
    const r0 = await writeOff(w.X.admin, early);
    assert.equal(r0.status, 409, "NOTICE_SENT is not written off");
    assert.equal(r0.json.code, "RECOVERY_INVALID_TRANSITION");

    const c = await cardReady("WriteOff");
    const spy = spyCharges(["Failed", "Failed", "Failed"]);
    try {
      for (let i = 0; i < 3; i++) {
        if (i > 0) await elapseRetry(c); // t181u(C) backoff
        await collect(w, w.crew, c);
      }
    } finally {
      spy.mock.restore();
    }
    assert.equal((await request(c.requestId)).status, "FAILED");
    const rcBefore = await receipts(c);
    const r = await writeOff(w.X.admin, c);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.json.idempotent, false);
    const row = await request(c.requestId);
    assert.equal(row.status, "WRITTEN_OFF");
    assert.equal(row.writtenOffByUserId, w.X.admin.user.id);
    assert.equal(row.writeOffReason, REASON);
    assert.deepEqual((await receipts(c)).map((x) => x.id), rcBefore.map((x) => x.id), "a write-off is not a payment: no receipt row");
    const ev = await ledger(c, ["PC_FEE_WRITTEN_OFF"]);
    assert.equal(ev.length, 1);
    assert.deepEqual((ev[0]!.metadata as Record<string, unknown>).evidence, { kind: "note", note: NOTE });
    // The ledger event is in the receipt history (0042 hook).
    const detail = await call(w.baseUrl, "GET", `/financial/receipts/${rcBefore.at(-1)!.id}`, w.X.admin.cookie);
    assert.ok(detail.json.history.some((h: { eventType: string }) => h.eventType === "PC_FEE_WRITTEN_OFF"), detail.raw);
    assert.equal((await writeOff(w.X.admin, c)).json.idempotent, true);
    assert.equal((await waive(w.X.admin, c)).status, 409, "written off cannot become waived");

    const { c: c2 } = await unknownCharge("WriteOffUnknown");
    const u1 = await writeOff(w.X.admin, c2);
    assert.equal(u1.status, 409);
    assert.equal(u1.json.code, "RECOVERY_PAYMENT_IN_FLIGHT");
    const u2 = await waive(w.X.admin, c2);
    assert.equal(u2.status, 409);
    assert.equal(u2.json.code, "RECOVERY_PAYMENT_IN_FLIGHT");
  });

  test("disputes: no statement issue while disputed; waive refused; PAYABLE re-opens collection; paid dispute cannot be waived; WRITTEN_OFF closes; idempotent", async () => {
    const dd = await activeDebitAuthority(w);
    const c = await feeChain(w, dd.id, "Dispute");
    await confirmBoth(w, c);
    const dispute = await markDisputed(c);
    const d = await prepare(w, w.X.admin, c);
    const blocked = d.status === 201 ? await issue(w, w.X.admin, d.json.statement.id) : d;
    assert.equal(blocked.status, 409, blocked.raw);
    assert.match(blocked.raw, /PC_FEE_DISPUTED/);
    const wv = await waive(w.X.admin, c);
    assert.equal(wv.status, 409);
    assert.equal(wv.json.code, "RECOVERY_USE_DISPUTE_RESOLUTION");
    assert.equal((await resolveDispute(w.X.admin, c, "SOMETHING")).status, 400);
    assert.equal((await resolveDispute(w.X.admin, c, "PAYABLE", { evidenceDocumentId: undefined })).json.code, "RECOVERY_EVIDENCE_REQUIRED");

    const r = await resolveDispute(w.X.admin, c, "PAYABLE");
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.json.idempotent, false);
    assert.equal((await request(c.requestId)).status, "CALCULATED", "unpaid, never collected -> back to the start of collection");
    const [dRow] = await db.select().from(financialDisputes).where(eq(financialDisputes.id, dispute.id));
    assert.equal(dRow!.status, "RESOLVED_PAYABLE");
    assert.equal(dRow!.resolvedByUserId, w.X.admin.user.id);
    assert.equal(dRow!.resolution, REASON);
    assert.equal((await resolveDispute(w.X.admin, c, "PAYABLE")).json.idempotent, true);
    const other = await resolveDispute(w.X.admin, c, "WAIVED");
    assert.equal(other.status, 409);
    assert.equal(other.json.code, "RECOVERY_NOT_DISPUTED");
    assert.equal((await ledger(c, ["PC_FEE_DISPUTE_RESOLVED"])).length, 1);
    const iss = await prepareAndIssue(w, w.crew, c);
    assert.equal(iss.status, 200, iss.raw);
    assert.equal(iss.json.collection.outcome, "notice_started", "collection re-gated from the start");

    // Unpaid dispute to be written off below: its fee is calculated now, while the direct-debit authority
    // is still the agent's ACTIVE one. cardReady() activates a card authority, which replaces it (one
    // ACTIVE authority per agent, Owner t183u, t201u), and no new fee can be calculated on a REPLACED one.
    const q = await feeChain(w, dd.id, "DisputeWO");

    // Paid then disputed: the money stands unless a refund/reversal is done first.
    const p = await cardReady("DisputePaid");
    assert.equal((await collect(w, w.crew, p)).json.outcome, "card_charged");
    const rcBefore = await receipts(p);
    await markDisputed(p);
    const pw = await resolveDispute(w.X.admin, p, "WAIVED");
    assert.equal(pw.status, 409);
    assert.equal(pw.json.code, "RECOVERY_PAID_REFUND_REQUIRED");
    const pp = await resolveDispute(w.X.admin, p, "PAYABLE");
    assert.equal(pp.status, 200, pp.raw);
    assert.equal((await request(p.requestId)).status, "PAID");
    assert.deepEqual((await receipts(p)).map((x) => x.id), rcBefore.map((x) => x.id), "no duplicate payment receipt");

    // Unpaid dispute written off (its fee chain was built above, before the switch to card).
    const qd = await markDisputed(q);
    const qw = await resolveDispute(w.X.admin, q, "WRITTEN_OFF");
    assert.equal(qw.status, 200, qw.raw);
    assert.equal((await request(q.requestId)).status, "WRITTEN_OFF");
    const [qRow] = await db.select().from(financialDisputes).where(eq(financialDisputes.id, qd.id));
    assert.equal(qRow!.status, "CLOSED");
    assert.equal((await ledger(q, ["PC_FEE_DISPUTE_RESOLVED", "PC_FEE_WRITTEN_OFF"])).length, 2);
  });

  test("UNKNOWN card charge -> SUCCEEDED by a BA with evidence: request PAID, payment receipt, no provider call, idempotent, concurrent once", async () => {
    const { c, charge } = await unknownCharge("UnknownOk", "chargedThenThrow");
    const spy = spyCharges();
    try {
      assert.equal((await resolveCharge(w.X.admin, charge.id, "SUCCEEDED", { reason: "" })).json.code, "RECOVERY_REASON_REQUIRED");
      assert.equal((await resolveCharge(w.X.admin, charge.id, "SUCCEEDED", { evidenceNote: undefined })).json.code, "RECOVERY_EVIDENCE_REQUIRED");
      assert.equal((await resolveCharge(w.X.admin, charge.id, "PENDING")).status, 400);
      const tokenish = await resolveCharge(w.X.admin, charge.id, "SUCCEEDED", { providerChargeRef: "4242 4242 4242 4242" });
      assert.equal(tokenish.status, 422, "a card number is never accepted as a reference");
      const rs = await Promise.all([1, 2, 3].map(() => resolveCharge(w.X.admin, charge.id, "SUCCEEDED", { providerChargeRef: "mock-manual-confirmed-1" })));
      assert.deepEqual(rs.map((r) => r.status), [200, 200, 200], rs.map((r) => r.raw).join("\n"));
      assert.equal(rs.filter((r) => r.json.idempotent === false).length, 1);
      assert.equal(spy.mock.callCount(), 0, "resolution never calls the provider");
    } finally {
      spy.mock.restore();
    }
    const [row] = await charges(c);
    assert.equal(row!.status, "SUCCEEDED");
    assert.equal(row!.providerChargeRef, "mock-manual-confirmed-1");
    assert.ok(row!.completedAt);
    const req = await request(c.requestId);
    assert.equal(req.status, "PAID");
    assert.ok(req.paidAt);
    const rc = await receipts(c);
    assert.equal(rc.length, 1);
    assert.equal(rc[0]!.kind, "PAYMENT_SUCCEEDED");
    assert.equal(rc[0]!.providerReference, "mock-manual-confirmed-1");
    const ev = await ledger(c, ["PC_FEE_CARD_CHARGE_RESOLVED"]);
    assert.equal(ev.length, 1);
    assert.equal((ev[0]!.metadata as Record<string, unknown>).chargeId, charge.id);
    const flip = await resolveCharge(w.X.admin, charge.id, "FAILED");
    assert.equal(flip.status, 409);
    assert.equal(flip.json.code, "CARD_CHARGE_ALREADY_FINAL");
    assert.equal((await collect(w, w.crew, c)).json.outcome, "already_paid");
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.brokerageId, w.X.brokerageId), eq(auditLogs.action, "financial_card_charge_resolved")));
    assert.ok(audits.length >= 1);
    for (const a of audits) {
      assert.ok(!/amount|cents/i.test(a.updatedValue ?? "") && !(a.updatedValue ?? "").includes("heron-violet") && !(a.updatedValue ?? "").includes(CARD_TOKEN_MARKER), a.updatedValue ?? "");
    }
  });

  test("UNKNOWN card charge -> FAILED: failure receipt, RETRY_SCHEDULED, no automatic retry; explicit collect retries once; one SUCCEEDED only", async () => {
    const { c, charge } = await unknownCharge("UnknownFail");
    const spy = spyCharges(["Succeeded", "Succeeded"]);
    try {
      const r = await resolveCharge(w.X.admin, charge.id, "FAILED", { evidenceDocumentId: c.docId, evidenceNote: undefined });
      assert.equal(r.status, 200, r.raw);
      assert.equal(spy.mock.callCount(), 0, "no automatic retry after resolution");
      const req = await request(c.requestId);
      assert.equal(req.status, "RETRY_SCHEDULED");
      assert.equal(req.retryCount, 1);
      const fr = (await receipts(c)).filter((x) => x.kind === "PAYMENT_FAILED");
      assert.equal(fr.length, 1);
      assert.equal(fr[0]!.retryScheduled, true);
      assert.equal((await resolveCharge(w.X.admin, charge.id, "FAILED")).json.idempotent, true);
      await elapseRetry(c); // t181u(C) backoff
      const rs = await Promise.all([1, 2].map(() => collect(w, w.crew, c)));
      assert.equal(rs.filter((x) => x.json.outcome === "card_charged").length, 1, rs.map((x) => x.raw).join("\n"));
      assert.equal(spy.mock.callCount(), 1);
    } finally {
      spy.mock.restore();
    }
    const rows = await charges(c);
    assert.deepEqual(rows.map((x) => [x.attemptNo, x.status]), [[1, "FAILED"], [2, "SUCCEEDED"]]);
    // A PENDING (not UNKNOWN) charge or a charge of another request is never resolved here.
    const [pending] = await db
      .insert(financialCardCharges)
      .values({ ...rows[0]!, id: undefined, attemptNo: 9, idempotencyKey: `t181-pending-${w.suffix}`, status: "PENDING", completedAt: null, providerChargeRef: null, failureMessage: null } as never)
      .returning();
    const pr = await resolveCharge(w.X.admin, pending!.id, "FAILED");
    assert.equal(pr.status, 409);
    assert.equal(pr.json.code, "CARD_CHARGE_NOT_UNKNOWN");
    assert.ok(!captured.includes(CARD_TOKEN_MARKER), "no token in captured logs");
    const docs = await db.select().from(documents).where(eq(documents.id, c.docId));
    assert.equal(docs.length, 1);
  });
});
