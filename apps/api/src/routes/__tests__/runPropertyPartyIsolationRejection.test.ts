// R-F9 — tenant_isolation_rejection_total at the properties and parties
// API boundaries. The response for a cross-tenant id stays the same 404
// the route already returned. The counter moves only when that row exists
// in another brokerage. A missing id and a same-tenant success do not.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, propertyParties } from "@aee/db";
import { renderMetricsText, resetMetricsForTesting } from "@aee/events";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const DECLARED_BOUNDARIES = new Set([
  "property",
  "party",
  "transaction",
  "financial",
  "communications",
  "integrations",
  "pit_crew",
  "other",
]);

const MISSING_ID = 2_147_483_646;

let server: Server;
let baseUrl: string;
const suffix = Date.now();
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let propertyId: number;
let partyId: number;
let linkId: number;

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function getRaw(path: string, cookie: string) {
  return fetch(`${baseUrl}/api${path}`, { headers: headers(cookie) });
}

async function postRaw(path: string, cookie: string, body: unknown) {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: headers(cookie, true),
    body: JSON.stringify(body),
  });
}

async function deleteRaw(path: string, cookie: string) {
  return fetch(`${baseUrl}/api${path}`, { method: "DELETE", headers: headers(cookie) });
}

function isolationSeries(): Array<{ boundary: string; value: number; labels: string }> {
  const found: Array<{ boundary: string; value: number; labels: string }> = [];
  for (const line of renderMetricsText().split("\n")) {
    if (!line.startsWith("tenant_isolation_rejection_total{")) continue;
    const match = /^tenant_isolation_rejection_total\{(.+)\} (\d+)$/.exec(line);
    assert.ok(match, `unparsed metric line: ${line}`);
    const labels = match[1];
    const boundary = /^boundary="([^"]*)"$/.exec(labels);
    assert.ok(boundary, `only the boundary label is allowed, got ${labels}`);
    found.push({ boundary: boundary[1], value: Number(match[2]), labels });
  }
  return found;
}

function identifyingIds(): number[] {
  return [A.brokerageId, B.brokerageId, propertyId, partyId, linkId, A.admin.user.id, A.agent.user.id, B.admin.user.id, B.agent.user.id];
}

function assertBoundedLabels(): void {
  for (const series of isolationSeries()) {
    assert.ok(DECLARED_BOUNDARIES.has(series.boundary), series.boundary);
    assert.equal(series.labels, `boundary="${series.boundary}"`);
    for (const id of identifyingIds()) {
      assert.equal(series.boundary.includes(String(id)), false, `label value contains id ${id}`);
    }
  }
}

function assertIncrement(boundary: string): void {
  const series = isolationSeries();
  assert.equal(series.length, 1);
  assert.equal(series[0].boundary, boundary);
  assert.equal(series[0].value, 1);
  assertBoundedLabels();
}

function assertNoIncrement(): void {
  assert.deepEqual(isolationSeries(), []);
}

