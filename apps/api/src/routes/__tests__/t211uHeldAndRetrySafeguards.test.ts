// Owner t211u items 2-3 and 5. One Brokerage Administrator may resolve a
// reviewable hold with a required justification, but resolution never
// overrides the payment-authority, compliance (issued statement) or
// duplicate-payment safeguards. Automatic retry happens only when the request
// definitively never reached the provider; anything uncertain is held. Every
// provider call carries an idempotency key. Mock/sandbox providers only.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { db, financialPaymentOutbox, settlementStatements } from "@aee/db";
import { MandateProviderNotReachedError } from "@aee/integration-mandate-payments";
import { mandatePaymentProvider } from "../../lib/financial/provider.js";
import { cancelScheduledDebit, dispatchOutboxEntry } from "../../lib/financial/paymentOutbox.js";
import { cleanupBrokerages } from "./testSupport.js";
import { activeDebitAuthority, call, collect, confirmBoth, elapseNotice, feeChain, makeWorld, prepareAndIssue, request, type Chain, type Who, type World } from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
const JUSTIFICATION = "Synthetic: checked the sandbox provider record";
const entriesOf = async (c: Chain) => db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, c.requestId));
const entryOf = async (c: Chain) => (await entriesOf(c))[0]!;
const resolve = (who: Who, entryId: number, body: Record<string, unknown>) => call(w.baseUrl, "POST", `/financial/payment-outbox/${entryId}/resolve-held`, who.cookie, body);

