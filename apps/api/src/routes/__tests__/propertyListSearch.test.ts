// UAT-S1 — GET /properties?q= searches address columns inside the caller's
// visibility set. An empty q is the unfiltered list. LIKE wildcards in the
// term are literals. An Agent never sees another Agent's property, and a
// search never crosses a brokerage.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, users } from "@aee/db";
import { createBrokerageWithUsers, cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageName = `UAT-S1 Search ${suffix}`;

let admin: DevLoginResult;
let agentA: DevLoginResult;
let agentB: DevLoginResult;
let pitCrew: DevLoginResult;
let agentWithNone: DevLoginResult;
let other: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let brokerageId: number;

let mainId: number;
let wildcardId: number;
let literalId: number;
let otherAgentId: number;
let foreignId: number;
let cappedId: number;
let tailId: number;
const hundredZs = "Z".repeat(100);

function headers(cookie: string, json = false): Record<string, string> {
  return json ? { cookie, "content-type": "application/json" } : { cookie };
}

async function getRaw(path: string, cookie: string): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, { headers: headers(cookie) });
}

async function postRaw(path: string, cookie: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method: "POST",
    headers: headers(cookie, true),
    body: JSON.stringify(body),
  });
}

async function createProperty(
  cookie: string,
  input: { formattedAddress: string; suburb: string; state: string; postcode: string },
): Promise<number> {
  const res = await postRaw("/properties", cookie, input);
  assert.equal(res.status, 201, await res.clone().text());
  const body = (await res.json()) as { property: { id: number } };
  return body.property.id;
}

interface ListedProperty {
  id: number;
  formattedAddress: string;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  brokerageId: number;
  agentId: number;
}

async function listProperties(cookie: string, q?: string): Promise<ListedProperty[]> {
  const path = q === undefined ? "/properties" : `/properties?${new URLSearchParams({ q }).toString()}`;
  const res = await getRaw(path, cookie);
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { properties: ListedProperty[] };
  return body.properties;
}

function ids(rows: ListedProperty[]): number[] {
  return rows.map((row) => row.id).sort((a, b) => a - b);
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

  const created = await createBrokerageWithUsers(baseUrl, brokerageName);
  admin = created.admin;
  agentA = created.agent;
  brokerageId = created.brokerageId;
  agentB = await devLogin(baseUrl, {
    email: `uats1-agent-b-${suffix}@example.com`,
    firstName: "Agent",
    lastName: "Bee",
    brokerageName,
  });
  pitCrew = await devLogin(baseUrl, {
    email: `uats1-pit-${suffix}@example.com`,
    firstName: "Pit",
    lastName: "Crew",
    brokerageName,
  });
  await db.update(users).set({ role: "Pit Crew" }).where(eq(users.id, pitCrew.user.id));
  pitCrew = { ...pitCrew, user: { ...pitCrew.user, role: "Pit Crew" } };
  agentWithNone = await devLogin(baseUrl, {
    email: `uats1-agent-none-${suffix}@example.com`,
    firstName: "Agent",
    lastName: "None",
    brokerageName,
  });
  other = await createBrokerageWithUsers(baseUrl, `UAT-S1 Search Other ${suffix}`);

  mainId = await createProperty(agentA.cookie, {
    formattedAddress: `${suffix} 12 Main Street`,
    suburb: "Richmond",
    state: "VIC",
    postcode: "PC91",
  });
  wildcardId = await createProperty(agentA.cookie, {
    formattedAddress: `${suffix} 100% Pure_Lane Back\\Slash`,
    suburb: "Carlton",
    state: "VIC",
    postcode: "PC53",
  });
  literalId = await createProperty(agentA.cookie, {
    formattedAddress: `${suffix} PureXLane`,
    suburb: "Fitzroy",
    state: "VIC",
    postcode: "PC22",
  });
  otherAgentId = await createProperty(agentB.cookie, {
    formattedAddress: `${suffix} 99 Other Road`,
    suburb: "Richmond",
    state: "NSW",
    postcode: "PC00",
  });
  foreignId = await createProperty(other.agent.cookie, {
    formattedAddress: `${suffix} 12 Main Street`,
    suburb: "Richmond",
    state: "VIC",
    postcode: "PC91",
  });
  cappedId = await createProperty(agentA.cookie, {
    formattedAddress: `${suffix} ${hundredZs}`,
    suburb: "Capville",
    state: "QLD",
    postcode: "PC40",
  });
  tailId = await createProperty(agentA.cookie, {
    formattedAddress: `${suffix} UNIQUE101TAIL`,
    suburb: "Tailville",
    state: "QLD",
    postcode: "PC41",
  });
});

