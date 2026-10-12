// E-9 read hardening — Contact 360 appraisal tenancy.
//
// getRelationshipTimeline selects appraisals for a contact. Migration 0036
// stores appraisals.brokerage_id from the property and rejects a party from
// another brokerage. A same-brokerage appraisal still appears. The old
// cross-tenant shape (party in A, property in B) is no longer storable.
import { randomBytes } from "node:crypto";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { appraisals, db, properties } from "@aee/db";
import { getRelationshipTimeline } from "../relationshipTimeline.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "../../routes/__tests__/testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;

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

  A = await createBrokerageWithUsers(baseUrl, `Timeline Appraisal Tenancy A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Timeline Appraisal Tenancy B ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function createProperty(cookie: string, address: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  if (res.status !== 201) throw new Error(`create property failed: ${res.status} ${await res.text()}`);
  const { property } = (await res.json()) as { property: { id: number } };
  return property.id;
}

async function createParty(cookie: string, propertyId: number, overrides: Record<string, unknown> = {}): Promise<number> {
  const res = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ propertyId, role: "Buyer", firstName: "Test", lastName: "Contact", ...overrides }),
  });
  if (res.status !== 201) throw new Error(`create party failed: ${res.status} ${await res.text()}`);
  const { party } = (await res.json()) as { party: { id: number } };
  return party.id;
}

test("a same-brokerage appraisal still appears on the Contact 360 timeline with its property and status", async () => {
  const address = `12 Same Brokerage Appraisal St ${suffix}`;
  const propertyId = await createProperty(A.agent.cookie, address);
  const partyId = await createParty(A.agent.cookie, propertyId, { firstName: "Ada", lastName: "SameBrokerage" });
  const ownPriceLow = "450000.00";
  const ownPriceHigh = "480000.00";

  const [ownProperty] = await db
    .select({ brokerageId: properties.brokerageId })
    .from(properties)
    .where(eq(properties.id, propertyId));
  const [appraisal] = await db
    .insert(appraisals)
    .values({
      propertyId,
      brokerageId: ownProperty.brokerageId,
      partyId,
      status: "READY",
      priceRangeLow: ownPriceLow,
      priceRangeHigh: ownPriceHigh,
      shareToken: randomBytes(16).toString("hex"),
    })
    .returning();

  const timeline = await getRelationshipTimeline(A.brokerageId, partyId);
  assert.ok(timeline.some((event) => event.type === "CONTACT_CREATED" && event.sourceId === partyId));

  const created = timeline.find((event) => event.id === `appraisal:${appraisal.id}:CREATED`);
  assert.ok(created, "APPRAISAL_CREATED must appear for an appraisal whose property is in the caller's brokerage");
  assert.equal(created.type, "APPRAISAL_CREATED");
  assert.equal(created.sourceType, "appraisal");
  assert.equal(created.sourceId, appraisal.id);
  assert.equal(created.propertyId, propertyId);
  assert.equal(created.propertyLabel, address);

  const ready = timeline.find((event) => event.id === `appraisal:${appraisal.id}:READY`);
  assert.ok(ready, "APPRAISAL_READY must appear when the same-brokerage appraisal status is READY");
  assert.equal(ready.type, "APPRAISAL_READY");
  assert.equal(ready.sourceId, appraisal.id);
  assert.equal(ready.propertyId, propertyId);
  assert.equal(ready.propertyLabel, address);

  // The timeline event shape does not carry price. Confirm the same-brokerage
  // read still does not start emitting price columns.
  const text = JSON.stringify(timeline);
  assert.equal(text.includes(ownPriceLow), false);
  assert.equal(text.includes(ownPriceHigh), false);
});

test("a cross-brokerage property cannot be stored on this contact's appraisal, and the timeline keeps the same-brokerage row", async () => {
  const ownAddress = `14 Own Appraisal St ${suffix}`;
  const foreignAddress = `99 Foreign Brokerage Appraisal Lane ${suffix}`;
  const ownPropertyId = await createProperty(A.agent.cookie, ownAddress);
  const partyId = await createParty(A.agent.cookie, ownPropertyId, { firstName: "Cara", lastName: "MixedRow" });
  const foreignPropertyId = await createProperty(B.agent.cookie, foreignAddress);

  const foreignPriceLow = "8123456.50";
  const foreignPriceHigh = "9234567.75";
  const foreignOpportunityId = 2_100_000_000 + (Date.now() % 10_000);

  const [ownProperty] = await db
    .select({ brokerageId: properties.brokerageId })
    .from(properties)
    .where(eq(properties.id, ownPropertyId));
  const [foreignProperty] = await db
    .select({ brokerageId: properties.brokerageId })
    .from(properties)
    .where(eq(properties.id, foreignPropertyId));

  const [own] = await db
    .insert(appraisals)
    .values({
      propertyId: ownPropertyId,
      brokerageId: ownProperty.brokerageId,
      partyId,
      status: "DRAFT",
      shareToken: randomBytes(16).toString("hex"),
    })
    .returning();

  await assert.rejects(
    () =>
      db.insert(appraisals).values({
        propertyId: foreignPropertyId,
        brokerageId: foreignProperty.brokerageId,
        partyId,
        status: "SENT",
        sentAt: new Date("2026-10-01T01:00:00.000Z"),
        priceRangeLow: foreignPriceLow,
        priceRangeHigh: foreignPriceHigh,
        opportunityId: foreignOpportunityId,
        shareToken: randomBytes(16).toString("hex"),
      }),
    (err: unknown) => constraintViolation(err, "appraisals_party_brokerage_fk"),
  );

  const timeline = await getRelationshipTimeline(A.brokerageId, partyId);
  const text = JSON.stringify(timeline);

  const ownCreated = timeline.find((event) => event.id === `appraisal:${own.id}:CREATED`);
  assert.ok(ownCreated, "the contact's own-brokerage appraisal must still appear");
  assert.equal(ownCreated.propertyId, ownPropertyId);
  assert.equal(ownCreated.propertyLabel, ownAddress);
  assert.equal(ownCreated.sourceId, own.id);

  assert.equal(
    timeline.some((event) => event.propertyId === foreignPropertyId),
    false,
    "the foreign property id must not appear on any timeline event",
  );
  assert.equal(
    timeline.some((event) => event.opportunityId === foreignOpportunityId),
    false,
    "the foreign appraisal opportunity id must not appear",
  );
  assert.equal(text.includes(foreignAddress), false, "the foreign property address must not appear");
  assert.equal(text.includes(foreignPriceLow), false, "the foreign price range low must not appear");
  assert.equal(text.includes(foreignPriceHigh), false, "the foreign price range high must not appear");
});

function constraintViolation(err: unknown, constraint: string): boolean {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (current instanceof Error) parts.push(current.message);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") parts.push(code);
    current = (current as { cause?: unknown }).cause;
  }
  const text = parts.join(" ");
  return text.includes(constraint) || text.includes("23503");
}
