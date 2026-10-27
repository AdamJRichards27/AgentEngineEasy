import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { OSM_TILE_ORIGIN } from "../../lib/securityHeaders.js";

// Owner t525u item 4: the only change to helmet's defaults is an img-src
// allowance for the OSM tile host while the Market Activity flag is on.
// Exact headers are asserted so any other relaxation fails here. No outbound calls.

const HELMET_DEFAULT_CSP =
  "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';" +
  "img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests";
const MAP_PREVIEW_CSP =
  "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';" +
  "img-src 'self' data: https://tile.openstreetmap.org;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline';upgrade-insecure-requests";

let server: Server;
let baseUrl: string;
const prev = process.env.GROW_MARKET_ACTIVITY_ENABLED;

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (prev === undefined) delete process.env.GROW_MARKET_ACTIVITY_ENABLED;
  else process.env.GROW_MARKET_ACTIVITY_ENABLED = prev;
  await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())));
});

async function headers(path = "/api/health") {
  const res = await fetch(`${baseUrl}${path}`);
  await res.arrayBuffer();
  return res.headers;
}

test("flag off: helmet's default CSP and Referrer-Policy, byte for byte", async () => {
  delete process.env.GROW_MARKET_ACTIVITY_ENABLED;
  const h = await headers();
  assert.equal(h.get("content-security-policy"), HELMET_DEFAULT_CSP);
  assert.equal(h.get("referrer-policy"), "no-referrer");
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "1";
  assert.equal((await headers()).get("content-security-policy"), HELMET_DEFAULT_CSP, "only the exact value true enables the map");
});

test("flag on: only img-src gains the OSM tile host; everything else unchanged; global referrer stays no-referrer", async () => {
  process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
  const h = await headers();
  assert.equal(OSM_TILE_ORIGIN, "https://tile.openstreetmap.org");
  assert.equal(h.get("content-security-policy"), MAP_PREVIEW_CSP);
  assert.equal(h.get("referrer-policy"), "no-referrer");
  for (const name of ["strict-transport-security", "x-content-type-options", "x-frame-options", "cross-origin-opener-policy", "cross-origin-resource-policy", "origin-agent-cluster", "x-dns-prefetch-control", "x-download-options", "x-permitted-cross-domain-policies", "x-xss-protection"]) {
    delete process.env.GROW_MARKET_ACTIVITY_ENABLED;
    const off = (await headers()).get(name);
    process.env.GROW_MARKET_ACTIVITY_ENABLED = "true";
    assert.equal((await headers()).get(name), off, `${name} changed with the flag`);
  }
  // No wildcard or other tile subdomains.
  assert.doesNotMatch(h.get("content-security-policy")!, /\*|a\.tile|b\.tile|c\.tile|connect-src/);
});
