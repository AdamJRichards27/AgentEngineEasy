// AE GROW W2-C remediation — brokerage-wide AI SPEND IS ADMINISTRATOR-ONLY.
//
// THE RULING (Project Owner). Brokerage-wide AI token totals and estimated
// provider USD cost are commercially sensitive and must not reach the Agent
// role. An agent may see their OWN usage; a Brokerage Administrator may see
// brokerage-wide aggregates. This reverses the shipped behaviour, in which
// GET /api/ai/usage returned tokens.brokerage — totals AND estimated cost —
// to every authenticated user.
//
// WHY THIS FILE IS SEPARATE from aiUsageMetering.test.ts. That suite asserts
// that the NUMBERS ARE RIGHT. This one asserts that the RIGHT PEOPLE GET
// THEM, which is a different kind of claim and fails in a different way: a
// metering test passes just as happily when a field is visible to everyone as
// when it is correctly withheld, because the value it reads is correct
// either way.
//
// WHY IT ASSERTS THE WHOLE RESPONSE, not tokens.brokerage. A denylist of
// known-bad fields only ever catches the leak you already thought of, and the
// response has several places brokerage-wide token and cost figures could
// appear: tokens.brokerage, byRole[].tokens (per-capability, brokerage-wide),
// users[].tokens (other people's), and distribution's median/p90/max TOKEN
// figures. So the central test below walks the agent's ENTIRE serialised
// response and fails on any numeric value matching a brokerage-wide token or
// cost figure that the agent's own activity cannot account for — which also
// catches a field nobody has invented yet.
//
// The fixture is built so those numbers are UNMISTAKABLE: the agent's own
// usage and the brokerage-wide totals share no value, so a leak cannot hide
// behind a coincidence, and the other users' tokens are large and distinctive.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { db, aiInteractions, aiUsage } from "@aee/db";
import {
  createBrokerageWithUsers,
  addSecondBrokerageAdmin,
  cleanupBrokerages,
  type DevLoginResult,
} from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}`;
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
  tokens: { brokerage?: TokenTotals; user: TokenTotals | null };
  costEstimateBasis: string;
  users?: { userId: number; used: number; tokens: TokenTotals }[];
  byRole?: { aiRole: string; requests: number; tokens: TokenTotals }[];
  distribution?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// The fixture, chosen so every figure is distinguishable from every other.
//
//   agent    1 request      1,111 prompt +   111 completion =  1,222 tokens, $1.11
//   admin    1 request     50,000 prompt + 5,000 completion = 55,000 tokens, $50.50
//   admin2   1 request      7,007 prompt +   707 completion =  7,714 tokens, $7.77
//   -------------------------------------------------------------------------
//   brokerage-wide                                            63,936 tokens, $59.38
//
// No two of these share a value, and the brokerage total is not a multiple of
// the agent's, so a brokerage figure appearing anywhere in the agent's
// response cannot be mistaken for the agent's own number.
// ---------------------------------------------------------------------------
const AGENT = { promptTokens: 1111, completionTokens: 111, estimatedCostUsd: 1.11 };
const ADMIN = { promptTokens: 50000, completionTokens: 5000, estimatedCostUsd: 50.5 };
const ADMIN2 = { promptTokens: 7007, completionTokens: 707, estimatedCostUsd: 7.77 };

const AGENT_TOTAL_TOKENS = AGENT.promptTokens + AGENT.completionTokens;
const BROKERAGE_TOTAL_TOKENS =
  AGENT_TOTAL_TOKENS +
  (ADMIN.promptTokens + ADMIN.completionTokens) +
  (ADMIN2.promptTokens + ADMIN2.completionTokens);
const BROKERAGE_TOTAL_PROMPT = AGENT.promptTokens + ADMIN.promptTokens + ADMIN2.promptTokens;
const BROKERAGE_TOTAL_COMPLETION = AGENT.completionTokens + ADMIN.completionTokens + ADMIN2.completionTokens;
const BROKERAGE_TOTAL_COST = AGENT.estimatedCostUsd + ADMIN.estimatedCostUsd + ADMIN2.estimatedCostUsd;

let agent: DevLoginResult;
let admin: DevLoginResult;
let admin2: DevLoginResult;
let brokerageId: number;
/** A second tenant, used to prove the admin gate is not a cross-tenant key. */
let otherAdmin: DevLoginResult;
let otherBrokerageId: number;

interface SeedSpec {
  brokerageId: number;
  userId: number;
  aiRole?: string;
  usage: { promptTokens: number; completionTokens: number; estimatedCostUsd: number };
}

async function seed(spec: SeedSpec): Promise<void> {
  const [interaction] = await db
    .insert(aiInteractions)
    .values({
      requestId: randomUUID(),
      brokerageId: spec.brokerageId,
      userId: spec.userId,
      aiRole: spec.aiRole ?? "copilot",
      status: "success",
    })
    .returning({ id: aiInteractions.id });
  await db.insert(aiUsage).values({
    interactionId: interaction.id,
    provider: "mock",
    model: "mock-model",
    promptTokens: spec.usage.promptTokens,
    completionTokens: spec.usage.completionTokens,
    totalTokens: spec.usage.promptTokens + spec.usage.completionTokens,
    estimatedCostUsd: String(spec.usage.estimatedCostUsd),
    latencyMs: 10,
  });
}

async function usage(cookie: string): Promise<UsageBody> {
  const res = await fetch(`${baseUrl}/api/ai/usage`, { headers: { cookie } });
  assert.equal(res.status, 200, `GET /api/ai/usage returned ${res.status}`);
  return (await res.json()) as UsageBody;
}

/** The agent's response as raw JSON text — what actually crosses the wire. */
async function agentResponseText(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/ai/usage`, { headers: { cookie: agent.cookie } });
  assert.equal(res.status, 200);
  return await res.text();
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

  const b = await createBrokerageWithUsers(baseUrl, `AI Spend Visibility ${suffix}`);
  cleanupIds.push(b.brokerageId);
  ({ admin, agent, brokerageId } = b);
  // A THIRD person in the brokerage, so "other users' usage" is not just the
  // one admin the agent might otherwise be able to infer by subtraction.
  admin2 = await addSecondBrokerageAdmin(baseUrl, brokerageId, {
    email: `ai-spend-second-admin-${suffix}@example.com`,
    firstName: "Second",
    lastName: "Admin",
    ownBrokerageName: `AI Spend Second Admin Own ${suffix}`,
  });

  const other = await createBrokerageWithUsers(baseUrl, `AI Spend Other ${suffix}`);
  cleanupIds.push(other.brokerageId);
  otherAdmin = other.admin;
  otherBrokerageId = other.brokerageId;

  await seed({ brokerageId, userId: agent.user.id, usage: AGENT });
  await seed({ brokerageId, userId: admin.user.id, aiRole: "business_coach", usage: ADMIN });
  await seed({ brokerageId, userId: admin2.user.id, aiRole: "business_coach", usage: ADMIN2 });
  // The other tenant spends conspicuously more, so any cross-tenant bleed is loud.
  await seed({
    brokerageId: otherBrokerageId,
    userId: otherAdmin.user.id,
    usage: { promptTokens: 999999, completionTokens: 999999, estimatedCostUsd: 4242.42 },
  });
});

