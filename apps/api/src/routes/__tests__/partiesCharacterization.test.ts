// UAT-T1 characterization. POST /parties writes a property_parties row and
// does not write a grow_relationships row (apps/api/src/routes/parties.ts).
// Changing this needs an Owner decision: UAT Round 1 audit section 3,
// item 5 (where a contact with no property is created). A seller added
// here must not start appearing on Contact 360 during UAT.
//
// Cross-brokerage rejection for this route is already locked and is not
// repeated here:
// - apps/api/src/routes/__tests__/parties.test.ts
//   "POST /: brokerage B cannot link a party to brokerage A's property"
// - apps/api/src/routes/__tests__/runPropertyPartyIsolationRejection.test.ts
//   "linking a party to a property in another brokerage is still 404 and increments once"
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, growRelationships, propertyParties } from "@aee/db";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

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
  A = await createBrokerageWithUsers(baseUrl, `UAT Parties ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("POST /parties writes property_parties and does not write grow_relationships", async () => {
  const relationshipsBefore = await db
    .select({ id: growRelationships.id })
    .from(growRelationships)
    .where(eq(growRelationships.brokerageId, A.brokerageId));

  const createdProperty = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { cookie: A.agent.cookie, "content-type": "application/json" },
    body: JSON.stringify({
      formattedAddress: `${suffix} Seller Street`,
      state: "NSW",
      suburb: "Testville",
      postcode: "2000",
    }),
  });
  assert.equal(createdProperty.status, 201);
  const propertyBody = (await createdProperty.json()) as { property: { id: number } };

  const created = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { cookie: A.agent.cookie, "content-type": "application/json" },
    body: JSON.stringify({
      propertyId: propertyBody.property.id,
      role: "Seller",
      firstName: "Sam",
      lastName: "Seller",
      email: `sam-uat-${suffix}@example.com`,
    }),
  });
  assert.equal(created.status, 201);
  const body = (await created.json()) as { party: { id: number }; link: { id: number; propertyId: number; role: string } };
  assert.equal(body.link.propertyId, propertyBody.property.id);
  assert.equal(body.link.role, "Seller");

  const links = await db.select().from(propertyParties).where(eq(propertyParties.partyId, body.party.id));
  assert.equal(links.length, 1);
  assert.equal(links[0]?.id, body.link.id);
  assert.equal(links[0]?.propertyId, propertyBody.property.id);
  assert.equal(links[0]?.role, "Seller");

  const forParty = await db.select().from(growRelationships).where(eq(growRelationships.partyId, body.party.id));
  assert.deepEqual(forParty, []);
  const relationshipsAfter = await db
    .select({ id: growRelationships.id })
    .from(growRelationships)
    .where(eq(growRelationships.brokerageId, A.brokerageId));
  assert.deepEqual(relationshipsAfter, relationshipsBefore);
});
