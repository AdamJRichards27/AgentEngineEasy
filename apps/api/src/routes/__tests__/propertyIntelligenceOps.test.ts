// AE GROW Completion Program — Wave 1, slice W1-D.
//
// Route-level coverage for the three ops endpoints added to
// routes/propertyIntelligence.ts. Mirrors exceptions.test.ts's ops section
// exactly — real createApp()/app.listen(0) server, tenant-isolated brokerages
// via createBrokerageWithUsers, raw fetch() with session cookies, cleanup in
// after().
//
// This file is about the ROUTE WIRING (the gate, the status codes, the
// tenant scoping), not the sweep's behaviour: getSweepOpsHealth()'s own
// answers are covered in lib/propertyIntelligence/__tests__/sweepOps.test.ts.
//
// THE GATE IS THE POINT. Every other route in propertyIntelligence.ts uses
// requireEntitlement; these three deliberately use requireRole(
// ...BROKERAGE_ADMIN_ROLES) instead, because entitlements gate a per-brokerage
// product capability while this is engine operations. An Agent and a Pit Crew
// user must both get 403 even though the brokerage itself is fully entitled.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, users, growOpportunitySignals, parties, properties } from "@aee/db";
import { tryHoldSignalSweepLockForTests } from "../../lib/propertyIntelligence/sweep.js";
import { createBrokerageWithUsers, devLogin, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const OPS_BASE = "/api/grow/property-intelligence/ops";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let pitCrew: DevLoginResult;

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, `PI Ops A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `PI Ops B ${suffix}`);

  // dev-login only ever mints Brokerage Administrator (first sign-in) or
  // Agent, so a Pit Crew identity is made the same way pitCrew.test.ts and
  // communications.test.ts make theirs: sign in, then set the role directly.
  pitCrew = await devLogin(baseUrl, {
    email: `pitcrew-pi-ops-${suffix}@example.com`,
    firstName: "Pit",
    lastName: "Crew",
    brokerageName: `PI Ops A ${suffix}`,
  });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId].filter((id): id is number => typeof id === "number"));
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got: ${res.status} ${text}`);
  }
}

const ALL_OPS_ROUTES = [
  { method: "GET", path: `${OPS_BASE}/health` },
  { method: "POST", path: `${OPS_BASE}/sweep` },
  { method: "GET", path: `${OPS_BASE}/signals/count` },
] as const;

/* ---------------------------------------------------------------------
 * The gate.
 * -----------------------------------------------------------------*/

test("every ops route requires authentication", async () => {
  for (const req of ALL_OPS_ROUTES) {
    const res = await fetch(`${baseUrl}${req.path}`, { method: req.method });
    assert.equal(res.status, 401, `${req.method} ${req.path} should be 401 without a session`);
  }
});

test("an Agent gets 403 on every ops route — this is engine operations, not a per-property action", async () => {
  for (const req of ALL_OPS_ROUTES) {
    const res = await fetch(`${baseUrl}${req.path}`, { method: req.method, headers: { cookie: A.agent.cookie } });
    assert.equal(res.status, 403, `${req.method} ${req.path} should be 403 for an Agent`);
  }
});

test("a Pit Crew user gets 403 on every ops route — Pit Crew is delegated transaction operations, not platform operations", async () => {
  for (const req of ALL_OPS_ROUTES) {
    const res = await fetch(`${baseUrl}${req.path}`, { method: req.method, headers: { cookie: pitCrew.cookie } });
    assert.equal(res.status, 403, `${req.method} ${req.path} should be 403 for Pit Crew`);
  }
});

/* ---------------------------------------------------------------------
 * GET /ops/health — the H-2/H-3 surface.
 * -----------------------------------------------------------------*/

interface HealthBody {
  scheduler: { enabled: boolean; intervalMs: number; maxBrokerages: number; maxCandidatesPerBrokerage: number };
  recentRuns: Array<{ id: string; status: string; truncated: boolean; errors: number; startedAt: string }>;
  lastCompletedAt: string | null;
  staleBy: { ageMs: number | null; thresholdMs: number; stale: boolean };
  brokeragesDue: number;
  runningRunId: string | null;
}

test("a Brokerage Administrator can read last run, success/failure, truncated, errors, brokeragesDue, staleness and scheduler state over HTTP", async () => {
  const res = await fetch(`${baseUrl}${OPS_BASE}/health`, { headers: { cookie: A.admin.cookie } });
  assert.equal(res.status, 200);
  const body = await json<HealthBody>(res);

  // Scheduler state — the thing that was previously only a single boot log
  // line, making "switched off" indistinguishable from "healthy but idle".
  assert.equal(typeof body.scheduler.enabled, "boolean");
  assert.equal(typeof body.scheduler.intervalMs, "number");
  assert.equal(typeof body.scheduler.maxBrokerages, "number");
  assert.equal(typeof body.scheduler.maxCandidatesPerBrokerage, "number");

  // Staleness, with its threshold stated rather than implied.
  assert.equal(body.staleBy.thresholdMs, body.scheduler.intervalMs * 3);
  assert.equal(typeof body.staleBy.stale, "boolean");

  assert.ok(Array.isArray(body.recentRuns));
  assert.ok(body.recentRuns.length <= 5, "at most the five most recent runs");
  assert.equal(typeof body.brokeragesDue, "number");
  // null is a legitimate value for both of these (never completed / nothing
  // running), so assert the key is present rather than that it is non-null.
  assert.ok("lastCompletedAt" in body);
  assert.ok("runningRunId" in body);

  // truncated and errors ride along on the run rows — no new columns.
  for (const run of body.recentRuns) {
    assert.equal(typeof run.truncated, "boolean");
    assert.equal(typeof run.errors, "number");
    assert.equal(typeof run.status, "string");
  }
});

