// AE GROW post-merge hardening — HTTP-level coverage for configurable AI usage limits:
//
//   - a PER-USER daily limit and a PER-BROKERAGE daily safety ceiling apply independently;
//     a request is refused if it would exceed either;
//   - either may be unset or explicitly disabled, in which case nothing is throttled — but
//     METERING STILL HAPPENS, so usage stays correct and queryable in the pilot;
//   - once a live AI provider is approved, both must be explicitly configured or every AI
//     request fails closed with an operator error rather than silently using the provisional
//     per-tier numbers;
//   - GET /api/ai/usage reports today's usage for the caller and their brokerage, tenant-scoped.
//
// Same real-app / real-HTTP / real-Postgres pattern as aiDailyCap.test.ts (which still covers
// the pre-existing per-brokerage cap with no new configuration present, unchanged). "No provider
// call" is proven with a counter on MockAiProvider.prototype.generate. Usage for "today" is
// seeded directly as ai_interactions rows — the same durable records the limits count.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, entitlementGrants, aiInteractions } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { resolveBrokerageTier } from "../../lib/ai/entitlements.js";
import { countBrokerageAiRequestsToday, countUserAiRequestsToday } from "../../lib/ai/dailyUsage.js";
import { AI_DAILY_LIMIT_PER_BROKERAGE_ENV, AI_DAILY_LIMIT_PER_USER_ENV } from "../../lib/ai/usageLimits.js";
import { MockAiProvider } from "../../lib/ai/providers/mockProvider.js";
import { _resetGrowRateLimiterForTests } from "../../lib/ai/growRateLimiter.js";
import { setVoiceTranscriptionProviderForTests } from "../../lib/ai/voice/gateway.js";
import { _resetVoiceRateLimiterForTests } from "../../lib/ai/voice/voiceRateLimiter.js";
import type { TranscriptionProvider, TranscriptionResponse } from "../../lib/ai/voice/types.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.AI_BUSINESS_COACH_ENABLED = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const cleanupIds: number[] = [];

let providerCalls = 0;
const originalGenerate = MockAiProvider.prototype.generate;

let transcriptionCalls = 0;
const countingTranscriptionProvider: TranscriptionProvider = {
  name: "counting-mock",
  async transcribe(): Promise<TranscriptionResponse> {
    transcriptionCalls += 1;
    return { transcript: "counted mock transcription", provider: "counting-mock", durationSeconds: 1, latencyMs: 1 };
  },
};

// Every variable this suite drives, captured once so `after` restores the process exactly.
const MANAGED_ENV_VARS = [
  "AI_DAILY_CAP_ENFORCED",
  "LIVE_AI_PROVIDER_APPROVED",
  AI_DAILY_LIMIT_PER_USER_ENV,
  AI_DAILY_LIMIT_PER_BROKERAGE_ENV,
] as const;
const originalEnv = new Map<string, string | undefined>(MANAGED_ENV_VARS.map((name) => [name, process.env[name]]));

