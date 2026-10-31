// #245 S6: security matrix for every financial route added or changed in
// S1-S5 (roles x tenants x the run.access entitlement flag), input
// validation (never a 5xx on bad input), and no secrets in logs. Also pins
// the read-only retry state the S6 screens show. Synthetic data, mock and
// sandbox providers only.
import { test, before, after, describe, mock } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, financialCardCharges, financialPaymentOutbox, financialReceipts } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { paymentProvider } from "../../lib/paymentProvider.js";
import { mandatePaymentProvider } from "../../lib/financial/provider.js";
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
  MANDATE_REF_PREFIX,
  prepareAndIssue,
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
const REASON = "Synthetic S6 matrix reason";
const EVIDENCE = "synthetic-evidence-ref-S6-do-not-log";
let fx: { card: Chain; dd: Chain; receiptId: number; heldEntryId: number };

async function issuedCard(tag: string) {
  const card = await saveCard("Agent", w.X.agent.user.id);
  const a = await cardAuthorityViaApi(w, { payerType: "Agent", paymentMethodId: card.id });
  const c = await feeChain(w, a.id, tag);
  await confirmBoth(w, c);
  assert.equal((await prepareAndIssue(w, w.crew, c)).status, 200);
  await elapseNotice(c);
  return c;
}
async function heldDd(tag: string) {
  const a = await activeDebitAuthority(w);
  const c = await feeChain(w, a.id, tag);
  await confirmBoth(w, c);
  assert.equal((await prepareAndIssue(w, w.crew, c)).status, 200);
  await elapseNotice(c);
  const spy = mock.method(mandatePaymentProvider, "scheduleDebit", async () => {
    throw new Error("network timeout");
  });
  try {
    await collect(w, w.crew, c);
  } finally {
    spy.mock.restore();
  }
  const [e] = await db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, c.requestId));
  return { c, entryId: e!.id };
}
async function setRunAccess(brokerageId: number, active: boolean) {
  await db.update(entitlementGrants).set({ status: active ? "Active" : "Revoked" }).where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, "run.access")));
  invalidateEntitlementCache(brokerageId);
}
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; text: string }> {
  let text = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const wrap = (real: typeof realOut) =>
    ((chunk: unknown, ...rest: unknown[]) => {
      text += typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
      return (real as (c: unknown, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
  process.stdout.write = wrap(realOut);
  process.stderr.write = wrap(realErr);
  try {
    return { result: await fn(), text };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

/** Every S1-S5 BA route, as [label, method, path, body]. */
const baRoutes = (): Array<[string, string, string, unknown?]> => [
  ["adjustments", "GET", `/financial/payment-requests/${fx.card.requestId}/adjustments`],
  ["waive", "POST", `/financial/payment-requests/${fx.dd.requestId}/waive`, { reason: REASON, evidenceNote: REASON }],
  ["write-off", "POST", `/financial/payment-requests/${fx.dd.requestId}/write-off`, { reason: REASON, evidenceNote: REASON }],
  ["held list", "GET", `/financial/payment-outbox/held`],
  ["resolve held", "POST", `/financial/payment-outbox/${fx.heldEntryId}/resolve-held`, { outcome: "FAILED", reason: REASON }],
  ["authority draft", "POST", `/financial/pc-fee-authorities`, { agentUserId: w.X.agent.user.id, rateBps: 690, signedEvidenceRef: EVIDENCE }],
];

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  w = await makeWorld(`http://127.0.0.1:${address.port}`, "S6Matrix");
  const card = await issuedCard("MxCard");
  assert.equal((await collect(w, w.crew, card)).json.outcome, "card_charged");
  const [rcpt] = await db.select().from(financialReceipts).where(eq(financialReceipts.paymentRequestId, card.requestId));
  const held = await heldDd("MxHeld");
  fx = { card, dd: held.c, receiptId: rcpt!.id, heldEntryId: held.entryId };
});
after(async () => {
  await setRunAccess(w.X.brokerageId, true).catch(() => {});
  await cleanupBrokerages([w?.X?.brokerageId, w?.Y?.brokerageId].filter((id): id is number => typeof id === "number"));
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("S6: financial route security matrix (S1-S5)", { concurrency: false }, () => {
  test("unauthenticated: 401 on every route", async () => {
    for (const [label, method, path, body] of baRoutes()) {
      const r = await call(w.baseUrl, method, path, undefined, body);
      assert.equal(r.status, 401, `${label}: ${r.raw}`);
    }
    for (const path of [`/financial/receipts/${fx.receiptId}`, `/financial/receipts?transactionId=${fx.card.transactionId}`]) assert.equal((await call(w.baseUrl, "GET", path)).status, 401, path);
  });

  test("Pit Crew (assigned and unassigned), listing agent and another agent: 403 on every Brokerage-Admin route", async () => {
    for (const who of [w.crew, w.crewUnassigned, w.X.agent, w.otherAgent] as Who[]) {
      for (const [label, method, path, body] of baRoutes()) {
        const r = await call(w.baseUrl, method, path, who.cookie, body);
        assert.equal(r.status, 403, `${label} as ${who.user.role}: ${r.raw}`);
      }
    }
  });

  test("another tenant's Brokerage Admin: 404 on id routes, nothing of ours in lists", async () => {
    for (const [label, method, path, body] of baRoutes().filter(([l]) => !["held list", "authority draft"].includes(l))) {
      const r = await call(w.baseUrl, method, path, w.Y.admin.cookie, body);
      assert.equal(r.status, 404, `${label}: ${r.raw}`);
    }
    const held = await call(w.baseUrl, "GET", "/financial/payment-outbox/held", w.Y.admin.cookie);
    assert.equal(held.status, 200);
    assert.equal((held.json.held as unknown[]).length, 0);
    const draft = await call(w.baseUrl, "POST", "/financial/pc-fee-authorities", w.Y.admin.cookie, { agentUserId: w.X.agent.user.id, rateBps: 690, signedEvidenceRef: EVIDENCE });
    assert.equal(draft.status, 404, draft.raw);
    for (const path of [`/financial/receipts/${fx.receiptId}`, `/financial/receipts?transactionId=${fx.card.transactionId}`]) assert.equal((await call(w.baseUrl, "GET", path, w.Y.admin.cookie)).status, 404, path);
  });

  test("receipts (statement links): Brokerage Admin, listing agent and assigned Pit Crew read; unassigned Pit Crew and other agents 404", async () => {
    for (const who of [w.X.admin, w.X.agent, w.crew]) {
      const r = await call(w.baseUrl, "GET", `/financial/receipts/${fx.receiptId}`, who.cookie);
      assert.equal(r.status, 200, r.raw);
      assert.ok(r.json.receipt.settlementStatement?.version >= 1, r.raw);
    }
    for (const who of [w.crewUnassigned, w.otherAgent]) assert.equal((await call(w.baseUrl, "GET", `/financial/receipts/${fx.receiptId}`, who.cookie)).status, 404);
  });

  test("run.access entitlement revoked: every route refuses with 403 ENTITLEMENT_MISSING, even for a Brokerage Admin", async () => {
    await setRunAccess(w.X.brokerageId, false);
    try {
      for (const [label, method, path, body] of [...baRoutes(), ["receipt", "GET", `/financial/receipts/${fx.receiptId}`] as [string, string, string]]) {
        const r = await call(w.baseUrl, method, path, w.X.admin.cookie, body);
        assert.equal(r.status, 403, `${label}: ${r.raw}`);
        assert.equal(r.json.reason, "ENTITLEMENT_MISSING", label);
      }
    } finally {
      await setRunAccess(w.X.brokerageId, true);
    }
  });

  test("input validation: bad ids, unknown fields, wrong enums and oversize text are 4xx, never 5xx", async () => {
    const cases: Array<[string, string, unknown?]> = [
      ["/financial/payment-requests/abc/adjustments", "GET"],
      ["/financial/payment-requests/-1/waive", "POST", { reason: REASON }],
      ["/financial/payment-requests/999999999/write-off", "POST", { reason: REASON }],
      ["/financial/payment-outbox/abc/resolve-held", "POST", { outcome: "FAILED", reason: REASON }],
      [`/financial/payment-outbox/${fx.heldEntryId}/resolve-held`, "POST", { outcome: "FAILED", reason: REASON, providerRequestRef: "x" }],
      [`/financial/payment-outbox/${fx.heldEntryId}/resolve-held`, "POST", { outcome: "PAID", reason: REASON }],
      [`/financial/payment-outbox/${fx.heldEntryId}/resolve-held`, "POST", { outcome: "FAILED", reason: "x".repeat(2001) }],
      [`/financial/payment-outbox/${fx.heldEntryId}/resolve-held`, "POST", { outcome: "FAILED", reason: "   " }],
      ["/financial/pc-fee-authorities", "POST", { agentUserId: w.X.agent.user.id, rateBps: 690, agreementTermsVersion: "AE-PCF-AGREEMENT-2026.11", signedEvidenceRef: "" }],
      ["/financial/receipts/abc", "GET"],
      ["/financial/receipts?transactionId=abc", "GET"],
    ];
    for (const [path, method, body] of cases) {
      const r = await call(w.baseUrl, method, path, w.X.admin.cookie, body);
      assert.ok(r.status >= 400 && r.status < 500, `${method} ${path} -> ${r.status} ${r.raw}`);
    }
  });

  test("no secrets in logs: card tokens, mandate refs, signed-evidence refs and the session secret never appear", async () => {
    const { text } = await captureLogs(async () => {
      const c = await issuedCard("MxLogs");
      const spy = mock.method(paymentProvider, "chargeStoredMethod", async () => {
        throw new Error(`gateway timeout for pm_${CARD_TOKEN_MARKER}_leak`);
      });
      try {
        await collect(w, w.crew, c);
      } finally {
        spy.mock.restore();
      }
      const h = await heldDd("MxLogsHeld");
      await call(w.baseUrl, "POST", `/financial/payment-outbox/${h.entryId}/resolve-held`, w.X.admin.cookie, { outcome: "FAILED", reason: REASON });
      await call(w.baseUrl, "POST", "/financial/pc-fee-authorities", w.X.admin.cookie, { agentUserId: w.X.agent.user.id, rateBps: 690, signedEvidenceRef: EVIDENCE });
    });
    for (const secret of [CARD_TOKEN_MARKER, MANDATE_REF_PREFIX, EVIDENCE, process.env.SESSION_SECRET!]) assert.ok(!text.includes(secret), `log leaked ${secret.slice(0, 12)}…`);
  });

  test("screens: the service-fee read exposes retry state (attempts, max, next attempt) and nothing more", async () => {
    const c = await issuedCard("MxRetry");
    const spy = mock.method(paymentProvider, "chargeStoredMethod", async (input: { idempotencyKey: string }) => ({ providerChargeRef: `mock-failed-${input.idempotencyKey}`, status: "Failed" as const, failureReason: "card_declined" }));
    try {
      await collect(w, w.crew, c);
    } finally {
      spy.mock.restore();
    }
    const v = await call(w.baseUrl, "GET", `/payments/pit-crew-service-fee/${c.transactionId}`, w.crew.cookie);
    assert.equal(v.status, 200, v.raw);
    const retry = v.json.serviceFee.retry;
    assert.ok(retry, v.raw);
    assert.equal(retry.attempts, 1);
    assert.equal(retry.maxAttempts, 3);
    assert.ok(Date.parse(retry.nextAttemptAt) > Date.now());
    assert.deepEqual(Object.keys(retry).sort(), ["attempts", "maxAttempts", "nextAttemptAt"]);
    const [charge] = await db.select().from(financialCardCharges).where(eq(financialCardCharges.paymentRequestId, c.requestId));
    assert.ok(!v.raw.includes(charge!.providerChargeRef ?? "never"), "no provider refs in the screen payload");
  });
});
