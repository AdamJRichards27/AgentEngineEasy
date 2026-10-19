// WS4-09: request paths driven over real HTTP against createApp() with AEE_RESTORED_ENVIRONMENT on. Each must answer
// 503 { code: "RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED" } (via middlewares/errorHandler.ts) and nothing may leave the
// process (fetch / http(s) / sockets spied; loopback + test DB pass). Switch-off controls show the same paths send.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { installOutboundSpies } from "./fixtures/outboundSpies.js";

process.env.ALLOW_DEV_AUTH = "true";
const spies = installOutboundSpies();
const { db, communicationMessages, users, invitations, passwordResetTokens } = await import("@aee/db");
const { createBrokerageWithUsers, createListedProperty, cleanupBrokerages } = await import("../../routes/__tests__/testSupport.js");
type Login = Awaited<ReturnType<typeof createBrokerageWithUsers>>;

let server: Server;
let baseUrl: string;
let A: Login;
let propertyId: number;
const on = () => { process.env.AEE_RESTORED_ENVIRONMENT = "true"; };
const off = () => { delete process.env.AEE_RESTORED_ENVIRONMENT; };
const h = (cookie?: string) => ({ "content-type": "application/json", ...(cookie ? { cookie } : {}) });
const post = (p: string, body: unknown, cookie?: string) => fetch(`${baseUrl}${p}`, { method: "POST", headers: h(cookie), body: JSON.stringify(body) });

async function expect503(res: Response, channel: string) {
  const text = await res.text();
  assert.equal(res.status, 503, text);
  const body = JSON.parse(text) as { code: string; channel: string; error: string };
  assert.equal(body.code, "RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED");
  assert.equal(body.channel, channel);
  assert.match(body.error, /restored environment/i);
  assert.deepEqual(spies.sends, [], "nothing may leave the process");
}

before(async () => {
  const { configureEvents } = await import("../events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${a.port}`;
  off();
  A = await createBrokerageWithUsers(baseUrl, `WS4-09 Outbound ${Date.now()}`);
  propertyId = (await createListedProperty(baseUrl, A.agent.cookie, { address: `9 Restored Env St ${Date.now()}` })).propertyId;
});
after(async () => {
  off();
  try {
    // Rows this file creates that cleanupBrokerages() does not know about (FKs to users).
    const ids = (await db.select({ id: users.id }).from(users).where(eq(users.brokerageId, A.brokerageId))).map((u) => u.id);
    await db.delete(invitations).where(eq(invitations.brokerageId, A.brokerageId));
    if (ids.length) await db.delete(passwordResetTokens).where(inArray(passwordResetTokens.userId, ids));
    await cleanupBrokerages([A.brokerageId]);
  } finally {
    await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
  }
});
beforeEach(() => { spies.reset(); });

test("POST /api/auth/password-reset/request (existing user): 503 blocked, no reset email; control 202 + sandbox send", async () => {
  const email = await import("../auth/email.js");
  email.__clearSandboxAuthEmailLog();
  on();
  await expect503(await post("/api/auth/password-reset/request", { email: A.admin.user.email }), "auth_email");
  assert.equal(email.__getSandboxAuthEmailLog().length, 0);
  off();
  assert.equal((await post("/api/auth/password-reset/request", { email: A.admin.user.email })).status, 202);
  assert.equal(email.__getSandboxAuthEmailLog().length, 1);
});

test("POST /api/auth/admin/invitations: 503 blocked, no invitation email", async () => {
  const email = await import("../auth/email.js");
  email.__clearSandboxAuthEmailLog();
  on();
  await expect503(await post("/api/auth/admin/invitations", { email: `ws409-invitee-${Date.now()}@example.com`, role: "Agent" }, A.admin.cookie), "auth_email");
  assert.equal(email.__getSandboxAuthEmailLog().length, 0);
});

test("POST /api/financial/ops/dispatch-outbox (manual dispatch): 503 blocked; control 200", async () => {
  on();
  await expect503(await post("/api/financial/ops/dispatch-outbox", {}, A.admin.cookie), "financial_payment_dispatch");
  off();
  const res = await post("/api/financial/ops/dispatch-outbox", {}, A.admin.cookie);
  assert.equal(res.status, 200, await res.text());
});

async function draftEmail(cookie: string): Promise<{ id: number; version: number }> {
  const t = await post(`/api/properties/${propertyId}/communications/threads`, { subject: "Restored env" }, cookie);
  assert.equal(t.status, 201, await t.clone().text());
  const threadId = ((await t.json()) as { id: number }).id;
  const p = await post(`/api/communications/threads/${threadId}/participants/manual`, { displayName: "Sam Seller", role: "Seller", email: `ws409-seller-${Date.now()}@example.com`, reason: "Vendor contact" }, cookie);
  assert.equal(p.status, 201, await p.clone().text());
  const participantId = ((await p.json()) as { id: number }).id;
  const d = await post(`/api/communications/threads/${threadId}/messages`, { channel: "EMAIL", classification: "TRANSACTIONAL", bodyText: "hello", recipientParticipantId: participantId }, cookie);
  assert.equal(d.status, 201, await d.clone().text());
  return (await d.json()) as { id: number; version: number };
}

test("POST /api/communications/messages/:id/send (inline dispatch): 503 blocked, message left QUEUED (never SENDING/SENT); control SENT", async () => {
  const draft = await draftEmail(A.agent.cookie);
  on();
  await expect503(await post(`/api/communications/messages/${draft.id}/send`, { expectedVersion: draft.version }, A.agent.cookie), "communications_email");
  const [row] = await db.select().from(communicationMessages).where(and(eq(communicationMessages.id, draft.id), eq(communicationMessages.brokerageId, A.brokerageId)));
  assert.equal(row!.status, "QUEUED");
  assert.equal(row!.sentAt, null);
  off();
  const draft2 = await draftEmail(A.agent.cookie);
  const res = await post(`/api/communications/messages/${draft2.id}/send`, { expectedVersion: draft2.version }, A.agent.cookie);
  const body = (await res.json()) as { message: { status: string } };
  assert.equal(res.status, 200);
  assert.equal(body.message.status, "SENT");
});

test("global error handler maps the block to 503 + code without alerting (unit)", async () => {
  const { globalErrorHandler } = await import("../../middlewares/errorHandler.js");
  const { RestoredEnvironmentOutboundBlockedError } = await import("../outboundGuard.js");
  let status = 0; let payload: Record<string, unknown> = {};
  const res = { headersSent: false, status(s: number) { status = s; return this; }, json(p: Record<string, unknown>) { payload = p; return this; } };
  globalErrorHandler(new RestoredEnvironmentOutboundBlockedError("esign", "explicit_on"), { method: "POST", path: "/x" } as never, res as never, (() => undefined) as never);
  assert.equal(status, 503);
  assert.equal(payload.code, "RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED");
  assert.equal(payload.channel, "esign");
});
