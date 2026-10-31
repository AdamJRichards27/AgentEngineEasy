// #245 S5: a Brokerage Administrator resolves a HELD_UNCERTAIN debit dispatch
// (Owner t210u hold). The resolution is checked against the sandbox
// provider's own record: SCHEDULED only when the provider has the debit,
// FAILED only when it does not; Unavailable (any non-sandbox provider)
// refuses. Mandatory reason, audited, ledgered; never resends; the user who
// raised the hold (initiated the collect) cannot resolve it. Synthetic data.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, financialLedgerEvents, financialPaymentOutbox } from "@aee/db";
import { mandatePaymentProvider } from "../../lib/financial/provider.js";
import { dispatchPendingPaymentOutbox } from "../../lib/financial/paymentOutbox.js";
import { cleanupBrokerages } from "./testSupport.js";
import { activeDebitAuthority, call, collect, confirmBoth, elapseNotice, feeChain, makeWorld, prepareAndIssue, request, type Chain, type Who, type World } from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
const REASON = "Synthetic: checked the sandbox provider record";
const entryOf = async (c: Chain) => (await db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, c.requestId)))[0]!;
const resolve = (who: Who, entryId: number, body: Record<string, unknown>) => call(w.baseUrl, "POST", `/financial/payment-outbox/${entryId}/resolve-held`, who.cookie, body);

