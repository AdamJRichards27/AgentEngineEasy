// AE GROW W2-C (C-10) — GET /api/ai/usage now reports TOKENS and ESTIMATED COST,
// not just request counts.
//
// ai_usage has been written on every successful AI request since the Audit
// Layer landed and had zero readers anywhere in the codebase, so the only
// question the platform could answer was "how many requests?" — under which a
// Business Coach call carrying a fourteen-query JSON context is indistinguishable
// from a one-word question. This suite asserts the read-back path against
// directly-seeded ai_interactions/ai_usage rows.
//
// Kept separate from aiUsageLimits.test.ts on purpose: that suite drives the
// four limit env vars through every configuration and asserts refusals, and
// nothing here touches enforcement at all. That separation is itself the point
// of the slice — exposing tokens and cost must not change what is enforced,
// which remains a request count while the commercial allowance is undecided.
//
// This work DOES add a migration. Selecting the same-day interactions uses the
// (brokerage_id, created_at) index already in PR #50's batched migration, but
// the read-back then joins to ai_usage on interaction_id — a foreign key, and
// Postgres indexes no foreign key — so migration 0029 adds
// ai_usage_interaction_idx. The plan that depends on it is asserted in
// aiUsageQueryPlan.test.ts; this file asserts the numbers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { db, aiInteractions, aiUsage } from "@aee/db";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const cleanupIds: number[] = [];

