// WS4-09 + WS4-11: request paths driven over real HTTP against createApp() with AEE_RESTORED_ENVIRONMENT on.
// fetch / http(s) / sockets are spied (loopback + test DB pass; anything else recorded and refused). Blocks answer
// 503 { code: "RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED" }; password reset answers an identical 202 for every address
// (no email, no account-existence oracle); in-process sandbox/mock providers keep working (D-MOCK).
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq, inArray, sql } from "drizzle-orm";
import { installOutboundSpies } from "./fixtures/outboundSpies.js";

process.env.ALLOW_DEV_AUTH = "true";
const spies = installOutboundSpies();
const { db, communicationMessages, users, invitations, passwordResetTokens, entitlementGrants } = await import("@aee/db");
const { invalidateEntitlementCache } = await import("../entitlements/resolver.js");
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
const AI_ENV = ["AI_PROVIDER", "AI_FALLBACK_PROVIDER", "LIVE_AI_PROVIDER_APPROVED", "ANTHROPIC_API_KEY", "AI_RETRY_LIMIT", "AI_DAILY_CAP_ENFORCED", "AI_DAILY_LIMIT_PER_USER", "AI_DAILY_LIMIT_PER_BROKERAGE", "AEE_RESTORED_ENV_OUTBOUND_ALLOW"];
const clearAiEnv = () => { for (const k of AI_ENV) delete process.env[k]; };
beforeEach(() => { spies.reset(); clearAiEnv(); });


// ---------- D-AI ----------
const anthropicEnv = () => Object.assign(process.env, {
  AI_PROVIDER: "anthropic", AI_FALLBACK_PROVIDER: "mock", LIVE_AI_PROVIDER_APPROVED: "true", ANTHROPIC_API_KEY: "test-only-not-a-key", AI_RETRY_LIMIT: "0",
  // A live provider requires configured usage limits (lib/ai/usageLimits.ts); "off" is an explicit decision.
  AI_DAILY_CAP_ENFORCED: "true", AI_DAILY_LIMIT_PER_USER: "off", AI_DAILY_LIMIT_PER_BROKERAGE: "off",
});
const ask = (cookie: string, body: Record<string, unknown> = {}) => post("/api/ai/ask", { question: "How am I tracking?", contextType: null, contextId: null, ...body }, cookie);
async function grantGrowAi(brokerageId: number) {
  for (const entitlementKey of ["grow.access", "grow.ai.use"]) {
    await db.insert(entitlementGrants).values({ brokerageId, entitlementKey, granteeType: "brokerage", granteeId: brokerageId, sourceType: "manual", status: "Active" });
  }
  invalidateEntitlementCache(brokerageId);
}

test("D-AI: POST /api/ai/ask with a network AI provider in a restored env → 503 RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED (not 500), nothing sent", async () => {
  on(); anthropicEnv();
  await expect503(await ask(A.agent.cookie), "ai_provider"); // RUN Copilot path: no entitlement grant needed
  await grantGrowAi(A.brokerageId); // minimal fixture for the Grow-scoped path (grow.access + grow.ai.use)
  await expect503(await ask(A.agent.cookie, { contextType: "grow" }), "ai_provider");
});

test("D-AI/D-MOCK: mock AI answers 200 in a restored env (UAT); allow-listed Anthropic and the switch-off control reach the network", async () => {
  on();
  const m = await ask(A.agent.cookie);
  assert.equal(m.status, 200, await m.clone().text());
  assert.equal(spies.sends.length, 0);
  anthropicEnv(); process.env.AEE_RESTORED_ENV_OUTBOUND_ALLOW = "ai_provider:anthropic";
  await ask(A.agent.cookie);
  assert.ok(spies.sends.some((s) => s.target.includes("api.anthropic.com")), "allow-listed: the spy saw the Anthropic call");
  spies.reset(); delete process.env.AEE_RESTORED_ENV_OUTBOUND_ALLOW; off();
  await ask(A.agent.cookie);
  assert.ok(spies.sends.some((s) => s.target.includes("api.anthropic.com")), "control: the spy saw the Anthropic call");
});