/** A DD fee whose debit send errored. "accept-then-throw": the provider recorded it; "throw": it never did. Raised by `raiser`'s collect. */
async function held(tag: string, behaviour: "accept-then-throw" | "throw", raiser: Who = w.crew) {
  const a = await activeDebitAuthority(w);
  const c = await feeChain(w, a.id, tag);
  await confirmBoth(w, c);
  assert.equal((await prepareAndIssue(w, w.crew, c)).status, 200);
  await elapseNotice(c);
  const original = mandatePaymentProvider.scheduleDebit.bind(mandatePaymentProvider);
  const spy = mock.method(mandatePaymentProvider, "scheduleDebit", async (input: Parameters<typeof original>[0]) => {
    if (behaviour === "accept-then-throw") await original(input);
    throw new Error("network timeout");
  });
  try {
    const r = await collect(w, raiser, c);
    assert.ok([200, 202].includes(r.status), r.raw);
  } finally {
    spy.mock.restore();
  }
  const e = await entryOf(c);
  assert.match(e.lastError ?? "", /^HELD_UNCERTAIN: /);
  return { c, entryId: e.id };
}
const ledgerTypes = async (c: Chain) =>
  (await db.select().from(financialLedgerEvents).where(and(eq(financialLedgerEvents.sourceRecordType, "PAYMENT_REQUEST"), eq(financialLedgerEvents.sourceRecordId, String(c.requestId))))).map((e) => e.eventType);

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "HeldRes");
});
after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("S5: Brokerage Admin resolves a HELD_UNCERTAIN debit", { concurrency: false }, () => {
  test("provider has the debit -> resolve SCHEDULED: DEBIT_SCHEDULED with the provider ref, entry DISPATCHED, audited, no resend", async () => {
    const { c, entryId } = await held("ResSched", "accept-then-throw");
    const spy = mock.method(mandatePaymentProvider, "scheduleDebit");
    try {
      const r = await resolve(w.X.admin, entryId, { outcome: "SCHEDULED", reason: REASON });
      assert.equal(r.status, 200, r.raw);
      assert.equal(r.json.providerStatus, "Found");
      assert.equal(spy.mock.callCount(), 0, "resolution never sends");
    } finally {
      spy.mock.restore();
    }
    const req = await request(c.requestId);
    assert.equal(req.status, "DEBIT_SCHEDULED");
    assert.ok(req.providerRequestRef);
    assert.equal((await entryOf(c)).status, "DISPATCHED");
    assert.ok((await ledgerTypes(c)).includes("PC_FEE_DEBIT_SCHEDULED"));
    const audits = await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "financial_payment_request"), eq(auditLogs.recordId, String(c.requestId))));
    const a = audits.find((x) => x.action === "financial_payment_held_debit_resolved");
    assert.ok(a, JSON.stringify(audits.map((x) => x.action)));
    assert.equal(a!.userId, w.X.admin.user.id);
    assert.match(a!.updatedValue ?? "", /SCHEDULED/);
    const list = await call(w.baseUrl, "GET", "/financial/payment-outbox/held", w.X.admin.cookie);
    assert.ok(!(list.json.held as Array<{ outboxEntryId: number }>).some((h) => h.outboxEntryId === entryId), "no longer listed as held");
  });

  test("provider has no record -> resolve FAILED: request FAILED, failure ledgered, never resent by any sweep", async () => {
    const { c, entryId } = await held("ResFail", "throw");
    const r = await resolve(w.X.admin, entryId, { outcome: "FAILED", reason: REASON });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.json.providerStatus, "NotFound");
    assert.equal((await request(c.requestId)).status, "FAILED");
    assert.ok((await ledgerTypes(c)).includes("PC_FEE_PAYMENT_FAILED"));
    await db.update(financialPaymentOutbox).set({ nextAttemptAt: new Date(Date.now() - 86_400_000) }).where(eq(financialPaymentOutbox.id, entryId));
    const spy = mock.method(mandatePaymentProvider, "scheduleDebit");
    try {
      await dispatchPendingPaymentOutbox(100);
      assert.equal(spy.mock.callCount(), 0);
    } finally {
      spy.mock.restore();
    }
  });

  test("the outcome must match the provider record (409), and an unavailable provider refuses (409)", async () => {
    const x = await held("ResMismatch", "accept-then-throw");
    const m1 = await resolve(w.X.admin, x.entryId, { outcome: "FAILED", reason: REASON });
    assert.equal(m1.status, 409, m1.raw);
    assert.equal(m1.json.code, "HELD_DEBIT_OUTCOME_MISMATCH");
    const y = await held("ResMismatch2", "throw");
    const m2 = await resolve(w.X.admin, y.entryId, { outcome: "SCHEDULED", reason: REASON });
    assert.equal(m2.json.code, "HELD_DEBIT_OUTCOME_MISMATCH", m2.raw);
    const orig = mandatePaymentProvider.name;
    (mandatePaymentProvider as { name: string }).name = "live-bank";
    try {
      const u = await resolve(w.X.admin, y.entryId, { outcome: "FAILED", reason: REASON });
      assert.equal(u.status, 409, u.raw);
      assert.equal(u.json.code, "HELD_DEBIT_PROVIDER_STATUS_UNAVAILABLE");
    } finally {
      (mandatePaymentProvider as { name: string }).name = orig;
    }
    assert.equal((await request(y.c.requestId)).status, "PROCESSING", "nothing changed by refused resolutions");
  });

  test("access and input: reason required; Pit Crew/agent 403; other brokerage 404; a resolved entry cannot be resolved again", async () => {
    const { entryId } = await held("ResAccess", "throw");
    assert.equal((await resolve(w.X.admin, entryId, { outcome: "FAILED" })).status, 400);
    assert.equal((await resolve(w.X.admin, entryId, { outcome: "MAYBE", reason: REASON })).status, 400);
    for (const who of [w.crew, w.X.agent]) assert.equal((await resolve(who, entryId, { outcome: "FAILED", reason: REASON })).status, 403);
    assert.equal((await resolve(w.Y.admin, entryId, { outcome: "FAILED", reason: REASON })).status, 404);
    assert.equal((await resolve(w.X.admin, entryId, { outcome: "FAILED", reason: REASON })).status, 200);
    const again = await resolve(w.admin2, entryId, { outcome: "FAILED", reason: REASON });
    assert.equal(again.status, 409, again.raw);
    assert.equal(again.json.code, "HELD_DEBIT_NOT_HELD");
  });

  test("the Brokerage Admin who raised the hold cannot resolve it; another Brokerage Admin can", async () => {
    const { c, entryId } = await held("ResSoD", "throw", w.X.admin);
    const hold = (await db.select().from(auditLogs).where(and(eq(auditLogs.recordId, String(c.requestId)), eq(auditLogs.action, "financial_payment_debit_dispatch_held"))))[0];
    assert.equal(JSON.parse(hold!.updatedValue ?? "{}").raisedByUserId, w.X.admin.user.id, "the hold records who raised it");
    const self = await resolve(w.X.admin, entryId, { outcome: "FAILED", reason: REASON });
    assert.equal(self.status, 403, self.raw);
    assert.equal(self.json.code, "HELD_DEBIT_RESOLVER_IS_RAISER");
    assert.equal((await resolve(w.admin2, entryId, { outcome: "FAILED", reason: REASON })).status, 200);
  });
});