interface TokenTotals {
  meteredRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

interface UsageBody {
  brokerageId: number;
  brokerage: { used: number; limit: number | null; remaining: number | null };
  user: { userId: number; used: number } | null;
  tokens: { brokerage: TokenTotals; user: TokenTotals | null };
  costEstimateBasis: string;
  users?: { userId: number; used: number; tokens: TokenTotals }[];
  byRole?: { aiRole: string; requests: number; tokens: TokenTotals }[];
  distribution?: {
    activeUsers: number;
    medianRequestsPerActiveUser: number;
    p90RequestsPerActiveUser: number;
    maxRequestsPerActiveUser: number;
    medianTotalTokensPerActiveUser: number;
    p90TotalTokensPerActiveUser: number;
    maxTotalTokensPerActiveUser: number;
  };
}

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await cleanupBrokerages(cleanupIds);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function newBrokerage(label: string): Promise<{ admin: DevLoginResult; agent: DevLoginResult; brokerageId: number }> {
  const b = await createBrokerageWithUsers(baseUrl, `AI Metering ${label} ${suffix}`);
  cleanupIds.push(b.brokerageId);
  return b;
}

interface SeedSpec {
  brokerageId: number;
  userId: number;
  aiRole?: string;
  status?: "success" | "error";
  /** Omit to seed an interaction with NO ai_usage row (a provider error). */
  usage?: { promptTokens: number; completionTokens: number; estimatedCostUsd: number };
}

/** One ai_interactions row, plus its ai_usage row when `usage` is given. */
async function seed(spec: SeedSpec): Promise<void> {
  const [interaction] = await db
    .insert(aiInteractions)
    .values({
      requestId: randomUUID(),
      brokerageId: spec.brokerageId,
      userId: spec.userId,
      aiRole: spec.aiRole ?? "copilot",
      riskLevel: 0,
      status: spec.status ?? "success",
    })
    .returning({ id: aiInteractions.id });
  if (spec.usage === undefined) return;
  await db.insert(aiUsage).values({
    interactionId: interaction.id,
    provider: "mock",
    model: "mock-1",
    promptTokens: spec.usage.promptTokens,
    completionTokens: spec.usage.completionTokens,
    totalTokens: spec.usage.promptTokens + spec.usage.completionTokens,
    estimatedCostUsd: String(spec.usage.estimatedCostUsd),
    latencyMs: 12,
  });
}

async function usage(cookie: string): Promise<UsageBody> {
  const res = await fetch(`${baseUrl}/api/ai/usage`, { headers: { cookie } });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as UsageBody;
}

test("GET /api/ai/usage reports tokens and estimated cost per user and per brokerage, alongside the request counts", async () => {
  const b = await newBrokerage("Totals");

  // The agent: two metered Copilot requests and one heavier Coach request.
  await seed({ brokerageId: b.brokerageId, userId: b.agent.user.id, usage: { promptTokens: 100, completionTokens: 40, estimatedCostUsd: 0.001 } });
  await seed({ brokerageId: b.brokerageId, userId: b.agent.user.id, usage: { promptTokens: 200, completionTokens: 60, estimatedCostUsd: 0.002 } });
  await seed({
    brokerageId: b.brokerageId,
    userId: b.agent.user.id,
    aiRole: "business_coach",
    usage: { promptTokens: 9000, completionTokens: 500, estimatedCostUsd: 0.034 },
  });
  // The admin: one metered request, plus one that errored and therefore has
  // NO ai_usage row at all.
  await seed({ brokerageId: b.brokerageId, userId: b.admin.user.id, usage: { promptTokens: 50, completionTokens: 10, estimatedCostUsd: 0.0005 } });
  await seed({ brokerageId: b.brokerageId, userId: b.admin.user.id, status: "error" });

  const agentView = await usage(b.agent.cookie);

  // Request counts are untouched by this change.
  assert.equal(agentView.brokerage.used, 5, "both success and error rows still count as requests");
  assert.equal(agentView.user?.used, 3);

  assert.equal(agentView.tokens.brokerage.meteredRequests, 4, "the errored request has no usage row and must not be counted as metered");
  assert.equal(agentView.tokens.brokerage.promptTokens, 9350);
  assert.equal(agentView.tokens.brokerage.completionTokens, 610);
  assert.equal(agentView.tokens.brokerage.totalTokens, 9960);
  assert.ok(Math.abs(agentView.tokens.brokerage.estimatedCostUsd - 0.0375) < 1e-9, `got ${agentView.tokens.brokerage.estimatedCostUsd}`);

  assert.equal(agentView.tokens.user?.meteredRequests, 3);
  assert.equal(agentView.tokens.user?.totalTokens, 9900);
  assert.ok(Math.abs((agentView.tokens.user?.estimatedCostUsd ?? 0) - 0.037) < 1e-9);

  // A cost figure is never presented bare.
  assert.match(agentView.costEstimateBasis, /not a billing figure/);

  // The point of the whole work item, in one assertion: three requests and
  // 9,900 tokens are not the same fact, and only one of them was visible before.
  assert.notEqual(agentView.tokens.user?.totalTokens, agentView.user?.used);
});

test("GET /api/ai/usage token totals are tenant-scoped — another brokerage's tokens are never included", async () => {
  const mine = await newBrokerage("Scoped Mine");
  const theirs = await newBrokerage("Scoped Theirs");

  await seed({ brokerageId: mine.brokerageId, userId: mine.agent.user.id, usage: { promptTokens: 10, completionTokens: 5, estimatedCostUsd: 0.1 } });
  await seed({ brokerageId: theirs.brokerageId, userId: theirs.agent.user.id, usage: { promptTokens: 99999, completionTokens: 99999, estimatedCostUsd: 99 } });

  const view = await usage(mine.agent.cookie);
  assert.equal(view.brokerageId, mine.brokerageId);
  assert.equal(view.tokens.brokerage.totalTokens, 15);
  assert.ok(Math.abs(view.tokens.brokerage.estimatedCostUsd - 0.1) < 1e-9);
});

test("a brokerage administrator additionally sees per-capability usage and the distribution across active users", async () => {
  const b = await newBrokerage("Breakdown");

  // Agent: 3 Copilot requests, 100 total tokens each.
  for (let i = 0; i < 3; i++) {
    await seed({ brokerageId: b.brokerageId, userId: b.agent.user.id, usage: { promptTokens: 80, completionTokens: 20, estimatedCostUsd: 0.01 } });
  }
  // Admin: 1 Business Coach request, far heavier per request.
  await seed({
    brokerageId: b.brokerageId,
    userId: b.admin.user.id,
    aiRole: "business_coach",
    usage: { promptTokens: 4800, completionTokens: 200, estimatedCostUsd: 0.05 },
  });

  const adminView = await usage(b.admin.cookie);

  const byRole = adminView.byRole ?? [];
  const copilot = byRole.find((r) => r.aiRole === "copilot");
  const coach = byRole.find((r) => r.aiRole === "business_coach");
  assert.equal(copilot?.requests, 3);
  assert.equal(copilot?.tokens.totalTokens, 300);
  assert.equal(coach?.requests, 1);
  assert.equal(coach?.tokens.totalTokens, 5000);
  assert.ok(
    (coach?.tokens.totalTokens ?? 0) > (copilot?.tokens.totalTokens ?? 0),
    "one Coach request outweighing three Copilot requests is exactly the fact a request count hides",
  );

  const users = adminView.users ?? [];
  assert.equal(users.length, 2);
  assert.equal(users.find((u) => u.userId === b.agent.user.id)?.tokens.totalTokens, 300);
  assert.equal(users.find((u) => u.userId === b.admin.user.id)?.tokens.totalTokens, 5000);

  const d = adminView.distribution;
  assert.ok(d !== undefined);
  assert.equal(d.activeUsers, 2);
  assert.equal(d.medianRequestsPerActiveUser, 2, "two active users on 1 and 3 requests have a median of 2");
  assert.equal(d.maxRequestsPerActiveUser, 3);
  assert.equal(d.p90RequestsPerActiveUser, 3);
  assert.equal(d.medianTotalTokensPerActiveUser, 2650);
  assert.equal(d.maxTotalTokensPerActiveUser, 5000);

  // A non-administrator still gets their own and their brokerage's totals, and
  // nothing person-identifying about anyone else.
  const agentView = await usage(b.agent.cookie);
  assert.equal(agentView.tokens.brokerage.totalTokens, 5300);
  assert.equal(agentView.users, undefined);
  assert.equal(agentView.byRole, undefined);
  assert.equal(agentView.distribution, undefined);
});

test("a user whose every request errored still appears with requests but zero tokens", async () => {
  const b = await newBrokerage("Errors Only");
  await seed({ brokerageId: b.brokerageId, userId: b.agent.user.id, status: "error" });
  await seed({ brokerageId: b.brokerageId, userId: b.agent.user.id, status: "error" });

  const adminView = await usage(b.admin.cookie);
  const agentRow = (adminView.users ?? []).find((u) => u.userId === b.agent.user.id);
  assert.equal(agentRow?.used, 2, "a LEFT join, not an inner one: requests without usage rows must not vanish");
  assert.equal(agentRow?.tokens.meteredRequests, 0);
  assert.equal(agentRow?.tokens.totalTokens, 0);
  assert.equal(agentRow?.tokens.estimatedCostUsd, 0);

  // requests - meteredRequests is the "cost unknown" figure an operator needs:
  // it is how many of today's requests reached the provider without leaving a
  // usage row (see audit.ts's swallowed insert failure, reported in the PR).
  assert.equal(adminView.brokerage.used - adminView.tokens.brokerage.meteredRequests, 2);
});
