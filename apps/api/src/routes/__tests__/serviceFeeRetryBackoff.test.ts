// Owner t181u(C): safe retry delays for the Pit Crew service fee (stored card).
// A declined charge schedules the next attempt with exponential backoff
// (next_attempt_at, capped). A retry happens only through the collection
// scheduler or an explicit, fully re-gated collect, and never before
// next_attempt_at (fail closed, 409 SERVICE_FEE_RETRY_NOT_DUE, no provider
// call). An UNKNOWN charge is never auto-retried. Synthetic data, mock provider.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, financialCardCharges } from "@aee/db";
import { paymentProvider } from "../../lib/paymentProvider.js";
import { cleanupBrokerages } from "./testSupport.js";
import {
  call,
  cardAuthorityViaApi,
  collect,
  confirmBoth,
  elapseNotice,
  elapseRetry,
  feeChain,
  makeWorld,
  prepareAndIssue,
  request,
  saveCard,
  type Chain,
  type World,
} from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let w: World;
const MIN = 60_000;
const charges = (c: Chain) => db.select().from(financialCardCharges).where(eq(financialCardCharges.paymentRequestId, c.requestId)).orderBy(financialCardCharges.attemptNo);

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

function spyCharges(script?: Array<"Succeeded" | "Failed" | "throw">) {
  const original = paymentProvider.chargeStoredMethod.bind(paymentProvider);
  let i = 0;
  return mock.method(paymentProvider, "chargeStoredMethod", async (input: Parameters<typeof original>[0]) => {
    const step = script?.[i++];
    if (step === "Failed") return { providerChargeRef: `mock-failed-${input.idempotencyKey}`, status: "Failed" as const, failureReason: "card_declined" };
    if (step === "throw") throw new Error("network timeout");
    return original(input);
  });
}

function assertNear(actual: Date | null, expectedMs: number, label: string) {
  assert.ok(actual, `${label}: next_attempt_at set`);
  assert.ok(Math.abs(actual!.getTime() - expectedMs) < 2 * MIN, `${label}: ${actual!.toISOString()} vs ${new Date(expectedMs).toISOString()}`);
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "Backoff");
});

