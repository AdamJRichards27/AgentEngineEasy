// Owner t183u(3) / #245 S3: payment retry policy.
//  - intervals start at 30 min and double (30m, 1h, 2h, ...) capped at 24 h;
//  - maximum attempts configurable (PC_FEE_MAX_PAYMENT_ATTEMPTS, default 3,
//    1..10, snapshotted onto the payment request at creation);
//  - NEVER auto-retry an uncertain transaction or an invalid authority.
// Mock provider only; synthetic data.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, financialCardCharges, financialPaymentRequests, paymentMethods, pcFeeAuthorities } from "@aee/db";
import { paymentProvider } from "../../lib/paymentProvider.js";
import * as policy from "../../lib/financial/retryBackoff.js";
import { cleanupBrokerages } from "./testSupport.js";
import {
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

const MIN = 60_000;
const HOUR = 60 * MIN;
const ENV = "PC_FEE_MAX_PAYMENT_ATTEMPTS";
let server: Server;
let w: World;
const sched = () => import("../../lib/financial/serviceFeeScheduler.js");
const charges = (c: Chain) => db.select().from(financialCardCharges).where(eq(financialCardCharges.paymentRequestId, c.requestId)).orderBy(financialCardCharges.attemptNo);
const tick = async () => (await sched()).runServiceFeeCollectionTick({ brokerageIds: [w.X.brokerageId] });
const maxAttempts = () => policy.pcFeeMaxPaymentAttempts();

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const orig = process.env[ENV];
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
  try {
    return fn();
  } finally {
    if (orig === undefined) delete process.env[ENV];
    else process.env[ENV] = orig;
  }
}
function assertNear(actual: Date | null, expectedMs: number, label: string) {
  assert.ok(actual, `${label}: next_attempt_at set`);
  assert.ok(Math.abs(actual.getTime() - expectedMs) < 15_000, `${label}: ${actual.toISOString()} vs ${new Date(expectedMs).toISOString()}`);
}
function spyCharges(script?: Array<"Succeeded" | "Failed">) {
  const original = paymentProvider.chargeStoredMethod.bind(paymentProvider);
  let i = 0;
  return mock.method(paymentProvider, "chargeStoredMethod", async (input: Parameters<typeof original>[0]) => {
    const step = script?.[i++];
    if (step === "Failed") return { providerChargeRef: `mock-failed-${input.idempotencyKey}`, status: "Failed" as const, failureReason: "card_declined" };
    return original(input);
  });
}
async function cardAuthority() {
  const card = await saveCard("Agent", w.X.agent.user.id);
  const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
  assert.equal(a.activated.status, 200, a.activated.raw);
  return { authorityId: a.id, cardId: card.id };
}
async function issuedCard(tag: string) {
  const { authorityId, cardId } = await cardAuthority();
  const c = await feeChain(w, authorityId, tag);
  await confirmBoth(w, c);
  const iss = await prepareAndIssue(w, w.crew, c);
  assert.equal(iss.status, 200, iss.raw);
  await elapseNotice(c);
  return { c, authorityId, cardId };
}
/** A card fee whose first charge was declined and whose retry is now DUE. */
async function dueRetry(tag: string) {
  const x = await issuedCard(tag);
  const spy = spyCharges(["Failed"]);
  try {
    assert.equal((await collect(w, w.crew, x.c)).json.outcome, "card_failed_retry_scheduled");
  } finally {
    spy.mock.restore();
  }
  await elapseRetry(x.c);
  return x;
}
async function assertTickNeverCharges(c: Chain, label: string) {
  const spy = spyCharges();
  try {
    const r = await tick();
    assert.equal(spy.mock.callCount(), 0, `${label}: no provider call`);
    const mine = r.results.find((x) => x.paymentRequestId === c.requestId);
    return mine;
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
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "RetryPol");
});
after(async () => {
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("S3 (t183u 3): payment retry policy", { concurrency: false }, () => {
  test("intervals: 30m, 1h, 2h, 4h, 8h, 16h, then capped at 24h", () => {
    const expected = [30 * MIN, HOUR, 2 * HOUR, 4 * HOUR, 8 * HOUR, 16 * HOUR, 24 * HOUR, 24 * HOUR];
    assert.deepEqual(expected.map((_, i) => policy.cardRetryDelayMs(i + 1)), expected);
    assert.equal(policy.cardRetryDelayMs(60), 24 * HOUR, "never exceeds the 24h cap");
  });

  test("max attempts: default 3; PC_FEE_MAX_PAYMENT_ATTEMPTS 1..10 honoured; anything else falls back to the default", () => {
    assert.equal(withEnv(undefined, maxAttempts), 3);
    assert.equal(withEnv("1", maxAttempts), 1);
    assert.equal(withEnv("5", maxAttempts), 5);
    assert.equal(withEnv("10", maxAttempts), 10);
    for (const bad of ["", "0", "-2", "11", "2.5", "abc", "1e3"]) assert.equal(withEnv(bad, maxAttempts), 3, `invalid ${JSON.stringify(bad)}`);
  });

  test("configured attempts are snapshotted at creation and drive the full doubling schedule end to end", async () => {
    const orig = process.env[ENV];
    process.env[ENV] = "5";
    let x: Awaited<ReturnType<typeof issuedCard>>;
    try {
      x = await issuedCard("Pol5");
    } finally {
      if (orig === undefined) delete process.env[ENV];
      else process.env[ENV] = orig;
    }
    const { c } = x;
    assert.equal((await request(c.requestId)).maxRetries, 5, "snapshotted on the request (env change later has no effect)");
    const spy = spyCharges(["Failed", "Failed", "Failed", "Failed", "Failed"]);
    try {
      const expected = [30 * MIN, HOUR, 2 * HOUR, 4 * HOUR];
      for (let i = 0; i < 5; i++) {
        if (i > 0) await elapseRetry(c);
        const t = Date.now();
        const r = i === 0 ? await collect(w, w.crew, c) : await tick();
        const row = await request(c.requestId);
        if (i < 4) {
          assert.equal(row.status, "RETRY_SCHEDULED", JSON.stringify(r));
          assertNear(row.nextAttemptAt, t + expected[i]!, `attempt ${i + 1}`);
        } else {
          assert.equal(row.status, "FAILED", "5th decline exhausts the configured budget");
          assert.equal(row.nextAttemptAt, null);
        }
      }
      assert.equal(spy.mock.callCount(), 5);
      await tick();
      assert.equal(spy.mock.callCount(), 5, "never retried past the configured maximum");
    } finally {
      spy.mock.restore();
    }
    assert.equal((await charges(c)).length, 5);
  });

  test("uncertain: a due RETRY_SCHEDULED fee with an UNKNOWN charge on record is never auto-retried", async () => {
    const { c } = await dueRetry("PolUnknown");
    // FAILED rows are immutable (DB trigger), so model the uncertain state as an in-flight attempt 2 whose outcome is UNKNOWN.
    const [first] = await charges(c);
    await db.insert(financialCardCharges).values({ ...first!, id: undefined, attemptNo: 2, idempotencyKey: `${first!.idempotencyKey}-unknown`, status: "UNKNOWN", providerChargeRef: null, failureMessage: null, completedAt: null, createdAt: new Date() });
    await assertTickNeverCharges(c, "UNKNOWN on record");
    assert.deepEqual((await charges(c)).map((x) => x.status), ["FAILED", "UNKNOWN"], "no new charge row");
  });

  test("uncertain: a PROCESSING fee (outcome unknown) is never picked, even long after it was due", async () => {
    const { c } = await dueRetry("PolProcessing");
    await db.update(financialPaymentRequests).set({ status: "PROCESSING", nextAttemptAt: new Date(Date.now() - 48 * HOUR) }).where(eq(financialPaymentRequests.id, c.requestId));
    const mine = await assertTickNeverCharges(c, "PROCESSING");
    assert.equal(mine, undefined, "not even a candidate");
    assert.equal((await request(c.requestId)).status, "PROCESSING");
  });

  for (const [label, invalidate] of [
    ["revoked", async (x: { authorityId: number }) => db.update(pcFeeAuthorities).set({ status: "REVOKED", revokedAt: new Date() }).where(eq(pcFeeAuthorities.id, x.authorityId))],
    ["expired", async (x: { authorityId: number }) => db.update(pcFeeAuthorities).set({ expiresAt: new Date(Date.now() - MIN) }).where(eq(pcFeeAuthorities.id, x.authorityId))],
    ["replaced by a newer authority", async () => cardAuthority()],
    ["nominated card removed", async (x: { cardId: number }) => db.update(paymentMethods).set({ isActive: false }).where(eq(paymentMethods.id, x.cardId))],
  ] as Array<[string, (x: { authorityId: number; cardId: number }) => Promise<unknown>]>) {
    test(`invalid authority (${label}): a due card retry is never auto-retried; refused and left RETRY_SCHEDULED`, async () => {
      const x = await dueRetry(`PolInv${label.slice(0, 4)}`);
      await invalidate(x);
      const mine = await assertTickNeverCharges(x.c, label);
      assert.equal(mine?.code, "SERVICE_FEE_AUTHORITY_INVALID", JSON.stringify(mine));
      assert.equal((await request(x.c.requestId)).status, "RETRY_SCHEDULED");
      assert.equal((await charges(x.c)).length, 1);
    });
  }
});