after(async () => {
  await cleanupBrokerages(cleanupIds);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("an ADMINISTRATOR still receives brokerage-wide tokens and estimated cost", async () => {
  // The positive case first: the ruling restricts this data, it does not
  // delete it, and a test file that only proved absence would pass just as
  // well against an endpoint that returned nothing to anybody.
  const view = await usage(admin.cookie);

  assert.ok(view.tokens.brokerage !== undefined, "an administrator must still get brokerage-wide totals");
  assert.equal(view.tokens.brokerage.totalTokens, BROKERAGE_TOTAL_TOKENS);
  assert.equal(view.tokens.brokerage.promptTokens, BROKERAGE_TOTAL_PROMPT);
  assert.equal(view.tokens.brokerage.completionTokens, BROKERAGE_TOTAL_COMPLETION);
  assert.ok(
    Math.abs(view.tokens.brokerage.estimatedCostUsd - BROKERAGE_TOTAL_COST) < 1e-9,
    `expected ${BROKERAGE_TOTAL_COST}, got ${view.tokens.brokerage.estimatedCostUsd}`,
  );
  assert.equal(view.tokens.brokerage.meteredRequests, 3);

  // ...and the rest of the oversight block, which is gated on the same flag.
  assert.equal((view.users ?? []).length, 3);
  assert.ok((view.byRole ?? []).length >= 2);
  assert.ok(view.distribution !== undefined);
});

test("an AGENT does not receive brokerage-wide tokens or estimated cost", async () => {
  const view = await usage(agent.cookie);

  // Absent, not zero: a zeroed total is a lie an agent could act on, and a
  // future UI would render it as a real figure rather than as withheld.
  assert.equal(view.tokens.brokerage, undefined, "tokens.brokerage must be absent for a non-administrator");
  assert.ok(!("brokerage" in view.tokens), "the key itself must not be serialised");

  // The whole oversight block, which is how other people's tokens and the
  // brokerage-wide per-capability figures would otherwise arrive.
  assert.equal(view.users, undefined, "other agents' usage is oversight data");
  assert.equal(view.byRole, undefined, "per-capability totals are brokerage-wide");
  assert.equal(view.distribution, undefined, "the distribution carries brokerage-wide TOKEN medians and maxima");
});

test("an AGENT still receives their own usage, and the brokerage REQUEST COUNT they had before", async () => {
  // The targeted-removal requirement: this must not become a blanket lockdown
  // that also takes away what agents legitimately had.
  const view = await usage(agent.cookie);

  assert.equal(view.user?.userId, agent.user.id);
  assert.equal(view.user?.used, 1, "their own request count");
  assert.ok(view.tokens.user !== null, "their own tokens are not oversight data");
  assert.equal(view.tokens.user.totalTokens, AGENT_TOTAL_TOKENS);
  assert.equal(view.tokens.user.promptTokens, AGENT.promptTokens);
  assert.ok(Math.abs(view.tokens.user.estimatedCostUsd - AGENT.estimatedCostUsd) < 1e-9);

  // Brokerage REQUEST COUNTS and the ceiling are not spend data and predate
  // this change — an agent refused by the brokerage ceiling has to be able to
  // see that the brokerage, not they, is what ran out.
  assert.equal(view.brokerage.used, 3, "the brokerage request count stays visible");
  assert.equal(view.brokerageId, brokerageId);
  assert.ok("limit" in view.brokerage && "remaining" in view.brokerage);

  // The disclaimer stays, because the agent is still shown a cost — their own.
  assert.match(view.costEstimateBasis, /not a billing figure/);
});

test("NO field of the agent's response carries a brokerage-wide token or cost figure", async () => {
  // THE FIELD-AGNOSTIC CHECK. Everything above names fields, so everything
  // above can only catch a leak in a field someone already thought of. This
  // walks the agent's entire serialised response and fails on any number that
  // could only have come from brokerage-wide consumption.
  const body = JSON.parse(await agentResponseText()) as unknown;

  const forbidden = new Map<number, string>([
    [BROKERAGE_TOTAL_TOKENS, "brokerage-wide total tokens"],
    [BROKERAGE_TOTAL_PROMPT, "brokerage-wide prompt tokens"],
    [BROKERAGE_TOTAL_COMPLETION, "brokerage-wide completion tokens"],
    [Number(BROKERAGE_TOTAL_COST.toFixed(2)), "brokerage-wide estimated USD cost"],
    // Other individuals' figures, which are equally not the agent's to see.
    [ADMIN.promptTokens + ADMIN.completionTokens, "another user's total tokens"],
    [ADMIN2.promptTokens + ADMIN2.completionTokens, "another user's total tokens"],
    [ADMIN.promptTokens, "another user's prompt tokens"],
    [ADMIN2.promptTokens, "another user's prompt tokens"],
    [Number(ADMIN.estimatedCostUsd.toFixed(2)), "another user's estimated cost"],
    [Number(ADMIN2.estimatedCostUsd.toFixed(2)), "another user's estimated cost"],
  ]);

  const found: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "number") {
      const hit = forbidden.get(node) ?? forbidden.get(Number(node.toFixed(2)));
      if (hit !== undefined) found.push(`${path} = ${node} (${hit})`);
      return;
    }
    if (typeof node === "string") {
      // A figure rendered into a string is still the figure.
      for (const [value, label] of forbidden) {
        if (node.includes(String(value))) found.push(`${path} contains "${value}" (${label})`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`);
    }
  };
  walk(body, "$");

  assert.deepEqual(
    found,
    [],
    `the agent's response leaked brokerage-wide consumption data:\n  ${found.join("\n  ")}`,
  );

  // Guard against the check above being vacuous: the same walk over an
  // ADMINISTRATOR's response MUST find those figures, because an admin is
  // entitled to them. If this ever comes back empty, the fixture stopped
  // producing the numbers and the agent assertion proves nothing.
  const adminBody = JSON.parse(JSON.stringify(await usage(admin.cookie))) as unknown;
  const adminFound: string[] = [];
  const walkAdmin = (node: unknown, path: string): void => {
    if (typeof node === "number") {
      if (forbidden.has(node) || forbidden.has(Number(node.toFixed(2)))) adminFound.push(path);
      return;
    }
    if (Array.isArray(node)) return node.forEach((c, i) => walkAdmin(c, `${path}[${i}]`));
    if (node !== null && typeof node === "object") {
      for (const [k, c] of Object.entries(node)) walkAdmin(c, `${path}.${k}`);
    }
  };
  walkAdmin(adminBody, "$");
  assert.ok(
    adminFound.length > 0,
    "control: an administrator's response must contain the brokerage-wide figures this test looks for",
  );
});

test("the oversight gate is the caller's ROLE, and cannot be turned on from the request", async () => {
  // The gate is resolved server-side from the session. Nothing a client can
  // put in a query string, a header or a body may reach it — so the obvious
  // attempts must change nothing about what comes back.
  const attempts = [
    "?includeBrokerageOversight=true",
    "?includeUserBreakdown=true",
    "?admin=true",
    "?role=BROKERAGE_ADMIN",
    `?userId=${admin.user.id}`,
    `?brokerageId=${otherBrokerageId}`,
  ];

  for (const query of attempts) {
    const res = await fetch(`${baseUrl}/api/ai/usage${query}`, {
      headers: { cookie: agent.cookie, "x-brokerage-oversight": "true", "x-role": "BROKERAGE_ADMIN" },
    });
    assert.equal(res.status, 200, `GET /api/ai/usage${query} returned ${res.status}`);
    const view = (await res.json()) as UsageBody;
    assert.equal(view.tokens.brokerage, undefined, `"${query}" must not unlock brokerage-wide tokens`);
    assert.equal(view.users, undefined, `"${query}" must not unlock the per-user breakdown`);
    assert.equal(view.byRole, undefined, `"${query}" must not unlock the per-capability split`);
    assert.equal(view.distribution, undefined, `"${query}" must not unlock the distribution`);
    assert.equal(view.brokerageId, brokerageId, `"${query}" must not move the caller to another tenant`);
  }
});

test("an administrator's oversight data is their OWN brokerage's, never another tenant's", async () => {
  // Admin authorisation and tenant isolation are different controls and this
  // asserts they compose: being an administrator unlocks brokerage-wide
  // figures FOR YOUR OWN BROKERAGE, and confers nothing anywhere else.
  const view = await usage(otherAdmin.cookie);

  assert.equal(view.brokerageId, otherBrokerageId);
  assert.ok(view.tokens.brokerage !== undefined, "an admin sees their own brokerage's totals");
  assert.equal(
    view.tokens.brokerage.totalTokens,
    999999 * 2,
    "and those totals are exactly their own tenant's, with none of the other brokerage's rows",
  );
  assert.ok(
    !(view.users ?? []).some((u) => u.userId === agent.user.id || u.userId === admin.user.id),
    "no user from the other brokerage may appear in this administrator's breakdown",
  );

  // ...and the first brokerage's administrator likewise never sees this one's.
  const mine = await usage(admin.cookie);
  assert.equal(mine.tokens.brokerage?.totalTokens, BROKERAGE_TOTAL_TOKENS);
  assert.notEqual(mine.tokens.brokerage?.totalTokens, 999999 * 2);
});

test("an unauthenticated caller receives no usage data at all", async () => {
  const res = await fetch(`${baseUrl}/api/ai/usage`);
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.ok(
    !text.includes(String(BROKERAGE_TOTAL_TOKENS)),
    "a 401 body must not carry consumption figures",
  );
});