async function dueDd(tag: string) {
  const a = await activeDebitAuthority(w);
  const c = await feeChain(w, a.id, tag);
  await confirmBoth(w, c);
  assert.equal((await prepareAndIssue(w, w.crew, c)).status, 200);
  await elapseNotice(c);
  return { a, c };
}
/** A held dispatch. accept-then-throw: the provider HAS the debit; throw: it never got it. */
async function held(tag: string, behaviour: "accept-then-throw" | "throw") {
  const { a, c } = await dueDd(tag);
  const original = mandatePaymentProvider.scheduleDebit.bind(mandatePaymentProvider);
  const spy = mock.method(mandatePaymentProvider, "scheduleDebit", async (input: Parameters<typeof original>[0]) => {
    if (behaviour === "accept-then-throw") await original(input);
    throw new Error("network timeout");
  });
  try {
    await collect(w, w.crew, c);
  } finally {
    spy.mock.restore();
  }
  const e = await entryOf(c);
  assert.match(e.lastError ?? "", /^HELD_UNCERTAIN: /);
  return { a, c, entryId: e.id };
}
/** Count every send-type provider call made while fn runs. */
async function sendsDuring<T>(fn: () => Promise<T>): Promise<{ result: T; sends: number }> {
  const spy = mock.method(mandatePaymentProvider, "scheduleDebit", mandatePaymentProvider.scheduleDebit.bind(mandatePaymentProvider));
  try {
    const result = await fn();
    return { result, sends: spy.mock.callCount() };
  } finally {
    spy.mock.restore();
  }
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "T211uHeld");
});
after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t211u item 2: one Brokerage Administrator resolves holds; no override of mandatory safeguards", { concurrency: false }, () => {
  test("a single BA resolves with a justification (required); resolving sends nothing and can never create a second debit", async () => {
    const h = await held("HSingle", "accept-then-throw");
    assert.equal((await resolve(w.X.admin, h.entryId, { outcome: "SCHEDULED", reason: "  " })).status, 400);
    assert.equal((await resolve(w.X.admin, h.entryId, { outcome: "SCHEDULED" })).status, 400);
    const { result: r, sends } = await sendsDuring(() => resolve(w.X.admin, h.entryId, { outcome: "SCHEDULED", reason: JUSTIFICATION }));
    assert.equal(r.status, 200, r.raw);
    assert.equal(sends, 0, "resolution never sends");
    assert.equal((await request(h.c.requestId)).status, "DEBIT_SCHEDULED");
    // Duplicate-payment safeguard: collecting again, re-dispatching the entry, or resolving again never sends.
    const again = await sendsDuring(async () => {
      const col = await collect(w, w.crew, h.c);
      await dispatchOutboxEntry(await entryOf(h.c));
      const res2 = await resolve(w.admin2, h.entryId, { outcome: "SCHEDULED", reason: JUSTIFICATION });
      return { col, res2 };
    });
    assert.equal(again.sends, 0);
    assert.equal(again.result.res2.json.code, "HELD_DEBIT_NOT_HELD");
    assert.equal((await entriesOf(h.c)).length, 1, "one debit instruction per fee");
  });

  test("resolution cannot bypass an invalid payment authority", async () => {
    const h = await held("HRevoked", "accept-then-throw");
    assert.equal((await call(w.baseUrl, "POST", `/financial/pc-fee-authorities/${h.a.id}/revoke`, w.X.admin.cookie, { reason: "Synthetic revoke" })).status, 200);
    const r = await resolve(w.admin2, h.entryId, { outcome: "SCHEDULED", reason: JUSTIFICATION });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.json.code, "HELD_DEBIT_AUTHORITY_INVALID");
    assert.equal((await request(h.c.requestId)).status, "PROCESSING", "nothing changed");
    assert.match((await entryOf(h.c)).lastError ?? "", /^HELD_UNCERTAIN: /, "still held");
  });

  test("resolution cannot bypass the compliance gate: the fee's statement must still be the issued one", async () => {
    const h = await held("HSuperseded", "accept-then-throw");
    const [s] = await db.select().from(settlementStatements).where(and(eq(settlementStatements.transactionId, h.c.transactionId), eq(settlementStatements.status, "ISSUED")));
    // The issued statement is withdrawn (ISSUED -> SUPERSEDED, the transition the 0041 trigger permits) and no new one is issued yet.
    await db.update(settlementStatements).set({ status: "SUPERSEDED", supersededAt: new Date(), supersededByUserId: w.X.admin.user.id }).where(eq(settlementStatements.id, s!.id));
    const r = await resolve(w.admin2, h.entryId, { outcome: "SCHEDULED", reason: JUSTIFICATION });
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.json.code, "HELD_DEBIT_STATEMENT_NOT_ISSUED");
    assert.equal((await request(h.c.requestId)).status, "PROCESSING");
  });

  test("resolved FAILED stays failed: collect, re-dispatch and the sweep path never resend it", async () => {
    const h = await held("HFailed", "throw");
    assert.equal((await resolve(w.X.admin, h.entryId, { outcome: "FAILED", reason: JUSTIFICATION })).status, 200);
    const { sends } = await sendsDuring(async () => {
      await collect(w, w.crew, h.c);
      await dispatchOutboxEntry(await entryOf(h.c));
    });
    assert.equal(sends, 0);
    assert.equal((await request(h.c.requestId)).status, "FAILED");
    assert.equal((await entriesOf(h.c)).length, 1);
  });

  test("a held entry is never dispatched, even if handed straight to the dispatcher", async () => {
    const h = await held("HDirect", "throw");
    const e = await entryOf(h.c);
    const { sends } = await sendsDuring(() => dispatchOutboxEntry(e));
    assert.equal(sends, 0);
    assert.match((await entryOf(h.c)).lastError ?? "", /^HELD_UNCERTAIN: /);
  });
});