after(async () => {
  await cleanupBrokerages([brokerageId, other?.brokerageId]);
  if (server) {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});

test("matching is case-insensitive across address, suburb, state, and postcode", async () => {
  assert.deepEqual(ids(await listProperties(agentA.cookie, "mAiN sTrEeT")), [mainId]);
  assert.deepEqual(ids(await listProperties(agentA.cookie, "cArLtOn")), [wildcardId]);
  assert.deepEqual(ids(await listProperties(admin.cookie, "nsw")), [otherAgentId]);
  assert.deepEqual(ids(await listProperties(agentA.cookie, "pc91")), [mainId]);
  assert.deepEqual(ids(await listProperties(agentA.cookie, "vIc")), [mainId, wildcardId, literalId]);
});

test("partial address and postcode matches work", async () => {
  assert.deepEqual(ids(await listProperties(agentA.cookie, "ain St")), [mainId]);
  assert.deepEqual(ids(await listProperties(agentA.cookie, "PC9")), [mainId]);
  assert.deepEqual(ids(await listProperties(agentA.cookie, "PC53")), [wildcardId]);
  assert.deepEqual(ids(await listProperties(agentA.cookie, "PC00")), []);
});

test("LIKE wildcards in the query are escaped", async () => {
  assert.deepEqual(ids(await listProperties(agentA.cookie, "%")), [wildcardId]);
  assert.deepEqual(ids(await listProperties(agentA.cookie, "_")), [wildcardId]);
  assert.deepEqual(ids(await listProperties(agentA.cookie, "\\")), [wildcardId]);
  assert.deepEqual(ids(await listProperties(agentA.cookie, "100% Pure_Lane")), [wildcardId]);
  assert.deepEqual(ids(await listProperties(agentA.cookie, "Pure_Lane")), [wildcardId]);
  assert.deepEqual(ids(await listProperties(agentA.cookie, "PureXLane")), [literalId]);
  assert.deepEqual(ids(await listProperties(admin.cookie, "%")), [wildcardId]);
});

test("an Agent never sees another Agent's property through search", async () => {
  assert.deepEqual(ids(await listProperties(agentA.cookie, "Richmond")), [mainId]);
  assert.deepEqual(ids(await listProperties(agentA.cookie, "Other Road")), []);
  assert.deepEqual(ids(await listProperties(agentB.cookie, "Main Street")), []);
  assert.deepEqual(ids(await listProperties(agentB.cookie, "Richmond")), [otherAgentId]);
  assert.deepEqual(ids(await listProperties(agentWithNone.cookie, "Richmond")), []);
  assert.deepEqual(ids(await listProperties(agentWithNone.cookie, "%")), []);

  const hidden = await listProperties(agentA.cookie, String(suffix));
  assert.equal(hidden.some((row) => row.id === otherAgentId || row.id === foreignId), false);
  assert.equal(hidden.every((row) => row.agentId === agentA.user.id), true);
});

test("an Admin searches brokerage-wide and Pit Crew does too", async () => {
  const expected = [mainId, wildcardId, literalId, otherAgentId, cappedId, tailId];
  assert.deepEqual(ids(await listProperties(admin.cookie, "Richmond")), [mainId, otherAgentId]);
  assert.deepEqual(ids(await listProperties(admin.cookie, String(suffix))), expected);
  assert.deepEqual(ids(await listProperties(pitCrew.cookie, String(suffix))), expected);
  for (const cookie of [admin.cookie, pitCrew.cookie]) {
    const rows = await listProperties(cookie, "PC91");
    assert.deepEqual(ids(rows), [mainId]);
    assert.equal(rows.some((row) => row.id === foreignId), false);
    assert.equal(rows.every((row) => row.brokerageId === brokerageId), true);
  }
});

test("cross-tenant isolation holds for search", async () => {
  const own = await listProperties(agentA.cookie, "Main Street");
  assert.deepEqual(ids(own), [mainId]);
  assert.equal(own.some((row) => row.id === foreignId), false);

  const foreign = await listProperties(other.agent.cookie, "Main Street");
  assert.deepEqual(ids(foreign), [foreignId]);
  assert.equal(foreign.some((row) => row.brokerageId === brokerageId), false);

  const adminRows = await listProperties(admin.cookie, "Main Street");
  assert.deepEqual(ids(adminRows), [mainId]);
  assert.equal(adminRows.some((row) => row.id === foreignId), false);
});

test("an empty q behaves as the unfiltered list", async () => {
  const baseline = await listProperties(admin.cookie);
  const empty = await listProperties(admin.cookie, "");
  const spaces = await listProperties(admin.cookie, "   ");
  const agentBaseline = await listProperties(agentA.cookie);
  const agentEmpty = await listProperties(agentA.cookie, "");

  assert.deepEqual(ids(empty), ids(baseline));
  assert.deepEqual(ids(spaces), ids(baseline));
  assert.deepEqual(ids(agentEmpty), ids(agentBaseline));
  assert.deepEqual(ids(baseline), [mainId, wildcardId, literalId, otherAgentId, cappedId, tailId]);
  assert.deepEqual(ids(agentBaseline), [mainId, wildcardId, literalId, cappedId, tailId]);

  const byId = new Map(baseline.map((row) => [row.id, row]));
  for (const row of empty) {
    assert.deepEqual(row, byId.get(row.id));
  }
});

test("q is trimmed and capped at 100 characters", async () => {
  assert.deepEqual(ids(await listProperties(agentA.cookie, `  ${hundredZs}NOMATCH`)), [cappedId]);
  assert.deepEqual(ids(await listProperties(agentA.cookie, `${hundredZs}UNIQUE101TAIL`)), [cappedId]);
  assert.deepEqual(ids(await listProperties(agentA.cookie, "UNIQUE101TAIL")), [tailId]);
  assert.deepEqual(ids(await listProperties(agentA.cookie, "  main street  ")), [mainId]);
});
