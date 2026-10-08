import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import type { ObjectStorageProvider } from "@aee/integration-object-storage";
import { and, eq } from "drizzle-orm";
import { db, appraisals, entitlementGrants, growOpportunities, parties, propertyParties } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { setDocumentStorageProviderForTests } from "../../lib/documentStorage.js";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

/* ---------------------------------------------------------------------
 * AE GROW Pilot Readiness WP1 -- Appraisal Workspace hardening.
 *
 * P1-1: every /grow/appraisals route requires grow.access; every mutation
 *       additionally requires grow.opportunities.manage; /:id/run-handoff
 *       requires grow.access AND run.access.
 * P1-2: an appraisal owner must belong to the appraisal's brokerage, and a
 *       (pre-existing) bad row pointing at a foreign user never exposes that
 *       user's name in the pipeline or the generated presentation.
 *
 * Same conventions as growAppraisals.test.ts: real app, real Postgres, real
 * dev-login cookies. Note: dev-login auto-grants run.access, so a freshly
 * created brokerage with no further grants is exactly a RUN/Starter-only
 * brokerage.
 * -----------------------------------------------------------------*/

class MemoryStorage implements ObjectStorageProvider {
  readonly objects = new Map<string, Buffer>();
  async putObject(key: string, content: string | Buffer) {
    this.objects.set(key, Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content));
    return { key };
  }
  async getObject(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) {
      const error = new Error(`Missing object ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return Buffer.from(bytes);
  }
  async headObject(key: string) {
    const bytes = await this.getObject(key);
    return { key, size: bytes.length, checksumSha256: createHash("sha256").update(bytes).digest("hex") };
  }
  async deleteObject(key: string) {
    this.objects.delete(key);
  }
  async createSignedDownload(key: string, expiresInSeconds = 300) {
    await this.headObject(key);
    return { url: `memory://${encodeURIComponent(key)}`, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }
  async verifyIntegrity(key: string) {
    const bytes = await this.getObject(key);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    return { valid: true, expectedChecksum: checksum, actualChecksum: checksum };
  }
  async checkReadiness() {
    return { ready: true };
  }
}

let server: Server;
let baseUrl: string;
const storage = new MemoryStorage();
const suffix = Date.now();

let GROW: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let FOREIGN: DevLoginResult;
const FOREIGN_FIRST = "Zebulon";
const FOREIGN_LAST = `Foreignowner${suffix}`;
const cleanupIds: number[] = [];

before(async () => {
  setDocumentStorageProviderForTests(storage);
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  GROW = await createBrokerageWithUsers(baseUrl, `WP1 Appraisals Grow ${suffix}`);
  cleanupIds.push(GROW.brokerageId);
  await grant(GROW.brokerageId, "grow.access");
  await grant(GROW.brokerageId, "grow.opportunities.manage");

  FOREIGN = await devLogin(baseUrl, {
    email: `wp1-foreign-owner-${suffix}@example.com`,
    firstName: FOREIGN_FIRST,
    lastName: FOREIGN_LAST,
    brokerageName: `WP1 Appraisals Foreign ${suffix}`,
  });
  cleanupIds.push(FOREIGN.user.brokerageId);
});

after(async () => {
  setDocumentStorageProviderForTests(null);
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

async function revokeEntitlement(brokerageId: number, entitlementKey: string) {
  await db
    .update(entitlementGrants)
    .set({ status: "Revoked" })
    .where(and(eq(entitlementGrants.brokerageId, brokerageId), eq(entitlementGrants.entitlementKey, entitlementKey)));
  invalidateEntitlementCache(brokerageId);
}

function growUrl(path: string) {
  return `${baseUrl}/api/grow${path}`;
}

function call(method: string, path: string, cookie: string, body?: unknown) {
  return fetch(growUrl(path), {
    method,
    headers: { "content-type": "application/json", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { property: { id: number } }).property.id;
}

async function createParty(cookie: string, propertyId: number): Promise<number> {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Seller", firstName: "Hardening", lastName: "Contact" }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { party: { id: number } }).party.id;
}

async function createAppraisal(cookie: string, label: string): Promise<{ appraisalId: number; propertyId: number; partyId: number }> {
  const propertyId = await createProperty(cookie, `${label} ${suffix}`);
  const partyId = await createParty(cookie, propertyId);
  const res = await call("POST", "/appraisals/from-contact", cookie, { partyId, propertyId });
  if (res.status !== 201) throw new Error(`create appraisal failed: ${res.status} ${await res.text()}`);
  return { appraisalId: ((await res.json()) as { appraisal: { id: number } }).appraisal.id, propertyId, partyId };
}

/** Every mutating appraisal route, against a given appraisal id. */
function mutationCalls(appraisalId: number, propertyId: number, partyId: number): Array<[string, string, unknown]> {
  return [
    ["POST", "/appraisals/from-contact", { partyId, propertyId }],
    ["POST", "/appraisals/from-opportunity", { opportunityId: 1 }],
    ["PATCH", `/appraisals/${appraisalId}`, { pricingCommentary: "x" }],
    ["POST", `/appraisals/${appraisalId}/status`, { toStatus: "PREPARING" }],
    ["POST", `/appraisals/${appraisalId}/outcome`, { outcome: "LOST" }],
    ["POST", `/appraisals/${appraisalId}/follow-up`, { followUpAt: new Date().toISOString() }],
    ["POST", `/appraisals/${appraisalId}/send`, {}],
    ["POST", `/appraisals/${appraisalId}/market-position/generate`, {}],
    ["POST", `/appraisals/${appraisalId}/presentation/generate`, {}],
    ["POST", `/appraisals/${appraisalId}/comparable-sales`, { address: "1 Comp St" }],
    ["PATCH", `/appraisals/${appraisalId}/comparable-sales/1`, { notes: "x" }],
    ["DELETE", `/appraisals/${appraisalId}/comparable-sales/1`, undefined],
    ["POST", `/appraisals/${appraisalId}/market-competition`, { address: "1 Comp St" }],
    ["PATCH", `/appraisals/${appraisalId}/market-competition/1`, { notes: "x" }],
    ["DELETE", `/appraisals/${appraisalId}/market-competition/1`, undefined],
  ];
}

test("WP1 P1-1: a RUN/Starter-only brokerage (run.access, no grow.access) gets 403 on every appraisal read and mutation route, including run-handoff", async () => {
  const run = await createBrokerageWithUsers(baseUrl, `WP1 Appraisals RunOnly ${suffix}`);
  cleanupIds.push(run.brokerageId);
  const cookie = run.admin.cookie;
  // A property/party of its own, so the 403 cannot be explained by a missing row.
  const propertyId = await createProperty(cookie, `1 Run Only St ${suffix}`);
  const partyId = await createParty(cookie, propertyId);

  for (const [method, path] of [
    ["GET", "/appraisals/pipeline"],
    ["GET", "/appraisals/1"],
  ] as const) {
    const res = await call(method, path, cookie);
    assert.equal(res.status, 403, `${method} ${path}`);
    const body = (await res.json()) as { entitlementKey: string };
    assert.equal(body.entitlementKey, "grow.access");
  }
  for (const [method, path, body] of mutationCalls(1, propertyId, partyId)) {
    const res = await call(method, path, cookie, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(((await res.json()) as { entitlementKey: string }).entitlementKey, "grow.access", `${method} ${path}`);
  }
  const handoff = await call("POST", "/appraisals/1/run-handoff", cookie, {});
  assert.equal(handoff.status, 403, "run.access alone must not reach the Grow -> Run handoff");
  assert.equal(((await handoff.json()) as { entitlementKey: string }).entitlementKey, "grow.access");
});

test("WP1 P1-1: a Grow brokerage without grow.opportunities.manage can read appraisals but cannot mutate them", async () => {
  const readOnly = await createBrokerageWithUsers(baseUrl, `WP1 Appraisals ReadOnly ${suffix}`);
  cleanupIds.push(readOnly.brokerageId);
  await grant(readOnly.brokerageId, "grow.access");
  await grant(readOnly.brokerageId, "grow.opportunities.manage");
  const cookie = readOnly.admin.cookie;
  const { appraisalId, propertyId, partyId } = await createAppraisal(cookie, "2 Read Only St");
  await revokeEntitlement(readOnly.brokerageId, "grow.opportunities.manage");

  const pipeline = await call("GET", "/appraisals/pipeline", cookie);
  assert.equal(pipeline.status, 200);
  const { appraisals: rows } = (await pipeline.json()) as { appraisals: Array<{ id: number }> };
  assert.ok(rows.some((r) => r.id === appraisalId));
  const workspace = await call("GET", `/appraisals/${appraisalId}`, cookie);
  assert.equal(workspace.status, 200);

  for (const [method, path, body] of mutationCalls(appraisalId, propertyId, partyId)) {
    const res = await call(method, path, cookie, body);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(((await res.json()) as { entitlementKey: string }).entitlementKey, "grow.opportunities.manage", `${method} ${path}`);
  }

  // The appraisal itself is untouched by every refused mutation.
  const [row] = await db.select().from(appraisals).where(eq(appraisals.id, appraisalId));
  assert.equal(row.status, "DRAFT");
  assert.equal(row.pricingCommentary, null);
});

test("WP1 P1-1: run-handoff requires grow.access AND run.access -- a Grow-only brokerage (run.access revoked) is refused on run.access", async () => {
  const growOnly = await createBrokerageWithUsers(baseUrl, `WP1 Appraisals GrowOnly ${suffix}`);
  cleanupIds.push(growOnly.brokerageId);
  await grant(growOnly.brokerageId, "grow.access");
  await grant(growOnly.brokerageId, "grow.opportunities.manage");
  const { appraisalId } = await createAppraisal(growOnly.admin.cookie, "3 Grow Only St");
  await revokeEntitlement(growOnly.brokerageId, "run.access");

  const res = await call("POST", `/appraisals/${appraisalId}/run-handoff`, growOnly.admin.cookie, {});
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as { entitlementKey: string }).entitlementKey, "run.access");
});

test("WP1 P1-2: PATCH /:id rejects an ownerUserId from another brokerage (404) and accepts one from the caller's own brokerage", async () => {
  const { appraisalId } = await createAppraisal(GROW.admin.cookie, "4 Owner Check St");

  const foreign = await call("PATCH", `/appraisals/${appraisalId}`, GROW.admin.cookie, { ownerUserId: FOREIGN.user.id });
  assert.equal(foreign.status, 404);
  const [afterForeign] = await db.select().from(appraisals).where(eq(appraisals.id, appraisalId));
  assert.notEqual(afterForeign.ownerUserId, FOREIGN.user.id, "a foreign owner id must never be written");

  const unknown = await call("PATCH", `/appraisals/${appraisalId}`, GROW.admin.cookie, { ownerUserId: 2147483000 });
  assert.equal(unknown.status, 404);

  const own = await call("PATCH", `/appraisals/${appraisalId}`, GROW.admin.cookie, { ownerUserId: GROW.agent.user.id });
  assert.equal(own.status, 200);
  const { appraisal } = (await own.json()) as { appraisal: { ownerUserId: number } };
  assert.equal(appraisal.ownerUserId, GROW.agent.user.id);

  // Clearing the owner (null) is still allowed.
  const cleared = await call("PATCH", `/appraisals/${appraisalId}`, GROW.admin.cookie, { ownerUserId: null });
  assert.equal(cleared.status, 200);
});

test("WP1 P1-2: a pre-existing bad row whose ownerUserId points at another brokerage's user never exposes that user's name in the pipeline or the generated presentation", async () => {
  const { appraisalId } = await createAppraisal(GROW.admin.cookie, "5 Bad Row St");
  // Simulate legacy/bad data written before this fix existed.
  await db.update(appraisals).set({ ownerUserId: FOREIGN.user.id }).where(eq(appraisals.id, appraisalId));
  try {
    const pipeline = await call("GET", "/appraisals/pipeline", GROW.admin.cookie);
    assert.equal(pipeline.status, 200);
    const text = await pipeline.text();
    assert.ok(!text.includes(FOREIGN_LAST), "pipeline must not contain the foreign owner's name");
    const row = (JSON.parse(text) as { appraisals: Array<{ id: number; ownerName: string | null }> }).appraisals.find(
      (r) => r.id === appraisalId,
    );
    assert.ok(row);
    assert.equal(row.ownerName, null);

    const before = new Set(storage.objects.keys());
    const presentation = await call("POST", `/appraisals/${appraisalId}/presentation/generate`, GROW.admin.cookie, {});
    assert.equal(presentation.status, 200, await presentation.clone().text());
    const newKeys = [...storage.objects.keys()].filter((k) => !before.has(k));
    assert.ok(newKeys.length > 0, "the presentation must have been written to storage");
    const rendered = newKeys.map((k) => storage.objects.get(k)!.toString("utf-8")).join("\n");
    assert.ok(!rendered.includes(FOREIGN_LAST), "presentation must not contain the foreign owner's name");
    assert.ok(!rendered.includes(FOREIGN_FIRST), "presentation must not contain the foreign owner's name");
    assert.ok(rendered.includes("Your agent"), "the owner falls back to the neutral placeholder");
  } finally {
    await db.update(appraisals).set({ ownerUserId: null }).where(eq(appraisals.id, appraisalId));
  }
});

/* ---------------------------------------------------------------------
 * Independent-review remediation — handleGrowAppraisalError.
 *
 * Every typed, expected error this feature raises keeps its own
 * client-facing message and status (404 / 409 / 403 / 429). Anything else
 * used to be answered as `400 { error: (err as Error).message }`, which both
 * leaked internal detail (here: a raw JS/driver message) and mislabelled a
 * server fault as a client error.
 * -----------------------------------------------------------------*/

test("an unrecognised error returns a generic 500, never the raw error message", async () => {
  const { appraisalId } = await createAppraisal(GROW.admin.cookie, "6 Generic Error St");

  // followUpAt passes the route schema (a non-empty string) but is not a
  // parseable date, so `new Date(...)` produces an Invalid Date and the write
  // throws an untyped RangeError from deep inside the driver — exactly the
  // "unrecognised error" class this branch exists for.
  const res = await call("POST", `/appraisals/${appraisalId}/follow-up`, GROW.admin.cookie, {
    followUpAt: "not-a-real-date",
  });

  assert.equal(res.status, 500, `expected a server error, got ${res.status}`);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "An unexpected error occurred. Please try again or contact support if the problem persists.");
  assert.doesNotMatch(body.error, /Invalid time value|RangeError|appraisals|SELECT|INSERT|UPDATE/i);
});

test("typed, expected errors keep their own messages and statuses", async () => {
  const { appraisalId } = await createAppraisal(GROW.admin.cookie, "7 Typed Error St");

  // AppraisalAccessError -> 404 with its own message.
  const missing = await call("GET", "/appraisals/2000000000", GROW.admin.cookie);
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { error: string }).error, "Appraisal not found");

  // AppraisalTransitionError -> 409 with its own message.
  const badTransition = await call("POST", `/appraisals/${appraisalId}/status`, GROW.admin.cookie, { toStatus: "WON" });
  assert.equal(badTransition.status, 409, await badTransition.clone().text());
  assert.match(((await badTransition.json()) as { error: string }).error, /recordOutcome/);
});

/* ---------------------------------------------------------------------
 * E-9 A2 — bad-row tenancy on appraisal party/opportunity joins and writes.
 *
 * Each test seeds the bad row directly (a party_id or opportunity_id that
 * points into another brokerage), the same way the WP1 P1-2 owner test
 * above seeds a foreign ownerUserId. Same-brokerage behaviour is asserted
 * in the same test so the new predicate is shown not to drop a real contact.
 * -----------------------------------------------------------------*/

let e9Seq = 0;

function e9Tag() {
  e9Seq += 1;
  return `${suffix}-${e9Seq}`;
}

function frozen(row: unknown) {
  return JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
}

async function insertForeignParty(tag: string) {
  const firstName = "Quillon";
  const lastName = `Foreignparty${tag}`;
  const email = `e9-foreign-${tag}@example.com`;
  const mobile = `+6149${tag.replace(/\D/g, "").slice(-8)}`;
  const [row] = await db
    .insert(parties)
    .values({
      brokerageId: FOREIGN.user.brokerageId,
      partyType: "Person",
      firstName,
      lastName,
      email,
      mobile,
    })
    .returning();
  return { id: row.id, firstName, lastName, email, mobile, displayName: `${firstName} ${lastName}` };
}

async function insertForeignOpportunity(partyId: number) {
  const [row] = await db
    .insert(growOpportunities)
    .values({
      brokerageId: FOREIGN.user.brokerageId,
      partyId,
      opportunityType: "Appraisal",
      status: "Open",
      stage: "Qualified",
      source: "manual",
      reason: "E-9 A2 foreign opportunity fixture",
    })
    .returning();
  return row;
}

async function createNamedParty(
  cookie: string,
  propertyId: number,
  input: { firstName: string; lastName: string; email: string; mobile: string; role?: string },
): Promise<number> {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      propertyId,
      role: input.role ?? "Seller",
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      mobile: input.mobile,
    }),
  });
  if (res.status !== 201) throw new Error(`create named party failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { party: { id: number } }).party.id;
}

async function moveToPresented(cookie: string, appraisalId: number) {
  for (const toStatus of ["APPOINTMENT_SCHEDULED", "PRESENTED"]) {
    const res = await call("POST", `/appraisals/${appraisalId}/status`, cookie, { toStatus });
    assert.equal(res.status, 200, `${toStatus}: ${await res.text()}`);
  }
}

function newStorageText(before: Set<string>): string {
  const newKeys = [...storage.objects.keys()].filter((key) => !before.has(key));
  assert.ok(newKeys.length > 0, "the presentation must have been written to storage");
  return newKeys.map((key) => storage.objects.get(key)!.toString("utf-8")).join("\n");
}

test("E-9 A2: Rule E hides a foreign party's name, email and mobile, and still shows the same-brokerage contact", async () => {
  const tag = e9Tag();
  const cookie = GROW.admin.cookie;
  const ownFirst = "Samira";
  const ownLast = `Sameparty${tag}`;
  const ownEmail = `e9-same-${tag}@example.com`;
  const ownMobile = `+6148${tag.replace(/\D/g, "").slice(-8)}`;

  const ownPropertyId = await createProperty(cookie, `8 Rule E Own St ${tag}`);
  const ownPartyId = await createNamedParty(cookie, ownPropertyId, {
    firstName: ownFirst,
    lastName: ownLast,
    email: ownEmail,
    mobile: ownMobile,
  });
  const ownCreated = await call("POST", "/appraisals/from-contact", cookie, { partyId: ownPartyId, propertyId: ownPropertyId });
  assert.equal(ownCreated.status, 201, await ownCreated.clone().text());
  const ownAppraisalId = ((await ownCreated.json()) as { appraisal: { id: number } }).appraisal.id;
  const scheduled = await call("POST", `/appraisals/${ownAppraisalId}/status`, cookie, { toStatus: "APPOINTMENT_SCHEDULED" });
  assert.equal(scheduled.status, 200, await scheduled.text());
  const followUp = await call("POST", `/appraisals/${ownAppraisalId}/follow-up`, cookie, {
    followUpAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    followUpNotes: "Call the vendor.",
  });
  assert.equal(followUp.status, 200, await followUp.text());

  const foreign = await insertForeignParty(tag);
  const { appraisalId: badAppraisalId } = await createAppraisal(cookie, `8 Rule E Bad St ${tag}`);
  await db
    .update(appraisals)
    .set({
      partyId: foreign.id,
      status: "FOLLOW_UP",
      followUpAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      followUpNotes: "Do not surface this.",
    })
    .where(eq(appraisals.id, badAppraisalId));

  const today = await call("GET", "/today", cookie);
  assert.equal(today.status, 200, await today.clone().text());
  const body = (await today.json()) as {
    priorityActions: Array<{
      id: string;
      appraisalId: number | null;
      partyId: number | null;
      contactName: string | null;
      contactEmail: string | null;
      contactMobile: string | null;
      availableActions: Array<{ action: string; partyId?: number }>;
    }>;
  };
  const text = JSON.stringify(body);

  const ownCard = body.priorityActions.find((action) => action.id === `appraisal:${ownAppraisalId}:followup`);
  assert.ok(ownCard, "a same-brokerage overdue appraisal follow-up still appears");
  assert.equal(ownCard.contactName, `${ownFirst} ${ownLast}`);
  assert.equal(ownCard.contactEmail, ownEmail);
  assert.equal(ownCard.contactMobile, ownMobile);
  assert.equal(ownCard.partyId, ownPartyId);
  assert.ok(ownCard.availableActions.some((action) => action.action === "email" && action.partyId === ownPartyId));
  assert.ok(ownCard.availableActions.some((action) => action.action === "sms" && action.partyId === ownPartyId));

  assert.equal(
    body.priorityActions.some((action) => action.appraisalId === badAppraisalId || action.partyId === foreign.id),
    false,
    "a foreign party must not produce a Today card",
  );
  assert.equal(text.includes(foreign.displayName), false);
  assert.equal(text.includes(foreign.lastName), false);
  assert.equal(text.includes(foreign.email), false);
  assert.equal(text.includes(foreign.mobile), false);
  assert.equal(text.includes(foreign.firstName), false);
});

test("E-9 A2: run handoff refuses a foreign party and still links a same-brokerage seller", async () => {
  const tag = e9Tag();
  const cookie = GROW.admin.cookie;

  const ownPropertyId = await createProperty(cookie, `9 Handoff Own St ${tag}`);
  const ownPartyId = await createNamedParty(cookie, ownPropertyId, {
    firstName: "Helena",
    lastName: `Handoff${tag}`,
    email: `e9-handoff-${tag}@example.com`,
    mobile: `+6147${tag.replace(/\D/g, "").slice(-8)}`,
    role: "Buyer",
  });
  const ownCreated = await call("POST", "/appraisals/from-contact", cookie, { partyId: ownPartyId, propertyId: ownPropertyId });
  assert.equal(ownCreated.status, 201, await ownCreated.clone().text());
  const ownAppraisalId = ((await ownCreated.json()) as { appraisal: { id: number } }).appraisal.id;
  await moveToPresented(cookie, ownAppraisalId);
  const ownWon = await call("POST", `/appraisals/${ownAppraisalId}/outcome`, cookie, { outcome: "WON", outcomeReason: "relationship" });
  assert.equal(ownWon.status, 200, await ownWon.text());
  const ownHandoff = await call("POST", `/appraisals/${ownAppraisalId}/run-handoff`, cookie, {});
  assert.equal(ownHandoff.status, 200, await ownHandoff.clone().text());
  const ownBody = (await ownHandoff.json()) as { propertyId: number; sellerLinkCreated: boolean };
  assert.equal(ownBody.propertyId, ownPropertyId);
  assert.equal(ownBody.sellerLinkCreated, true);
  const ownLinks = await db.select().from(propertyParties).where(eq(propertyParties.propertyId, ownPropertyId));
  assert.ok(ownLinks.some((link) => link.partyId === ownPartyId && link.role === "Seller"));

  const foreign = await insertForeignParty(tag);
  const { appraisalId, propertyId } = await createAppraisal(cookie, `9 Handoff Bad St ${tag}`);
  await moveToPresented(cookie, appraisalId);
  const won = await call("POST", `/appraisals/${appraisalId}/outcome`, cookie, { outcome: "WON", outcomeReason: "relationship" });
  assert.equal(won.status, 200, await won.text());
  await db.update(appraisals).set({ partyId: foreign.id }).where(eq(appraisals.id, appraisalId));
  const linksBefore = await db.select().from(propertyParties).where(eq(propertyParties.propertyId, propertyId));

  const handoff = await call("POST", `/appraisals/${appraisalId}/run-handoff`, cookie, {});
  assert.equal(handoff.status, 404);
  assert.equal(((await handoff.json()) as { error: string }).error, "Contact not found");

  const linksAfter = await db.select().from(propertyParties).where(eq(propertyParties.propertyId, propertyId));
  assert.deepEqual(
    linksAfter.map((link) => ({ partyId: link.partyId, role: link.role })).sort((a, b) => a.partyId - b.partyId),
    linksBefore.map((link) => ({ partyId: link.partyId, role: link.role })).sort((a, b) => a.partyId - b.partyId),
  );
  assert.equal(
    linksAfter.some((link) => link.partyId === foreign.id),
    false,
  );
});

test("E-9 A2: presentation generation keeps a same-brokerage contact name and omits a foreign one", async () => {
  const tag = e9Tag();
  const cookie = GROW.admin.cookie;
  const ownFirst = "Petra";
  const ownLast = `Present${tag}`;
  const propertyId = await createProperty(cookie, `10 Presentation St ${tag}`);
  const partyId = await createNamedParty(cookie, propertyId, {
    firstName: ownFirst,
    lastName: ownLast,
    email: `e9-present-${tag}@example.com`,
    mobile: `+6146${tag.replace(/\D/g, "").slice(-8)}`,
  });
  const created = await call("POST", "/appraisals/from-contact", cookie, { partyId, propertyId });
  assert.equal(created.status, 201, await created.clone().text());
  const appraisalId = ((await created.json()) as { appraisal: { id: number } }).appraisal.id;

  const beforeOwn = new Set(storage.objects.keys());
  const ownPresentation = await call("POST", `/appraisals/${appraisalId}/presentation/generate`, cookie, {});
  assert.equal(ownPresentation.status, 200, await ownPresentation.clone().text());
  const ownRendered = newStorageText(beforeOwn);
  assert.ok(ownRendered.includes(`Prepared for: ${ownFirst} ${ownLast}`));

  const foreign = await insertForeignParty(tag);
  await db.update(appraisals).set({ partyId: foreign.id }).where(eq(appraisals.id, appraisalId));
  const beforeForeign = new Set(storage.objects.keys());
  const foreignPresentation = await call("POST", `/appraisals/${appraisalId}/presentation/generate`, cookie, {});
  assert.equal(foreignPresentation.status, 200, await foreignPresentation.clone().text());
  const foreignRendered = newStorageText(beforeForeign);
  assert.ok(foreignRendered.includes("Prepared for: Valued client"));
  assert.equal(foreignRendered.includes(foreign.displayName), false);
  assert.equal(foreignRendered.includes(foreign.lastName), false);
  assert.equal(foreignRendered.includes(foreign.email), false);
  assert.equal(foreignRendered.includes(foreign.mobile), false);
  assert.equal(foreignRendered.includes(foreign.firstName), false);
});

test("E-9 A2: pipeline keeps the appraisal row when party_id is foreign, with no foreign name, and still names a same-brokerage contact", async () => {
  const tag = e9Tag();
  const cookie = GROW.admin.cookie;
  const ownFirst = "Nia";
  const ownLast = `Pipeline${tag}`;
  const propertyId = await createProperty(cookie, `11 Pipeline St ${tag}`);
  const partyId = await createNamedParty(cookie, propertyId, {
    firstName: ownFirst,
    lastName: ownLast,
    email: `e9-pipeline-${tag}@example.com`,
    mobile: `+6145${tag.replace(/\D/g, "").slice(-8)}`,
  });
  const created = await call("POST", "/appraisals/from-contact", cookie, { partyId, propertyId });
  assert.equal(created.status, 201, await created.clone().text());
  const appraisalId = ((await created.json()) as { appraisal: { id: number } }).appraisal.id;

  const before = await call("GET", "/appraisals/pipeline", cookie);
  assert.equal(before.status, 200);
  const beforeBody = (await before.json()) as { appraisals: Array<{ id: number; partyDisplayName: string | null }> };
  const beforeRow = beforeBody.appraisals.find((row) => row.id === appraisalId);
  assert.ok(beforeRow);
  assert.equal(beforeRow.partyDisplayName, `${ownFirst} ${ownLast}`);

  const foreign = await insertForeignParty(tag);
  await db.update(appraisals).set({ partyId: foreign.id }).where(eq(appraisals.id, appraisalId));

  const after = await call("GET", "/appraisals/pipeline", cookie);
  assert.equal(after.status, 200);
  const text = await after.text();
  const afterBody = JSON.parse(text) as { appraisals: Array<{ id: number; partyDisplayName: string | null }> };
  const afterRow = afterBody.appraisals.find((row) => row.id === appraisalId);
  assert.ok(afterRow, "the appraisal row itself still lists");
  assert.equal(afterRow.partyDisplayName, null);
  assert.equal(text.includes(foreign.displayName), false);
  assert.equal(text.includes(foreign.lastName), false);
  assert.equal(text.includes(foreign.email), false);
  assert.equal(text.includes(foreign.mobile), false);
  assert.equal(text.includes(foreign.firstName), false);
});

test("E-9 A2: outcome recording updates a same-brokerage opportunity and never writes a foreign one", async () => {
  const tag = e9Tag();
  const cookie = GROW.admin.cookie;

  async function opportunityFromContact(label: string, firstName: string) {
    const propertyId = await createProperty(cookie, `${label} ${tag}`);
    const partyId = await createNamedParty(cookie, propertyId, {
      firstName,
      lastName: `Outcome${tag}`,
      email: `e9-${label.replace(/\s+/g, "-").toLowerCase()}-${tag}@example.com`,
      mobile: `+6144${tag.replace(/\D/g, "").slice(-8)}`,
    });
    const opportunityRes = await call("POST", "/opportunities", cookie, {
      partyId,
      propertyId,
      opportunityType: "Appraisal",
      reason: `${label} same-brokerage opportunity`,
    });
    assert.equal(opportunityRes.status, 201, await opportunityRes.clone().text());
    const opportunityId = ((await opportunityRes.json()) as { opportunity: { id: number } }).opportunity.id;
    const created = await call("POST", "/appraisals/from-opportunity", cookie, { opportunityId });
    assert.equal(created.status, 201, await created.clone().text());
    const appraisalId = ((await created.json()) as { appraisal: { id: number } }).appraisal.id;
    return { appraisalId, opportunityId };
  }

  const won = await opportunityFromContact("12 Outcome Won", "Willa");
  await moveToPresented(cookie, won.appraisalId);
  const wonRes = await call("POST", `/appraisals/${won.appraisalId}/outcome`, cookie, { outcome: "WON", outcomeReason: "relationship" });
  assert.equal(wonRes.status, 200, await wonRes.text());
  const [wonOpportunity] = await db.select().from(growOpportunities).where(eq(growOpportunities.id, won.opportunityId));
  assert.equal(wonOpportunity.stage, "Converted");
  assert.equal(wonOpportunity.status, "Converted");
  assert.ok(wonOpportunity.closedAt);

  const lost = await opportunityFromContact("12 Outcome Lost", "Lina");
  await moveToPresented(cookie, lost.appraisalId);
  const lostRes = await call("POST", `/appraisals/${lost.appraisalId}/outcome`, cookie, { outcome: "LOST", outcomeReason: "relationship" });
  assert.equal(lostRes.status, 200, await lostRes.text());
  const [lostOpportunity] = await db.select().from(growOpportunities).where(eq(growOpportunities.id, lost.opportunityId));
  assert.equal(lostOpportunity.status, "Lost");
  assert.equal(lostOpportunity.lostReason, "relationship");
  assert.ok(lostOpportunity.closedAt);
  assert.equal(lostOpportunity.stage, "AppraisalBooked");

  const foreignParty = await insertForeignParty(tag);
  const foreignOpportunity = await insertForeignOpportunity(foreignParty.id);
  const foreignBefore = frozen(foreignOpportunity);

  const { appraisalId: badWonId } = await createAppraisal(cookie, `12 Outcome Bad Won ${tag}`);
  await db.update(appraisals).set({ opportunityId: foreignOpportunity.id }).where(eq(appraisals.id, badWonId));
  await moveToPresented(cookie, badWonId);
  const badWon = await call("POST", `/appraisals/${badWonId}/outcome`, cookie, { outcome: "WON", outcomeReason: "relationship" });
  assert.equal(badWon.status, 200, await badWon.text());
  const [afterWon] = await db.select().from(growOpportunities).where(eq(growOpportunities.id, foreignOpportunity.id));
  assert.deepEqual(frozen(afterWon), foreignBefore);

  const { appraisalId: badLostId } = await createAppraisal(cookie, `12 Outcome Bad Lost ${tag}`);
  await db.update(appraisals).set({ opportunityId: foreignOpportunity.id }).where(eq(appraisals.id, badLostId));
  await moveToPresented(cookie, badLostId);
  const badLost = await call("POST", `/appraisals/${badLostId}/outcome`, cookie, { outcome: "LOST", outcomeReason: "fee_commission" });
  assert.equal(badLost.status, 200, await badLost.text());
  const [afterLost] = await db.select().from(growOpportunities).where(eq(growOpportunities.id, foreignOpportunity.id));
  assert.deepEqual(frozen(afterLost), foreignBefore);
  assert.equal(afterLost.brokerageId, FOREIGN.user.brokerageId);
  assert.equal(afterLost.status, "Open");
  assert.equal(afterLost.stage, "Qualified");
});