// ---------- D-PR ----------
const RESET = "/api/auth/password-reset/request";
async function tokenCount(): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(passwordResetTokens);
  return r!.n;
}
async function timed(email: string): Promise<{ status: number; body: string; ms: number }> {
  const t0 = process.hrtime.bigint();
  const res = await post(RESET, { email });
  const body = await res.text();
  return { status: res.status, body, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };

test("D-PR: restored env — reset answers an identical 202 for an existing and an unknown account; no email, no token, no timing oracle", async () => {
  const email = await import("../auth/email.js");
  email.__clearSandboxAuthEmailLog();
  const tokensBefore = await tokenCount();
  on();
  const known = A.admin.user.email;
  const unknown = `ws4-11-nobody-${Date.now()}@example.com`;
  const k = await timed(known);
  const u = await timed(unknown);
  assert.equal(k.status, 202, k.body);
  assert.equal(u.status, 202, u.body);
  assert.equal(k.body, u.body, "byte-identical bodies");
  assert.deepEqual(JSON.parse(k.body), { message: "If that email address has an account, a reset link has been sent." });
  assert.equal(email.__getSandboxAuthEmailLog().length, 0, "no email in a restored env");
  assert.equal(await tokenCount(), tokensBefore, "no reset token row in a restored env");
  assert.equal(spies.sends.length, 0);
  // Timing: alternate 15 rounds; medians must be within 15 ms of each other (the restored path touches no DB).
  const kt: number[] = []; const ut: number[] = [];
  for (let i = 0; i < 15; i++) { kt.push((await timed(known)).ms); ut.push((await timed(unknown)).ms); }
  const diff = Math.abs(median(kt) - median(ut));
  console.log(JSON.stringify({ ws4_11_reset_timing_ms: { known_median: median(kt), unknown_median: median(ut), diff } }));
  assert.ok(diff < 15, `median timing difference ${diff} ms`);
  assert.equal(email.__getSandboxAuthEmailLog().length, 0);
  // Control: switch off → the existing account gets the same 202 body and a sandbox reset email.
  off();
  const c = await timed(known);
  assert.equal(c.status, 202);
  assert.equal(c.body, k.body);
  assert.equal(email.__getSandboxAuthEmailLog().length, 1);
});

// ---------- D-INV ----------
const invitationRows = (addr: string) => db.select().from(invitations).where(and(eq(invitations.brokerageId, A.brokerageId), eq(invitations.email, addr)));

test("D-INV: restored env — invitation refused 503 BEFORE any row is written; a prior pending invitation is not revoked", async () => {
  const email = await import("../auth/email.js");
  const fresh = `ws4-11-invitee-${Date.now()}@example.com`;
  on();
  email.__clearSandboxAuthEmailLog();
  await expect503(await post("/api/auth/admin/invitations", { email: fresh, role: "Agent" }, A.admin.cookie), "auth_email");
  assert.equal((await invitationRows(fresh)).length, 0, "zero invitation rows inserted");
  assert.equal(email.__getSandboxAuthEmailLog().length, 0);
  // A re-invite must not revoke the existing pending invitation either.
  const prior = `ws4-11-prior-${Date.now()}@example.com`;
  off();
  const c = await post("/api/auth/admin/invitations", { email: prior, role: "Agent" }, A.admin.cookie);
  assert.equal(c.status, 201, await c.clone().text());
  const before = await invitationRows(prior);
  assert.equal(before.length, 1);
  on();
  await expect503(await post("/api/auth/admin/invitations", { email: prior, role: "Agent" }, A.admin.cookie), "auth_email");
  const afterRows = await invitationRows(prior);
  assert.equal(afterRows.length, 1, "no new row");
  assert.deepEqual(afterRows[0], before[0], "prior invitation untouched (not revoked)");
});

// ---------- D-MOCK over HTTP ----------
test("D-MOCK: manual financial dispatch runs in a restored env (sandbox mandate adapter is in-process): 200, nothing sent", async () => {
  on();
  const res = await post("/api/financial/ops/dispatch-outbox", {}, A.admin.cookie);
  assert.equal(res.status, 200, await res.text());
  assert.equal(spies.sends.length, 0);
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

test("D-MOCK: communications send through the in-process sandbox in a restored env → SENT, nothing leaves the process", async () => {
  const draft = await draftEmail(A.agent.cookie);
  on();
  const res = await post(`/api/communications/messages/${draft.id}/send`, { expectedVersion: draft.version }, A.agent.cookie);
  const text = await res.text();
  assert.equal(res.status, 200, text);
  assert.equal((JSON.parse(text) as { message: { status: string } }).message.status, "SENT");
  const [row] = await db.select().from(communicationMessages).where(and(eq(communicationMessages.id, draft.id), eq(communicationMessages.brokerageId, A.brokerageId)));
  assert.equal(row!.status, "SENT");
  assert.equal(spies.sends.length, 0);
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