describe("t211u item 3: retry only on definitive never-reached evidence; idempotency keys on every call", { concurrency: false }, () => {
  test("provider reports the request never left (definitive): retried later with the SAME idempotency key, then dispatched once", async () => {
    const { c } = await dueDd("RNotReached");
    const keys: string[] = [];
    const spy = mock.method(mandatePaymentProvider, "scheduleDebit", async (input: { idempotencyKey: string }) => {
      keys.push(input.idempotencyKey);
      throw new MandateProviderNotReachedError("connection refused before the request was sent");
    });
    try {
      await collect(w, w.crew, c);
    } finally {
      spy.mock.restore();
    }
    const e = await entryOf(c);
    assert.equal(e.status, "PENDING", "definitively not sent: eligible for automatic retry");
    assert.match(e.lastError ?? "", /^PRE_DISPATCH: /);
    assert.ok(e.nextAttemptAt.getTime() > Date.now(), "after backoff");
    assert.equal(e.heldByUserId, null);
    const out = await dispatchOutboxEntry(e);
    assert.equal(out.outboxEntry.status, "DISPATCHED");
    const rec = await mandatePaymentProvider.lookupDebit!(e.idempotencyKey);
    assert.ok(rec, "the provider got it under the same key");
    assert.deepEqual(keys, [e.idempotencyKey]);
  });

  test("any other provider error is uncertain: held, not retried", async () => {
    const h = await held("RUncertain", "throw");
    const e = await entryOf(h.c);
    assert.equal(e.status, "FAILED");
    assert.equal((await request(h.c.requestId)).status, "PROCESSING");
  });

  test("provider accepted but AE failed to record it: held (never retried), and the BA can confirm it as scheduled", async () => {
    const { c } = await dueDd("RPostProvider");
    // Make AE's own write after the provider call fail, for this fee only.
    const fn = `t211u_fail_${c.requestId}`;
    await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic local write failure'; END; $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${fn} BEFORE UPDATE ON financial_payment_outbox FOR EACH ROW WHEN (OLD.payment_request_id = ${c.requestId} AND NEW.status = 'DISPATCHED') EXECUTE FUNCTION ${fn}()`));
    let sends = 0;
    try {
      ({ sends } = await sendsDuring(() => collect(w, w.crew, c)));
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON financial_payment_outbox`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
    }
    assert.equal(sends, 1);
    const e = await entryOf(c);
    assert.equal(e.status, "FAILED");
    assert.match(e.lastError ?? "", /^HELD_UNCERTAIN: /);
    const r = await resolve(w.X.admin, e.id, { outcome: "SCHEDULED", reason: JUSTIFICATION });
    assert.equal(r.status, 200, r.raw);
  });

  test("a dispatch interrupted after claiming the send (process died) is held by the next dispatch, never resent; a fresh claim is left alone", async () => {
    const { c } = await dueDd("RInterrupted");
    const spy = mock.method(mandatePaymentProvider, "scheduleDebit", async () => {
      throw new MandateProviderNotReachedError("connection refused before the request was sent");
    });
    try {
      await collect(w, w.crew, c);
    } finally {
      spy.mock.restore();
    }
    // Simulate a dispatcher that claimed the send and then vanished: fresh claim first, then a stale one.
    const claimAt = (ms: number) =>
      db.update(financialPaymentOutbox).set({ lastError: `IN_FLIGHT: ${new Date(ms).toISOString()}`, updatedAt: new Date(ms), nextAttemptAt: new Date(ms) }).where(eq(financialPaymentOutbox.paymentRequestId, c.requestId));
    await claimAt(Date.now());
    const fresh = await sendsDuring(async () => dispatchOutboxEntry(await entryOf(c)));
    assert.equal(fresh.sends, 0);
    assert.equal((await entryOf(c)).status, "PENDING", "a running claim is not touched");
    await claimAt(Date.now() - 60 * 60 * 1000);
    const stale = await sendsDuring(async () => dispatchOutboxEntry(await entryOf(c)));
    assert.equal(stale.sends, 0);
    const e = await entryOf(c);
    assert.equal(e.status, "FAILED");
    assert.match(e.lastError ?? "", /^HELD_UNCERTAIN: .*interrupted/);
    assert.equal((await request(c.requestId)).status, "PROCESSING");
  });

  test("cancel passes an idempotency key to the provider", async () => {
    const { c } = await dueDd("RCancel");
    await collect(w, w.crew, c);
    assert.equal((await request(c.requestId)).status, "DEBIT_SCHEDULED");
    const seen: unknown[] = [];
    const spy = mock.method(mandatePaymentProvider, "cancelScheduledDebit", async (...args: unknown[]) => {
      seen.push(args[1]);
    });
    try {
      await cancelScheduledDebit({ paymentRequestId: c.requestId, reason: "Synthetic cancel", actorUserId: w.X.admin.user.id });
    } finally {
      spy.mock.restore();
    }
    assert.equal(seen.length, 1);
    assert.match(String((seen[0] as { idempotencyKey?: string })?.idempotencyKey ?? ""), /\S{8,}/);
  });

  test("static: every provider send/cancel/reverse/charge/refund call site passes an idempotency key", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (n === "__tests__" || n === "node_modules") continue;
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(root);
    const callRe = /(mandatePaymentProvider|paymentProvider)\.(scheduleDebit|cancelScheduledDebit|reverseDebit|chargeStoredMethod|refund)\(/g;
    let found = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(callRe)) {
        found += 1;
        const window = src.slice(m.index!, m.index! + 600);
        const end = window.indexOf(");");
        assert.match(window.slice(0, end > 0 ? end : 600), /idempotencyKey/, `${f.slice(root.length)}: ${m[0]} without an idempotency key`);
      }
    }
    assert.ok(found >= 5, `found ${found} provider call sites`);
  });
});
