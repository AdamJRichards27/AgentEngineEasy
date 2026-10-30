// Shared t212u test helpers (synthetic data, sandbox provider only).
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { db, financialPaymentOutbox, pcFeeAuthorities } from "@aee/db";
import { eq } from "drizzle-orm";
import type { SandboxMandatePaymentProvider } from "@aee/integration-mandate-payments";
import { mandatePaymentProvider } from "../../lib/financial/provider.js";
import { processMandatePaymentWebhook } from "../../lib/financial/paymentWebhooks.js";
import { reconcileProviderManagedDebits } from "../../lib/financial/ddReconciliation.js";
import { activeDebitAuthority, collect, confirmBoth, elapseNotice, feeChain, makeWorld, prepareAndIssue, request, type Chain, type World } from "./serviceFeeStatementFixtures.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32 ? process.env.SESSION_SECRET : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.MANDATE_PAYMENT_WEBHOOK_SECRET = "test-only-mandate-payment-webhook-secret";
process.env.MANDATE_PAYMENT_WEBHOOKS_ENABLED = "true";

export const sandbox = () => mandatePaymentProvider as unknown as SandboxMandatePaymentProvider;
export const REASON = "Synthetic: BA reviewed the provider record";
export const EVIDENCE = { evidenceRef: "synthetic-evidence-ref-0001" };

export async function startWorld(tag: string): Promise<{ server: Server; w: World }> {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  const w = await makeWorld(`http://127.0.0.1:${address.port}`, tag);
  return { server, w };
}

let authorityId: number | null = null;
export async function dueDd(w: World, tag: string): Promise<Chain> {
  const [cur] = authorityId == null ? [] : await db.select().from(pcFeeAuthorities).where(eq(pcFeeAuthorities.id, authorityId));
  if (!cur || cur.status !== "ACTIVE") authorityId = (await activeDebitAuthority(w)).id;
  const c = await feeChain(w, authorityId!, tag);
  await confirmBoth(w, c);
  assert.equal((await prepareAndIssue(w, w.crew, c)).status, 200);
  await elapseNotice(c);
  return c;
}
export async function scheduledDd(w: World, tag: string) {
  const c = await dueDd(w, tag);
  await collect(w, w.crew, c);
  const r = await request(c.requestId);
  assert.equal(r.status, "DEBIT_SCHEDULED");
  return { c, ref: r.providerRequestRef! };
}
export const reconcile = (w: World) => reconcileProviderManagedDebits({ brokerageIds: [w.X.brokerageId] });
export async function retryingDd(w: World, tag: string) {
  const s = await scheduledDd(w, tag);
  sandbox().simulateDebitStatus(s.ref, { status: "RetryScheduled", attempt: 1, nextAttemptAt: new Date(Date.now() + 86_400_000), failureReason: "insufficient_funds" });
  await reconcile(w);
  assert.equal((await request(s.c.requestId)).status, "RETRY_SCHEDULED");
  return s;
}
export async function finallyFailedDd(w: World, tag: string) {
  const s = await scheduledDd(w, tag);
  sandbox().simulateDebitStatus(s.ref, { status: "Failed", attempt: 3, final: true, failureReason: "insufficient_funds" });
  await reconcile(w);
  assert.equal((await request(s.c.requestId)).status, "FAILED");
  return s;
}
let evt = 0;
export async function webhook(ref: string, status: "Paid" | "Failed" | "Processing") {
  const payload: Record<string, unknown> = { providerEventId: `evt-t212u-${Date.now()}-${++evt}`, providerRequestRef: ref, status };
  const raw = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000);
  const sig = `t=${ts},v1=${createHmac("sha256", process.env.MANDATE_PAYMENT_WEBHOOK_SECRET!).update(`${ts}.${raw}`).digest("hex")}`;
  return { result: await processMandatePaymentWebhook(raw, sig, payload), providerEventId: payload.providerEventId as string };
}
/** Count provider send-type calls (debit schedule) while fn runs. */
export async function sendsDuring<T>(fn: () => Promise<T>): Promise<{ result: T; sends: number }> {
  const spy = mock.method(mandatePaymentProvider, "scheduleDebit", mandatePaymentProvider.scheduleDebit.bind(mandatePaymentProvider));
  try {
    const result = await fn();
    return { result, sends: spy.mock.callCount() };
  } finally {
    spy.mock.restore();
  }
}
export const outboxOf = async (requestId: number) => db.select().from(financialPaymentOutbox).where(eq(financialPaymentOutbox.paymentRequestId, requestId));