after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("t181u(C): safe retry delays", { concurrency: false }, () => {
  test("exponential backoff schedule with a cap", async () => {
    const { cardRetryDelayMs, nextCardRetryAt, CARD_RETRY_BASE_MS, CARD_RETRY_CAP_MS } = await import("../../lib/financial/retryBackoff.js");
    assert.equal(CARD_RETRY_BASE_MS, 30 * MIN);
    assert.equal(CARD_RETRY_CAP_MS, 24 * 60 * MIN);
    assert.deepEqual([1, 2, 3, 4].map(cardRetryDelayMs), [30 * MIN, 60 * MIN, 120 * MIN, 240 * MIN]);
    assert.equal(cardRetryDelayMs(10), CARD_RETRY_CAP_MS, "capped");
    assert.equal(cardRetryDelayMs(1000), CARD_RETRY_CAP_MS, "no overflow");
    assert.equal(cardRetryDelayMs(0), CARD_RETRY_BASE_MS, "never shorter than the base");
    const now = new Date("2026-10-25T10:00:00Z");
    assert.equal(nextCardRetryAt(now, 2).getTime(), now.getTime() + 60 * MIN);
  });

  test("a decline sets next_attempt_at; an early explicit collect is refused (409 RETRY_NOT_DUE, no provider call); once due it retries exactly once", async () => {
    const c = await cardReady("BackoffEarly");
    const spy = spyCharges(["Failed", "Failed", "Succeeded", "Succeeded"]);
    try {
      const t0 = Date.now();
      const first = await collect(w, w.crew, c);
      assert.equal(first.json.outcome, "card_failed_retry_scheduled", first.raw);
      const r1 = await request(c.requestId);
      assert.equal(r1.status, "RETRY_SCHEDULED");
      assertNear(r1.nextAttemptAt, t0 + 30 * MIN, "attempt 1");

      const early = await collect(w, w.crew, c);
      assert.equal(early.status, 409, early.raw);
      assert.equal(early.json.code, "SERVICE_FEE_RETRY_NOT_DUE");
      assert.equal(spy.mock.callCount(), 1, "no provider call before next_attempt_at");
      assert.equal((await charges(c)).length, 1, "no charge row written for an early retry");

      await elapseRetry(c);
      const t1 = Date.now();
      const second = await collect(w, w.crew, c);
      assert.equal(second.json.outcome, "card_failed_retry_scheduled", second.raw);
      assertNear((await request(c.requestId)).nextAttemptAt, t1 + 60 * MIN, "attempt 2 doubles");

      await elapseRetry(c);
      const rs = await Promise.all([1, 2, 3].map(() => collect(w, w.crew, c)));
      assert.equal(rs.filter((r) => r.json.outcome === "card_charged").length, 1, rs.map((r) => r.raw).join("\n"));
      assert.equal(spy.mock.callCount(), 3);
    } finally {
      spy.mock.restore();
    }
    const done = await request(c.requestId);
    assert.equal(done.status, "PAID");
    assert.equal(done.nextAttemptAt, null, "cleared once a charge is attempted/paid");
    assert.deepEqual((await charges(c)).map((x) => x.status), ["FAILED", "FAILED", "SUCCEEDED"]);
  });

  test("exhausted retries end FAILED with no next_attempt_at", async () => {
    const c = await cardReady("BackoffExhaust");
    const spy = spyCharges(["Failed", "Failed", "Failed"]);
    try {
      for (let i = 0; i < 3; i++) {
        if (i > 0) await elapseRetry(c);
        await collect(w, w.crew, c);
      }
    } finally {
      spy.mock.restore();
    }
    const r = await request(c.requestId);
    assert.equal(r.status, "FAILED");
    assert.equal(r.nextAttemptAt, null);
  });

  test("UNKNOWN is never auto-retried: request stays PROCESSING with no next_attempt_at; collect is a no-op", async () => {
    const c = await cardReady("BackoffUnknown");
    const spy = spyCharges(["throw", "Succeeded"]);
    try {
      const r = await collect(w, w.crew, c);
      assert.equal(r.json.outcome, "card_outcome_unknown", r.raw);
      const again = await collect(w, w.crew, c);
      assert.equal(again.json.outcome, "already_in_progress", again.raw);
      assert.equal(spy.mock.callCount(), 1);
    } finally {
      spy.mock.restore();
    }
    const req = await request(c.requestId);
    assert.equal(req.status, "PROCESSING");
    assert.equal(req.nextAttemptAt, null);
  });

  test("a BA resolving an UNKNOWN charge FAILED schedules the retry with the same backoff", async () => {
    const c = await cardReady("BackoffResolve");
    const spy = spyCharges(["throw"]);
    try {
      assert.equal((await collect(w, w.crew, c)).json.outcome, "card_outcome_unknown");
    } finally {
      spy.mock.restore();
    }
    const [charge] = await charges(c);
    const t0 = Date.now();
    const res = await call(w.baseUrl, "POST", `/financial/card-charges/${charge!.id}/resolve`, w.X.admin.cookie, {
      outcome: "FAILED",
      reason: "Synthetic: provider confirmed no charge was taken",
      evidenceNote: "Synthetic provider dashboard check (no card data)",
    });
    assert.equal(res.status, 200, res.raw);
    const req = await request(c.requestId);
    assert.equal(req.status, "RETRY_SCHEDULED");
    assertNear(req.nextAttemptAt, t0 + 30 * MIN, "resolve FAILED");
    const early = await collect(w, w.crew, c);
    assert.equal(early.json.code, "SERVICE_FEE_RETRY_NOT_DUE", early.raw);
  });
});
