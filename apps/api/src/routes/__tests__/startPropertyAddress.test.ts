// D3 — choosing a Places result stores suburb, state and postcode, the
// property page payload includes them, and a postcode search finds the
// property. Manual entry still creates a property without them. Visibility
// is unchanged: an Agent sees their own property, not another Agent's.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, properties, users } from "@aee/db";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();

let admin: DevLoginResult;
let agentA: DevLoginResult;
let agentB: DevLoginResult;
let pitCrew: DevLoginResult;
let other: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let brokerageId: number;

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function send(method: string, path: string, cookie: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: headers(cookie, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface PropertyBody {
  property: {
    id: number;
    formattedAddress: string;
    suburb: string | null;
    state: string | null;
    postcode: string | null;
    placeId: string | null;
    isManualAddress: boolean;
    agentId: number;
    brokerageId: number;
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

  const created = await createBrokerageWithUsers(baseUrl, `D3 Address ${suffix}`);
  admin = created.admin;
  agentA = created.agent;
  brokerageId = created.brokerageId;
  agentB = await devLogin(baseUrl, {
    email: `d3-agent-b-${suffix}@example.com`,
    firstName: "Agent",
    lastName: "Bee",
    brokerageName: `D3 Address ${suffix}`,
  });
  pitCrew = await devLogin(baseUrl, {
    email: `d3-pit-${suffix}@example.com`,
    firstName: "Pit",
    lastName: "Crew",
    brokerageName: `D3 Address ${suffix}`,
  });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
  pitCrew = { ...pitCrew, user: { ...pitCrew.user, role: "Pit Crew" } };
  other = await createBrokerageWithUsers(baseUrl, `D3 Address Other ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([brokerageId, other?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("a place id with no components in the body stores suburb, state and postcode from the provider", async () => {
  const formattedAddress = "300 Racecourse Road, Hamilton QLD, Australia";
  const created = await send("POST", "/properties", agentA.cookie, {
    formattedAddress,
    placeId: "mock-address:Hamilton|QLD|4007",
  });
  assert.equal(created.status, 201, await created.clone().text());
  const createdBody = (await created.json()) as PropertyBody;
  const id = createdBody.property.id;
  assert.equal(createdBody.property.suburb, "Hamilton");
  assert.equal(createdBody.property.state, "QLD");
  assert.equal(createdBody.property.postcode, "4007");
  assert.equal(createdBody.property.formattedAddress, formattedAddress);
  assert.equal(createdBody.property.agentId, agentA.user.id);
  assert.equal(createdBody.property.brokerageId, brokerageId);

  const loaded = await send("GET", `/properties/${id}`, agentA.cookie);
  assert.equal(loaded.status, 200, await loaded.clone().text());
  const loadedBody = (await loaded.json()) as PropertyBody;
  assert.equal(loadedBody.property.suburb, "Hamilton");
  assert.equal(loadedBody.property.state, "QLD");
  assert.equal(loadedBody.property.postcode, "4007");

  const workspace = await send("GET", `/properties/${id}/workspace`, agentA.cookie);
  assert.equal(workspace.status, 200, await workspace.clone().text());
  const workspaceBody = (await workspace.json()) as { property: { suburb: string | null; state: string | null; postcode: string | null } };
  assert.equal(workspaceBody.property.suburb, "Hamilton");
  assert.equal(workspaceBody.property.state, "QLD");
  assert.equal(workspaceBody.property.postcode, "4007");

  const byPostcode = await send("GET", "/properties?q=4007", agentA.cookie);
  assert.equal(byPostcode.status, 200, await byPostcode.clone().text());
  const byPostcodeBody = (await byPostcode.json()) as { properties: Array<{ id: number }> };
  assert.ok(byPostcodeBody.properties.some((row) => row.id === id));

  const bySuburb = await send("GET", `/properties?q=${encodeURIComponent("Hamilton")}`, agentA.cookie);
  const bySuburbBody = (await bySuburb.json()) as { properties: Array<{ id: number }> };
  assert.ok(bySuburbBody.properties.some((row) => row.id === id));

  const agentBPostcode = await send("GET", "/properties?q=4007", agentB.cookie);
  const agentBBody = (await agentBPostcode.json()) as { properties: Array<{ id: number }> };
  assert.equal(agentBBody.properties.some((row) => row.id === id), false);

  const adminPostcode = await send("GET", "/properties?q=4007", admin.cookie);
  const adminBody = (await adminPostcode.json()) as { properties: Array<{ id: number }> };
  assert.ok(adminBody.properties.some((row) => row.id === id));

  const pitPostcode = await send("GET", "/properties?q=4007", pitCrew.cookie);
  const pitBody = (await pitPostcode.json()) as { properties: Array<{ id: number }> };
  assert.ok(pitBody.properties.some((row) => row.id === id));

  const foreign = await send("GET", "/properties?q=4007", other.agent.cookie);
  const foreignBody = (await foreign.json()) as { properties: Array<{ id: number }> };
  assert.equal(foreignBody.properties.some((row) => row.id === id), false);
  const foreignRead = await send("GET", `/properties/${id}`, other.agent.cookie);
  assert.equal(foreignRead.status, 404);
});

test("explicit suburb, state and postcode are kept, and missing ones are filled from the place", async () => {
  const created = await send("POST", "/properties", agentA.cookie, {
    formattedAddress: "120 Given Terrace, Paddington QLD, Australia",
    placeId: "mock-address:Hamilton|QLD|4007",
    suburb: "Paddington",
  });
  assert.equal(created.status, 201, await created.clone().text());
  const body = (await created.json()) as PropertyBody;
  assert.equal(body.property.suburb, "Paddington");
  assert.equal(body.property.state, "QLD");
  assert.equal(body.property.postcode, "4007");

  const complete = await send("POST", "/properties", agentA.cookie, {
    formattedAddress: "400 Logan Road, Stones Corner QLD, Australia",
    placeId: "mock-address:Other|NSW|2000",
    suburb: "Stones Corner",
    state: "QLD",
    postcode: "4120",
  });
  assert.equal(complete.status, 201, await complete.clone().text());
  const completeBody = (await complete.json()) as PropertyBody;
  assert.equal(completeBody.property.suburb, "Stones Corner");
  assert.equal(completeBody.property.state, "QLD");
  assert.equal(completeBody.property.postcode, "4120");

  const byPostcode = await send("GET", "/properties?q=4120", agentA.cookie);
  const listed = (await byPostcode.json()) as { properties: Array<{ id: number }> };
  assert.ok(listed.properties.some((row) => row.id === completeBody.property.id));
});

test("manual entry still creates a property, with or without suburb, state and postcode", async () => {
  const typed = await send("POST", "/properties", agentA.cookie, {
    formattedAddress: `${suffix} hand typed lane`,
    isManualAddress: true,
  });
  assert.equal(typed.status, 201, await typed.clone().text());
  const typedBody = (await typed.json()) as PropertyBody;
  assert.equal(typedBody.property.isManualAddress, true);
  assert.equal(typedBody.property.suburb, null);
  assert.equal(typedBody.property.state, null);
  assert.equal(typedBody.property.postcode, null);
  assert.equal(typedBody.property.placeId, null);

  const withParts = await send("POST", "/properties", agentB.cookie, {
    formattedAddress: `${suffix} 8 Manual Street`,
    isManualAddress: true,
    suburb: "West End",
    state: "QLD",
    postcode: "4101",
  });
  assert.equal(withParts.status, 201, await withParts.clone().text());
  const withPartsBody = (await withParts.json()) as PropertyBody;
  assert.equal(withPartsBody.property.suburb, "West End");
  assert.equal(withPartsBody.property.state, "QLD");
  assert.equal(withPartsBody.property.postcode, "4101");
  assert.equal(withPartsBody.property.agentId, agentB.user.id);

  const [row] = await db.select().from(properties).where(eq(properties.id, withPartsBody.property.id));
  assert.equal(row?.postcode, "4101");

  const agentAList = await send("GET", "/properties?q=4101", agentA.cookie);
  const agentABody = (await agentAList.json()) as { properties: Array<{ id: number }> };
  assert.equal(agentABody.properties.some((property) => property.id === withPartsBody.property.id), false);
});

test("a normal mock place id does not invent suburb, state or postcode", async () => {
  const created = await send("POST", "/properties", agentA.cookie, {
    formattedAddress: "12 Harbour Street, Sydney NSW",
    placeId: `mock-${encodeURIComponent("12 Harbour Street, Sydney NSW")}`,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const body = (await created.json()) as PropertyBody;
  assert.equal(body.property.suburb, null);
  assert.equal(body.property.state, null);
  assert.equal(body.property.postcode, null);
});
