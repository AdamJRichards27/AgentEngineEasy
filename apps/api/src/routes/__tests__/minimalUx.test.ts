import { test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { cleanupBrokerages, devLogin, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

const FLAG = "AE_MINIMAL_UX_ENABLED";
const LIST = "AE_MINIMAL_UX_ALLOWLIST";

function restoreEnv(previous: Record<string, string | undefined>): void {
  for (const key of Object.keys(previous)) {
    const value = previous[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("AE Minimal flag, allowlist, classic switch, and brokerage isolation", async () => {
  const previous = { [FLAG]: process.env[FLAG], [LIST]: process.env[LIST] };
  delete process.env[FLAG];
  delete process.env[LIST];
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  let a: DevLoginResult | undefined;
  let b: DevLoginResult | undefined;

  async function me(cookie: string) {
    const res = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
    const body = await res.json() as {
      user: { id: number; email: string; brokerageId: number };
      entitlements: string[];
      ux: { eligible: boolean; variant: string };
    };
    return { status: res.status, body };
  }

  try {
    a = await devLogin(baseUrl, {
      email: `minimal-a-${suffix}@example.com`,
      firstName: "Ada",
      lastName: "Allow",
      brokerageName: `Minimal UX A ${suffix}`,
    });
    b = await devLogin(baseUrl, {
      email: `minimal-b-${suffix}@example.com`,
      firstName: "Bea",
      lastName: "Other",
      brokerageName: `Minimal UX B ${suffix}`,
    });

    const offA = await me(a.cookie);
    const offB = await me(b.cookie);
    assert.equal(offA.status, 200);
    assert.equal(offB.status, 200);
    assert.deepEqual(offA.body.ux, { eligible: false, variant: "classic" });
    assert.deepEqual(offB.body.ux, { eligible: false, variant: "classic" });
    assert.equal(offA.body.user.brokerageId === offB.body.user.brokerageId, false);
    assert.equal(JSON.stringify(offB.body).includes(a.user.email), false);
    assert.equal(offA.body.entitlements.includes("run.access"), true);
    assert.equal(offB.body.entitlements.includes("run.access"), true);

    process.env[FLAG] = "true";
    process.env[LIST] = "";
    assert.deepEqual((await me(a.cookie)).body.ux, { eligible: false, variant: "classic" });

    process.env[LIST] = a.user.email.toUpperCase();
    const onA = await me(a.cookie);
    const onB = await me(b.cookie);
    assert.deepEqual(onA.body.ux, { eligible: true, variant: "minimal" });
    assert.deepEqual(onB.body.ux, { eligible: false, variant: "classic" });
    assert.deepEqual(Object.keys(onA.body.ux).sort(), ["eligible", "variant"]);
    assert.equal(JSON.stringify(onB.body).includes(a.user.email), false);
    assert.equal(onA.body.user.brokerageId, a.user.brokerageId);
    assert.equal(onB.body.user.brokerageId, b.user.brokerageId);

    const denied = await fetch(`${baseUrl}/api/auth/ux-view`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: b.cookie },
      body: JSON.stringify({ variant: "minimal" }),
    });
    assert.equal(denied.status, 403);
    assert.deepEqual((await me(b.cookie)).body.ux, { eligible: false, variant: "classic" });

    const forged = await fetch(`${baseUrl}/api/auth/ux-view`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: b.cookie },
      body: JSON.stringify({ variant: "minimal", email: a.user.email, userId: a.user.id }),
    });
    assert.equal(forged.status, 400);
    assert.deepEqual((await me(b.cookie)).body.ux, { eligible: false, variant: "classic" });

    const anon = await fetch(`${baseUrl}/api/auth/ux-view`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ variant: "minimal" }),
    });
    assert.equal(anon.status, 401);

    const classic = await fetch(`${baseUrl}/api/auth/ux-view`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: a.cookie },
      body: JSON.stringify({ variant: "classic" }),
    });
    assert.equal(classic.status, 200);
    const setCookies = classic.headers.getSetCookie();
    const uxCookie = setCookies.find((value) => value.startsWith("aee_ux_view="));
    assert.ok(uxCookie, "classic switch did not set the view cookie");
    assert.match(uxCookie, new RegExp(`aee_ux_view=${a.user.id}\\.classic`));
    assert.match(uxCookie, /HttpOnly/i);
    assert.match(uxCookie, /SameSite=Lax/i);
    const classicPair = uxCookie.split(";")[0] ?? "";
    assert.deepEqual((await me(`${a.cookie}; ${classicPair}`)).body.ux, { eligible: true, variant: "classic" });

    const again = await fetch(`${baseUrl}/api/auth/ux-view`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: a.cookie },
      body: JSON.stringify({ variant: "minimal" }),
    });
    assert.equal(again.status, 200);
    const minimalCookie = again.headers.getSetCookie().find((value) => value.startsWith("aee_ux_view="));
    assert.match(minimalCookie ?? "", new RegExp(`aee_ux_view=${a.user.id}\\.minimal`));
    assert.deepEqual((await me(`${a.cookie}; ${minimalCookie?.split(";")[0]}`)).body.ux, { eligible: true, variant: "minimal" });
    assert.deepEqual((await me(`${b.cookie}; ${classicPair}`)).body.ux, { eligible: false, variant: "classic" });

    const address = `1 Minimal Isolation St ${suffix}`;
    const created = await fetch(`${baseUrl}/api/properties`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: a.cookie },
      body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
    });
    assert.equal(created.status, 201, await created.clone().text());
    const { property } = await created.json() as { property: { id: number } };
    const cross = await fetch(`${baseUrl}/api/properties/${property.id}`, { headers: { cookie: b.cookie } });
    assert.equal(cross.status, 404);
    const own = await fetch(`${baseUrl}/api/properties/${property.id}`, { headers: { cookie: a.cookie } });
    assert.equal(own.status, 200);
    const list = await fetch(`${baseUrl}/api/properties`, { headers: { cookie: b.cookie } });
    assert.equal(list.status, 200);
    assert.equal((await list.text()).includes(address), false);
    assert.deepEqual((await me(a.cookie)).body.ux.variant === "minimal" || (await me(`${a.cookie}; ${minimalCookie?.split(";")[0]}`)).body.ux.variant === "minimal", true);
  } finally {
    restoreEnv(previous);
    await cleanupBrokerages([a?.user.brokerageId, b?.user.brokerageId].filter((id): id is number => typeof id === "number"));
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
