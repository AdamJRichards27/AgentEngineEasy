// WS4-12: GET /api/properties/address-search with PROPERTY_DATA_PROVIDER=google-places in a restored environment
// answers 503 RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED (channel property_data) and nothing leaves the process; property
// creation with a placeId still succeeds (resolveAddress refusal is caught by the route — never blocks creation).
// The provider is built when routes/properties.ts is imported, so the env is set before createApp() is loaded.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { installOutboundSpies } from "./fixtures/outboundSpies.js";

process.env.ALLOW_DEV_AUTH = "true";
process.env.PROPERTY_DATA_PROVIDER = "google-places";
process.env.GOOGLE_PLACES_API_KEY = "test-only-not-a-key";
const spies = installOutboundSpies();
const { createBrokerageWithUsers, cleanupBrokerages } = await import("../../routes/__tests__/testSupport.js");

let server: Server;
let baseUrl: string;
let A: Awaited<ReturnType<typeof createBrokerageWithUsers>>;
const on = () => { process.env.AEE_RESTORED_ENVIRONMENT = "true"; };
const off = () => { delete process.env.AEE_RESTORED_ENVIRONMENT; };

before(async () => {
  const { configureEvents } = await import("../events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const a = server.address();
  if (!a || typeof a === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${a.port}`;
  off();
  A = await createBrokerageWithUsers(baseUrl, `WS4-12 PropertyData ${Date.now()}`);
});
after(async () => {
  off();
  try { await cleanupBrokerages([A.brokerageId]); } finally { await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r()))); }
});
beforeEach(() => { spies.reset(); delete process.env.AEE_RESTORED_ENV_OUTBOUND_ALLOW; });

const search = () => fetch(`${baseUrl}/api/properties/address-search?q=${encodeURIComponent("1 Test St")}`, { headers: { cookie: A.agent.cookie } });

test("restored env: address search via GooglePlaces → 503 property_data, nothing sent", async () => {
  on();
  const res = await search();
  const text = await res.text();
  assert.equal(res.status, 503, text);
  const body = JSON.parse(text) as { code: string; channel: string };
  assert.deepEqual([body.code, body.channel], ["RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED", "property_data"]);
  assert.equal(spies.sends.length, 0);
});

test("restored env: creating a property with a placeId is not blocked (resolveAddress refusal is caught), nothing sent", async () => {
  on();
  const res = await fetch(`${baseUrl}/api/properties`, {
    method: "POST", headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ formattedAddress: `12 Restored Env Rd ${Date.now()}`, placeId: "ChIJ-synthetic" }),
  });
  assert.equal(res.status, 201, await res.text());
  assert.equal(spies.sends.length, 0);
});

test("allow-listed / switch-off controls: the spy sees maps.googleapis.com", async () => {
  on();
  process.env.AEE_RESTORED_ENV_OUTBOUND_ALLOW = "property_data:google-places";
  await search();
  assert.ok(spies.sends.some((s) => s.target.includes("maps.googleapis.com")), JSON.stringify(spies.sends));
  spies.reset(); delete process.env.AEE_RESTORED_ENV_OUTBOUND_ALLOW; off();
  await search();
  assert.ok(spies.sends.some((s) => s.target.includes("maps.googleapis.com")), JSON.stringify(spies.sends));
});