async function assertJson(res: Response, status: number, body: string): Promise<void> {
  assert.equal(res.status, status);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(await res.text(), body);
}

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

  A = await createBrokerageWithUsers(baseUrl, `R-F9 Isolation A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `R-F9 Isolation B ${suffix}`);

  const created = await postRaw("/properties", A.agent.cookie, {
    formattedAddress: `${suffix} Isolation St`,
    state: "NSW",
    suburb: "Testville",
    postcode: "2000",
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { property: { id: number } };
  propertyId = createdBody.property.id;

  const party = await postRaw("/parties", A.agent.cookie, {
    propertyId,
    role: "Seller",
    firstName: "Priva",
    lastName: "Secret",
    email: `priva-rf9-${suffix}@example.com`,
    mobile: "0400000000",
  });
  assert.equal(party.status, 201);
  const partyBody = (await party.json()) as { party: { id: number }; link: { id: number } };
  partyId = partyBody.party.id;
  linkId = partyBody.link.id;
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

describe("R-F9 tenant isolation rejection metric", { concurrency: 1 }, () => {
  describe("R-F9 property boundary", { concurrency: 1 }, () => {
    test("a property in another brokerage is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/properties/${propertyId}`, B.agent.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertIncrement("property");
    });

    test("the workspace for a property in another brokerage is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/properties/${propertyId}/workspace`, B.agent.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertIncrement("property");
    });

    test("the timeline for a property in another brokerage keeps its 404 body and increments once", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/properties/${propertyId}/timeline`, B.agent.cookie);
      await assertJson(res, 404, JSON.stringify({ error: `Property ${propertyId} not found` }));
      assertIncrement("property");
    });

    test("a missing property id is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/properties/${MISSING_ID}`, A.agent.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertNoIncrement();
    });

    test("a missing property id on the timeline keeps its 404 body and does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/properties/${MISSING_ID}/timeline`, A.agent.cookie);
      await assertJson(res, 404, JSON.stringify({ error: `Property ${MISSING_ID} not found` }));
      assertNoIncrement();
    });

    test("a malformed property id is still 400 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw("/properties/abc", A.agent.cookie);
      await assertJson(res, 400, JSON.stringify({ error: "Invalid property id." }));
      assertNoIncrement();
    });

    test("the caller's own property still succeeds and does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/properties/${propertyId}`, A.agent.cookie);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      const body = (await res.json()) as { property: { id: number; formattedAddress: string } };
      assert.equal(body.property.id, propertyId);
      assert.equal(body.property.formattedAddress, `${suffix} Isolation St`);
      assertNoIncrement();
    });

    test("the caller's own workspace still succeeds and does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/properties/${propertyId}/workspace`, A.agent.cookie);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      const body = (await res.json()) as { property: { id: number } };
      assert.equal(body.property.id, propertyId);
      assertNoIncrement();
    });

    test("resolving ownership review on another brokerage's property is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/properties/${propertyId}/ownership-review`, B.agent.cookie, { notes: "not mine" });
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertIncrement("property");
    });

    test("resolving ownership review for a missing property is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/properties/${MISSING_ID}/ownership-review`, A.agent.cookie, {});
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertNoIncrement();
    });

    test("resolving ownership review on the caller's own property still succeeds and does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw(`/properties/${propertyId}/ownership-review`, A.agent.cookie, { notes: "checked" });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      const body = (await res.json()) as { property: { id: number; ownershipReviewRequired: boolean; ownershipReviewNotes: string | null } };
      assert.equal(body.property.id, propertyId);
      assert.equal(body.property.ownershipReviewRequired, false);
      assert.equal(body.property.ownershipReviewNotes, "checked");
      assertNoIncrement();
    });
  });

  describe("R-F9 party boundary", { concurrency: 1 }, () => {
    test("listing parties for a property in another brokerage is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/parties/by-property/${propertyId}`, B.agent.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertIncrement("party");
    });

    test("linking a party to a property in another brokerage is still 404 and increments once", async () => {
      resetMetricsForTesting();
      const res = await postRaw("/parties", B.agent.cookie, {
        propertyId,
        role: "Buyer",
        firstName: "Mallory",
        lastName: "Attacker",
        email: `mallory-rf9-${suffix}@example.com`,
      });
      await assertJson(res, 404, JSON.stringify({ error: "Property not found" }));
      assertIncrement("party");
    });

    test("deleting a link in another brokerage is still 404, increments once, and leaves the link", async () => {
      resetMetricsForTesting();
      const res = await deleteRaw(`/parties/link/${linkId}`, B.agent.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertIncrement("party");
      const stillThere = await db.select().from(propertyParties).where(eq(propertyParties.id, linkId));
      assert.equal(stillThere.length, 1);
    });

    test("a missing property id on list is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/parties/by-property/${MISSING_ID}`, A.agent.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertNoIncrement();
    });

    test("linking a party to a missing property is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw("/parties", A.agent.cookie, {
        propertyId: MISSING_ID,
        role: "Buyer",
        firstName: "Nobody",
        lastName: "Missing",
        email: `nobody-rf9-${suffix}@example.com`,
      });
      await assertJson(res, 404, JSON.stringify({ error: "Property not found" }));
      assertNoIncrement();
    });

    test("deleting a missing link is still 404 and does not increment", async () => {
      resetMetricsForTesting();
      const res = await deleteRaw(`/parties/link/${MISSING_ID}`, A.agent.cookie);
      await assertJson(res, 404, JSON.stringify({ error: "Not found" }));
      assertNoIncrement();
    });

    test("the caller's own party list still succeeds and does not increment", async () => {
      resetMetricsForTesting();
      const res = await getRaw(`/parties/by-property/${propertyId}`, A.agent.cookie);
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      const body = (await res.json()) as { parties: Array<{ linkId: number; party: { id: number; firstName: string } | null }> };
      const match = body.parties.find((row) => row.linkId === linkId);
      assert.ok(match);
      assert.equal(match.party?.id, partyId);
      assert.equal(match.party?.firstName, "Priva");
      assertNoIncrement();
    });

    test("adding a party to the caller's own property still succeeds and does not increment", async () => {
      resetMetricsForTesting();
      const res = await postRaw("/parties", A.agent.cookie, {
        propertyId,
        role: "Buyer",
        firstName: "Bob",
        lastName: "Buyer",
        email: `bob-rf9-${suffix}@example.com`,
      });
      assert.equal(res.status, 201);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      const body = (await res.json()) as { party: { firstName: string }; link: { propertyId: number; role: string } };
      assert.equal(body.party.firstName, "Bob");
      assert.equal(body.link.propertyId, propertyId);
      assert.equal(body.link.role, "Buyer");
      assertNoIncrement();
    });

    test("deleting the caller's own link still succeeds and does not increment", async () => {
      const created = await postRaw("/parties", A.agent.cookie, {
        propertyId,
        role: "Solicitor",
        firstName: "Sol",
        lastName: "Icitor",
        email: `sol-rf9-${suffix}@example.com`,
      });
      assert.equal(created.status, 201);
      const createdBody = (await created.json()) as { link: { id: number } };

      resetMetricsForTesting();
      const res = await deleteRaw(`/parties/link/${createdBody.link.id}`, A.agent.cookie);
      assert.equal(res.status, 204);
      assert.equal(await res.text(), "");
      assertNoIncrement();
      const gone = await db.select().from(propertyParties).where(eq(propertyParties.id, createdBody.link.id));
      assert.equal(gone.length, 0);
    });
  });
});