test("the health payload carries no tenant data — run rows are counters and ids only", async () => {
  const res = await fetch(`${baseUrl}${OPS_BASE}/health`, { headers: { cookie: A.admin.cookie } });
  const raw = await res.text();
  // The run rows are engine-wide by design (that is why this is BA-gated),
  // but they must never carry a contact/property/address anywhere in them.
  for (const key of ["firstName", "lastName", "email", "mobile", "formattedAddress", "dedupeKey", "partyId"]) {
    assert.ok(!raw.includes(key), `the health payload must not expose ${key}`);
  }
});

/* ---------------------------------------------------------------------
 * POST /ops/sweep — the manual trigger, and its 409.
 * -----------------------------------------------------------------*/

test("POST /ops/sweep returns 409 with skippedReason while the single-flight lock is held", async () => {
  // Deliberately does NOT let this route run a real sweep: an unscoped
  // production sweep would touch every brokerage in the shared test
  // database, including other files' tenants mid-setup/cleanup. Holding the
  // lock ourselves exercises the exact production contract for an
  // overlapping manual trigger — the same reasoning exceptions.test.ts gives
  // for its own ops/scan test.
  let release: (() => Promise<void>) | null = null;
  for (let attempt = 0; attempt < 120 && !release; attempt += 1) {
    release = await tryHoldSignalSweepLockForTests();
    if (!release) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(release, "could not take the sweep lock (another file's sweep kept it held)");
  try {
    const res = await fetch(`${baseUrl}${OPS_BASE}/sweep`, { method: "POST", headers: { cookie: A.admin.cookie } });
    assert.equal(res.status, 409);
    const body = await json<{ error: string; skippedReason: string }>(res);
    assert.equal(typeof body.skippedReason, "string");
    assert.match(body.skippedReason, /already running/);
    assert.equal(body.error, body.skippedReason, "error and skippedReason must agree; the 409 body is not two different explanations");
  } finally {
    await release!();
  }
});

/* ---------------------------------------------------------------------
 * GET /ops/signals/count — brokerage-scoped from the session.
 * -----------------------------------------------------------------*/

test("GET /ops/signals/count is scoped to the caller's own brokerage, taken from the session", async () => {
  const resA = await fetch(`${baseUrl}${OPS_BASE}/signals/count`, { headers: { cookie: A.admin.cookie } });
  assert.equal(resA.status, 200);
  const bodyA = await json<{ brokerageId: number; activeSignals: number }>(resA);
  assert.equal(bodyA.brokerageId, A.brokerageId, "the count must be reported for the caller's own brokerage");
  assert.equal(typeof bodyA.activeSignals, "number");

  const resB = await fetch(`${baseUrl}${OPS_BASE}/signals/count`, { headers: { cookie: B.admin.cookie } });
  const bodyB = await json<{ brokerageId: number; activeSignals: number }>(resB);
  assert.equal(bodyB.brokerageId, B.brokerageId);
  assert.notEqual(bodyA.brokerageId, bodyB.brokerageId, "two admins in different brokerages must not see the same scope");
});

test("GET /ops/signals/count counts only the caller's own Active signals, and a query/route param cannot redirect it", async () => {
  // One Active signal in A, none in B.
  const [party] = await db
    .insert(parties)
    .values({ brokerageId: A.brokerageId, partyType: "Person", firstName: "Ops", lastName: `Count ${suffix}` })
    .returning({ id: parties.id });
  const [property] = await db
    .insert(properties)
    .values({ brokerageId: A.brokerageId, agentId: A.admin.user.id, formattedAddress: `9 Ops Count St ${suffix}`, state: "NSW", suburb: "Testville", postcode: "2000" })
    .returning({ id: properties.id });
  await db.insert(growOpportunitySignals).values({
    brokerageId: A.brokerageId,
    propertyId: property.id,
    partyId: party.id,
    signalType: "long_ownership_tenure",
    status: "Active",
    dedupeKey: `w1d-ops-count-${suffix}`,
    confidenceBand: "Medium",
    source: "sweep",
    title: "Long ownership tenure",
    evidence: [],
    explanation: "Fixture for the W1-D ops signal-count route test.",
  });

  const beforeB = await json<{ activeSignals: number }>(await fetch(`${baseUrl}${OPS_BASE}/signals/count`, { headers: { cookie: B.admin.cookie } }));
  const forA = await json<{ activeSignals: number }>(await fetch(`${baseUrl}${OPS_BASE}/signals/count`, { headers: { cookie: A.admin.cookie } }));
  assert.ok(forA.activeSignals >= 1, "A's own Active signal must be counted");

  // The brokerage id comes from the session only. Anything the client sends
  // is ignored — B's admin still sees B's own count.
  const spoofed = await json<{ brokerageId: number; activeSignals: number }>(
    await fetch(`${baseUrl}${OPS_BASE}/signals/count?brokerageId=${A.brokerageId}`, { headers: { cookie: B.admin.cookie } }),
  );
  assert.equal(spoofed.brokerageId, B.brokerageId, "a query parameter must never redirect the scope to another tenant");
  assert.equal(spoofed.activeSignals, beforeB.activeSignals, "B's count must be unchanged by A's signal");
});