/** Sets exactly the variables named, and clears every other managed one — no leakage between tests. */
function configureLimits(values: Partial<Record<(typeof MANAGED_ENV_VARS)[number], string>>): void {
  for (const name of MANAGED_ENV_VARS) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

before(async () => {
  MockAiProvider.prototype.generate = async function (this: MockAiProvider, request) {
    providerCalls += 1;
    return originalGenerate.call(this, request);
  };
  setVoiceTranscriptionProviderForTests(countingTranscriptionProvider);
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  _resetGrowRateLimiterForTests();
  _resetVoiceRateLimiterForTests();
});

after(async () => {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  MockAiProvider.prototype.generate = originalGenerate;
  setVoiceTranscriptionProviderForTests(null);
  await cleanupBrokerages(cleanupIds);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function grant(brokerageId: number, entitlementKey: string) {
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
}

async function newBrokerage(label: string): Promise<{ admin: DevLoginResult; agent: DevLoginResult; brokerageId: number }> {
  const b = await createBrokerageWithUsers(baseUrl, `AI Limits ${label} ${suffix}`);
  cleanupIds.push(b.brokerageId);
  return b;
}

async function seedInteractions(brokerageId: number, userId: number, n: number, status: "success" | "error" = "success") {
  if (n <= 0) return;
  await db.insert(aiInteractions).values(
    Array.from({ length: n }, () => ({
      requestId: randomUUID(),
      brokerageId,
      userId,
      aiRole: "copilot",
      riskLevel: 0,
      status,
    })),
  );
}

function ask(cookie: string, body: Record<string, unknown> = {}) {
  return fetch(`${baseUrl}/api/ai/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ question: "How am I tracking?", contextType: null, contextId: null, ...body }),
  });
}

function wavBytes(paddingLength = 2000): Buffer {
  return Buffer.concat([Buffer.from("RIFF", "ascii"), Buffer.alloc(4), Buffer.from("WAVE", "ascii"), Buffer.alloc(paddingLength, 0x00)]);
}

function uploadAudio(cookie: string) {
  const form = new FormData();
  form.set("audio", new Blob([wavBytes()], { type: "audio/wav" }), "recording.wav");
  form.set("mode", "ask");
  return fetch(`${baseUrl}/api/ai/voice/transcribe`, { method: "POST", headers: { cookie }, body: form });
}

interface UsageSnapshotBody {
  brokerageId: number;
  tier: string;
  enforced: boolean;
  usesProvisionalBrokerageCeiling: boolean;
  brokerage: { used: number; limit: number | null; remaining: number | null };
  user: { userId: number; used: number; limit: number | null; remaining: number | null } | null;
  users?: { userId: number; used: number }[];
}

async function usage(cookie: string): Promise<UsageSnapshotBody> {
  const res = await fetch(`${baseUrl}/api/ai/usage`, { headers: { cookie } });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as UsageSnapshotBody;
}

test("the per-user daily limit refuses one user with 429 while another user in the SAME brokerage keeps working", async () => {
  configureLimits({ AI_DAILY_CAP_ENFORCED: "true", [AI_DAILY_LIMIT_PER_USER_ENV]: "2", [AI_DAILY_LIMIT_PER_BROKERAGE_ENV]: "off" });
  const b = await newBrokerage("PerUser");

  // One user is already at their own limit; their colleague has used nothing.
  await seedInteractions(b.brokerageId, b.agent.user.id, 2);

  const callsBefore = providerCalls;
  const refused = await ask(b.agent.cookie);
  assert.equal(refused.status, 429, await refused.clone().text());
  const body = (await refused.json()) as { error: string; limit: number; scope: string; tier: string };
  assert.equal(body.scope, "user");
  assert.equal(body.limit, 2);
  assert.match(body.error, /You have reached your daily limit of 2 AI requests/);
  assert.equal(providerCalls, callsBefore, "a request over the per-user limit must never reach the provider");

  const colleague = await ask(b.admin.cookie);
  assert.equal(colleague.status, 200, await colleague.clone().text());
  assert.equal(providerCalls, callsBefore + 1);

  // The refusal is audited as blocked, and blocked rows never consume quota.
  const blocked = await db
    .select()
    .from(aiInteractions)
    .where(and(eq(aiInteractions.userId, b.agent.user.id), eq(aiInteractions.status, "blocked_flag")));
  assert.ok(blocked.some((row) => (row.errorMessage ?? "").includes("your daily limit")));
  assert.equal(await countUserAiRequestsToday(b.brokerageId, b.agent.user.id), 2);
  assert.equal(await countUserAiRequestsToday(b.brokerageId, b.admin.user.id), 1, "the colleague's own request was metered");
});

test("the brokerage ceiling refuses EVERY user in that brokerage with 429, and never another brokerage", async () => {
  configureLimits({ AI_DAILY_CAP_ENFORCED: "true", [AI_DAILY_LIMIT_PER_USER_ENV]: "off", [AI_DAILY_LIMIT_PER_BROKERAGE_ENV]: "3" });
  const capped = await newBrokerage("Ceiling");
  const fresh = await newBrokerage("Ceiling Other");

  // Spread across two users: no single user is near a per-user limit (there isn't one).
  await seedInteractions(capped.brokerageId, capped.agent.user.id, 2);
  await seedInteractions(capped.brokerageId, capped.admin.user.id, 1);

  const callsBefore = providerCalls;
  for (const who of [capped.agent, capped.admin]) {
    const res = await ask(who.cookie);
    assert.equal(res.status, 429, await res.clone().text());
    const body = (await res.json()) as { error: string; limit: number; scope: string };
    assert.equal(body.scope, "brokerage");
    assert.equal(body.limit, 3);
    assert.match(body.error, /Your brokerage has reached its daily limit of 3 AI requests/);
  }
  assert.equal(providerCalls, callsBefore, "nobody in a capped brokerage reaches the provider");

  const other = await ask(fresh.agent.cookie);
  assert.equal(other.status, 200, "the ceiling is per brokerage");
  assert.equal(providerCalls, callsBefore + 1);
});

test("the per-user limit binds before the ceiling when both are configured, and each limit binds on its own", async () => {
  configureLimits({ AI_DAILY_CAP_ENFORCED: "true", [AI_DAILY_LIMIT_PER_USER_ENV]: "2", [AI_DAILY_LIMIT_PER_BROKERAGE_ENV]: "3" });
  const b = await newBrokerage("Both");

  // Two requests from the agent: the agent is at their own limit, the brokerage is not at its ceiling.
  await seedInteractions(b.brokerageId, b.agent.user.id, 2);
  const agentRefused = await ask(b.agent.cookie);
  assert.equal(agentRefused.status, 429);
  const agentRefusal = (await agentRefused.json()) as { scope: string; limit: number };
  assert.equal(agentRefusal.scope, "user");
  assert.equal(agentRefusal.limit, 2);

  // The admin's own allowance is untouched, so their request succeeds and takes the brokerage to 3.
  assert.equal((await ask(b.admin.cookie)).status, 200);
  assert.equal(await countBrokerageAiRequestsToday(b.brokerageId), 3);

  // Now the ceiling binds for the admin too, even though they are under their own per-user limit.
  const adminRefusal = await ask(b.admin.cookie);
  assert.equal(adminRefusal.status, 429);
  assert.equal(((await adminRefusal.json()) as { scope: string }).scope, "brokerage");
});

test("both limits explicitly disabled: nothing is throttled, and every request is still metered", async () => {
  configureLimits({ AI_DAILY_CAP_ENFORCED: "true", [AI_DAILY_LIMIT_PER_USER_ENV]: "off", [AI_DAILY_LIMIT_PER_BROKERAGE_ENV]: "off" });
  const b = await newBrokerage("Disabled");
  await seedInteractions(b.brokerageId, b.agent.user.id, 50);

  assert.equal((await ask(b.agent.cookie)).status, 200, "an explicitly disabled limit refuses nothing");
  assert.equal(await countUserAiRequestsToday(b.brokerageId, b.agent.user.id), 51, "metering does not depend on a limit existing");

  const snapshot = await usage(b.agent.cookie);
  assert.equal(snapshot.brokerage.limit, null);
  assert.equal(snapshot.brokerage.remaining, null);
  assert.equal(snapshot.user?.limit, null);
  assert.equal(snapshot.user?.used, 51);
});

test("pilot default (mock provider, nothing configured): no throttling at any volume, metering unchanged", async () => {
  configureLimits({});
  const b = await newBrokerage("Pilot");
  assert.equal(await resolveBrokerageTier(b.brokerageId), "STARTER");

  // Far past the provisional STARTER safety number (20) — which must not bind in the pilot.
  await seedInteractions(b.brokerageId, b.agent.user.id, 50);
  assert.equal((await ask(b.agent.cookie)).status, 200);
  assert.equal((await ask(b.agent.cookie)).status, 200);
  assert.equal(await countBrokerageAiRequestsToday(b.brokerageId), 52);

  const snapshot = await usage(b.agent.cookie);
  assert.equal(snapshot.enforced, false);
  assert.equal(snapshot.usesProvisionalBrokerageCeiling, true, "the provisional number is still reported, and still not enforced");
  assert.equal(snapshot.brokerage.used, 52);
  assert.equal(snapshot.user?.limit, null, "no per-user limit exists until one is configured");

  // Voice, which piggybacks on the same durable count, is likewise unaffected.
  const voiceBefore = transcriptionCalls;
  await grant(b.brokerageId, "grow.access");
  await grant(b.brokerageId, "grow.ai.use");
  assert.equal((await uploadAudio(b.agent.cookie)).status, 200);
  assert.equal(transcriptionCalls, voiceBefore + 1);
});

test("live provider approved with NO configured limits: every AI surface fails closed with an operator error, before any provider call", async () => {
  configureLimits({ LIVE_AI_PROVIDER_APPROVED: "true" });
  const b = await newBrokerage("Unconfigured");
  await grant(b.brokerageId, "grow.access");
  await grant(b.brokerageId, "grow.ai.use");

  const callsBefore = providerCalls;
  const res = await ask(b.agent.cookie);
  assert.equal(res.status, 503, await res.clone().text());
  const body = (await res.json()) as { error: string; code: string };
  assert.equal(body.code, "AI_USAGE_LIMITS_NOT_CONFIGURED");
  assert.equal(providerCalls, callsBefore, "an unconfigured live process must never reach the provider");

  // The operator-facing detail is audited, not just logged: a blocked row naming both variables.
  const blocked = await db
    .select()
    .from(aiInteractions)
    .where(and(eq(aiInteractions.userId, b.agent.user.id), eq(aiInteractions.status, "blocked_flag")));
  const fault = blocked.find((row) => (row.errorMessage ?? "").includes("not usable"));
  assert.ok(fault, "the configuration fault is recorded in the audit trail");
  assert.match(fault.errorMessage ?? "", /AI_DAILY_LIMIT_PER_USER/);
  assert.match(fault.errorMessage ?? "", /AI_DAILY_LIMIT_PER_BROKERAGE/);
  assert.match(fault.errorMessage ?? "", /not a commercial allowance/);

  const voiceBefore = transcriptionCalls;
  const voiceRes = await uploadAudio(b.agent.cookie);
  assert.equal(voiceRes.status, 503);
  assert.equal(((await voiceRes.json()) as { code: string }).code, "AI_USAGE_LIMITS_NOT_CONFIGURED");
  assert.equal(transcriptionCalls, voiceBefore, "voice fails closed on the same fault");

  const usageRes = await fetch(`${baseUrl}/api/ai/usage`, { headers: { cookie: b.agent.cookie } });
  assert.equal(usageRes.status, 503, "inspection reports the fault rather than displaying a limit that is not in force");

  // Configuring only one of the two is still not enough.
  configureLimits({ LIVE_AI_PROVIDER_APPROVED: "true", [AI_DAILY_LIMIT_PER_USER_ENV]: "5" });
  assert.equal((await ask(b.agent.cookie)).status, 503);

  // Both configured: the same process serves normally again, under the configured numbers.
  configureLimits({
    LIVE_AI_PROVIDER_APPROVED: "true",
    [AI_DAILY_LIMIT_PER_USER_ENV]: "5",
    [AI_DAILY_LIMIT_PER_BROKERAGE_ENV]: "50",
  });
  const ok = await ask(b.agent.cookie);
  assert.equal(ok.status, 200, await ok.clone().text());
  const snapshot = await usage(b.agent.cookie);
  assert.equal(snapshot.enforced, true);
  assert.equal(snapshot.usesProvisionalBrokerageCeiling, false);
  assert.equal(snapshot.brokerage.limit, 50);
  assert.equal(snapshot.user?.limit, 5);
});

test("GET /api/ai/usage is tenant-scoped, reports both scopes, and only shows a brokerage administrator the per-user breakdown", async () => {
  configureLimits({ AI_DAILY_CAP_ENFORCED: "true", [AI_DAILY_LIMIT_PER_USER_ENV]: "9", [AI_DAILY_LIMIT_PER_BROKERAGE_ENV]: "40" });
  const b = await newBrokerage("Usage");
  const other = await newBrokerage("Usage Other");

  await seedInteractions(b.brokerageId, b.agent.user.id, 4);
  await seedInteractions(b.brokerageId, b.admin.user.id, 3, "error");
  await seedInteractions(other.brokerageId, other.agent.user.id, 11);

  const agentView = await usage(b.agent.cookie);
  assert.equal(agentView.brokerageId, b.brokerageId);
  assert.equal(agentView.brokerage.used, 7, "another brokerage's usage is never included");
  assert.equal(agentView.brokerage.limit, 40);
  assert.equal(agentView.brokerage.remaining, 33);
  assert.deepEqual(agentView.user, { userId: b.agent.user.id, used: 4, limit: 9, remaining: 5 });
  assert.equal(agentView.users, undefined, "an Agent never sees a brokerage-wide per-user breakdown");

  const adminView = await usage(b.admin.cookie);
  assert.equal(adminView.user?.userId, b.admin.user.id);
  assert.equal(adminView.user?.used, 3);
  assert.deepEqual(adminView.users, [
    { userId: b.agent.user.id, used: 4 },
    { userId: b.admin.user.id, used: 3 },
  ]);
  for (const row of adminView.users ?? []) {
    assert.notEqual(row.userId, other.agent.user.id, "the breakdown never crosses a tenant boundary");
  }

  const otherView = await usage(other.agent.cookie);
  assert.equal(otherView.brokerage.used, 11);

  assert.equal((await fetch(`${baseUrl}/api/ai/usage`)).status, 401);
});
