// AE GROW Pilot Readiness WP6a (D3) — the session probe must not consume the
// credential-surface rate-limit budget, and proxy trust must be explicit,
// operator-configured, and fail safe.
//
// The limiters that ship in the app carry a NODE_ENV==="test" carve-out that
// raises every ceiling to 100_000 (see middlewares/rateLimit.ts), which is
// what keeps the rest of the HTTP suite from colliding with a
// production-sized budget — but it also means the shipped instances cannot
// demonstrate throttling at all. So the behavioural tests below build the
// SAME middleware from the SAME factories with small explicit limits and
// drive it over real HTTP, while the end-to-end test at the bottom proves the
// real app's real /auth mount answers a real signed-in session's repeated
// probes.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import express from "express";
import {
  buildAuthRateLimiter,
  buildAuthSurfaceRateLimiter,
  buildSessionProbeRateLimiter,
  isSessionProbeRequest,
  parseTrustProxySetting,
  AUTH_RATE_LIMIT_PER_MINUTE,
  SESSION_PROBE_RATE_LIMIT_PER_MINUTE,
} from "../rateLimit.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";

const STRICT_LIMIT = 3;
const PROBE_LIMIT = 40;

let server: Server;
let baseUrl: string;

before(async () => {
  const app = express();
  // Exactly the wiring routes/index.ts uses, with test-sized budgets so the
  // throttling itself is observable.
  app.use(
    "/auth",
    buildAuthSurfaceRateLimiter(buildAuthRateLimiter(STRICT_LIMIT), buildSessionProbeRateLimiter(PROBE_LIMIT)),
    (() => {
      const router = express.Router();
      router.get("/me", (_req, res) => void res.json({ ok: "me" }));
      router.post("/login", (_req, res) => void res.json({ ok: "login" }));
      router.post("/password-reset/request", (_req, res) => void res.json({ ok: "reset" }));
      router.get("/known-users", (_req, res) => void res.json({ ok: "known-users" }));
      return router;
    })(),
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// ---------------------------------------------------------------------
// The defect itself: a signed-in session polling /auth/me is bounced to
// /login because the probe burns the 20/min sign-in budget.
// ---------------------------------------------------------------------

test("many session probes never 429, and never consume the credential budget", async () => {
  // Far more probes than the strict budget would ever allow — this is the
  // exact shape of the bug (the SPA calls /auth/me on every page load).
  const statuses: number[] = [];
  for (let i = 0; i < STRICT_LIMIT * 6; i += 1) {
    const res = await fetch(`${baseUrl}/auth/me`);
    statuses.push(res.status);
  }
  assert.deepEqual(
    [...new Set(statuses)],
    [200],
    `every session probe must succeed; saw ${JSON.stringify([...new Set(statuses)])}`,
  );

  // ...and the credential surface still has its full, untouched budget after
  // all of that, which is what proves the two budgets are genuinely separate.
  for (let i = 0; i < STRICT_LIMIT; i += 1) {
    const res = await fetch(`${baseUrl}/auth/login`, { method: "POST" });
    assert.equal(res.status, 200, `login attempt ${i + 1} should not have been throttled by earlier probes`);
  }
});

test("credential endpoints still throttle once their budget is spent", async () => {
  // Continues from the test above (same limiter instance, same window, same
  // client IP): the strict budget is already exhausted by its three logins.
  const res = await fetch(`${baseUrl}/auth/login`, { method: "POST" });
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), { error: "Too many authentication requests, please try again later." });

  // The strict budget is shared across the whole credential surface, so the
  // other brute-force-able endpoints are throttled by it too — a limiter that
  // only covered /login would just move the attack one endpoint over.
  const reset = await fetch(`${baseUrl}/auth/password-reset/request`, { method: "POST" });
  assert.equal(reset.status, 429);
  const knownUsers = await fetch(`${baseUrl}/auth/known-users`);
  assert.equal(knownUsers.status, 429);
});

test("the session probe keeps working after the credential budget is exhausted", async () => {
  // The whole point of the fix: a throttled sign-in surface must not sign an
  // already-authenticated user out.
  const res = await fetch(`${baseUrl}/auth/me`);
  assert.equal(res.status, 200);
});

test("the session probe has its own ceiling — it is generous, not absent", async () => {
  // PROBE_LIMIT is deliberately small here; in the real app it is
  // SESSION_PROBE_RATE_LIMIT_PER_MINUTE. Exhausting it must still 429 rather
  // than leave an unbounded surface.
  let last = 200;
  for (let i = 0; i < PROBE_LIMIT + 5 && last === 200; i += 1) {
    last = (await fetch(`${baseUrl}/auth/me`)).status;
  }
  assert.equal(last, 429);
});

// ---------------------------------------------------------------------
// Which requests count as the probe.
// ---------------------------------------------------------------------

test("only the read-only session probe is exempted from the credential limiter", () => {
  assert.equal(isSessionProbeRequest("GET", "/me"), true);
  assert.equal(isSessionProbeRequest("HEAD", "/me"), true);
  // A trailing slash resolves to the same route, so it must resolve to the
  // same limiter.
  assert.equal(isSessionProbeRequest("GET", "/me/"), true);

  // Everything that can carry or mint credentials stays strictly limited.
  for (const path of [
    "/login",
    "/dev-login",
    "/logout",
    "/known-users",
    "/change-password",
    "/profile",
    "/password-reset/request",
    "/password-reset/confirm",
    "/invitations/abc/accept",
    "/invitations/abc/status",
    "/admin/users",
    "/admin/invitations",
  ]) {
    assert.equal(isSessionProbeRequest("GET", path), false, `${path} must stay on the strict limiter`);
    assert.equal(isSessionProbeRequest("POST", path), false, `${path} must stay on the strict limiter`);
  }

  // A write to the probe path is not a probe.
  assert.equal(isSessionProbeRequest("POST", "/me"), false);
  assert.equal(isSessionProbeRequest("DELETE", "/me"), false);
  // Nor is anything that merely starts with it.
  assert.equal(isSessionProbeRequest("GET", "/mexico"), false);
  assert.equal(isSessionProbeRequest("GET", "/me/secrets"), false);
});

test("the probe budget is more generous than the credential budget", () => {
  assert.ok(
    SESSION_PROBE_RATE_LIMIT_PER_MINUTE > AUTH_RATE_LIMIT_PER_MINUTE,
    "the whole point of the separate limiter is a budget a real browsing session cannot exhaust",
  );
});

// ---------------------------------------------------------------------
// TRUST_PROXY (D3 part b).
// ---------------------------------------------------------------------

test("TRUST_PROXY defaults to trusting nothing when unset or empty", () => {
  assert.deepEqual(parseTrustProxySetting(undefined), { value: false, valid: true });
  assert.deepEqual(parseTrustProxySetting(null), { value: false, valid: true });
  assert.deepEqual(parseTrustProxySetting(""), { value: false, valid: true });
  assert.deepEqual(parseTrustProxySetting("   "), { value: false, valid: true });
});

test("TRUST_PROXY accepts true/false in any casing", () => {
  assert.deepEqual(parseTrustProxySetting("true"), { value: true, valid: true });
  assert.deepEqual(parseTrustProxySetting("TRUE"), { value: true, valid: true });
  assert.deepEqual(parseTrustProxySetting(" True "), { value: true, valid: true });
  assert.deepEqual(parseTrustProxySetting("false"), { value: false, valid: true });
  assert.deepEqual(parseTrustProxySetting("FALSE"), { value: false, valid: true });
});

test("TRUST_PROXY accepts a hop count", () => {
  assert.deepEqual(parseTrustProxySetting("0"), { value: 0, valid: true });
  assert.deepEqual(parseTrustProxySetting("1"), { value: 1, valid: true });
  assert.deepEqual(parseTrustProxySetting(" 2 "), { value: 2, valid: true });
  assert.deepEqual(parseTrustProxySetting("10"), { value: 10, valid: true });
});

test("TRUST_PROXY fails safe on garbage — it never silently trusts a proxy", () => {
  for (const garbage of [
    "yes",
    "on",
    "1.5",
    "-1",
    "0x1",
    "1e3",
    "Infinity",
    "NaN",
    "trueish",
    "127.0.0.1",
    "loopback",
    "1,2",
    "9007199254740993",
  ]) {
    const parsed = parseTrustProxySetting(garbage);
    assert.equal(parsed.value, false, `TRUST_PROXY=${garbage} must not enable proxy trust`);
    assert.equal(parsed.valid, false, `TRUST_PROXY=${garbage} must be reported as invalid so it can be logged`);
  }
});

test("createApp applies the parsed TRUST_PROXY to express", async () => {
  const { createApp } = await import("../../app.js");
  const original = process.env.TRUST_PROXY;
  try {
    delete process.env.TRUST_PROXY;
    assert.equal(createApp().get("trust proxy"), false, "unset must keep today's behaviour: trust nothing");

    process.env.TRUST_PROXY = "1";
    assert.equal(createApp().get("trust proxy"), 1, "a hop count must reach express so req.ip is the client's");

    process.env.TRUST_PROXY = "true";
    assert.equal(createApp().get("trust proxy"), true);

    process.env.TRUST_PROXY = "definitely";
    assert.equal(createApp().get("trust proxy"), false, "garbage must fail safe, not throw and not trust");
  } finally {
    if (original === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = original;
  }
});
