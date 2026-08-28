import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, users, brokerages } from "@aee/db";

// Foundation Remediation Stage 1.5: end-to-end proof, over real HTTP against
// the real Express app, that:
//   - /auth/dev-login and /auth/known-users are unreachable (404) unless an
//     operator has explicitly set ALLOW_DEV_AUTH=true;
//   - when explicitly enabled, dev-login still never lets the caller pick
//     their own role or brokerage - that is derived entirely server-side;
//   - a forged or malformed session is rejected by requireAuth.
// Uses the platform's own global fetch against a real listening server
// (no new test-http dependency) - the same pattern used throughout apps/api.

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";

let server: Server;
let baseUrl: string;
const testBrokerageName = `Foundation Remediation Auth Test ${Date.now()}`;

before(async () => {
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  const [brokerage] = await db.select().from(brokerages).where(eq(brokerages.name, testBrokerageName));
  if (brokerage) {
    await db.delete(users).where(eq(users.brokerageId, brokerage.id));
    await db.delete(brokerages).where(eq(brokerages.id, brokerage.id));
  }
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test("GET /api/auth/known-users is unavailable (404) when ALLOW_DEV_AUTH is unset", async () => {
  const previous = process.env.ALLOW_DEV_AUTH;
  delete process.env.ALLOW_DEV_AUTH;
  try {
    const res = await fetch(`${baseUrl}/api/auth/known-users`);
    assert.equal(res.status, 404);
  } finally {
    if (previous === undefined) delete process.env.ALLOW_DEV_AUTH;
    else process.env.ALLOW_DEV_AUTH = previous;
  }
});

test("POST /api/auth/dev-login is unavailable (404) when ALLOW_DEV_AUTH is unset", async () => {
  const previous = process.env.ALLOW_DEV_AUTH;
  delete process.env.ALLOW_DEV_AUTH;
  try {
    const res = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "should-not-be-created@example.com",
        firstName: "Should",
        lastName: "NotExist",
        brokerageName: testBrokerageName,
      }),
    });
    assert.equal(res.status, 404);
    const [existing] = await db.select().from(users).where(eq(users.email, "should-not-be-created@example.com"));
    assert.equal(existing, undefined, "dev-login must not create a user while disabled");
  } finally {
    if (previous === undefined) delete process.env.ALLOW_DEV_AUTH;
    else process.env.ALLOW_DEV_AUTH = previous;
  }
});

test("dev-login remains functional when explicitly enabled, and the caller cannot choose their own role or brokerage", async () => {
  const previous = process.env.ALLOW_DEV_AUTH;
  process.env.ALLOW_DEV_AUTH = "true";
  try {
    const res = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "founder@example.com",
        firstName: "Founder",
        lastName: "Agent",
        brokerageName: testBrokerageName,
        // Attempting to smuggle a privileged role/brokerage in the body.
        // devLoginSchema does not declare these fields, so zod's default
        // (non-strict) parsing simply ignores them - role and brokerage
        // are derived entirely server-side from the brokerage-membership
        // logic in routes/auth.ts, never from client input.
        role: "Brokerage Administrator",
        brokerageId: 999999,
      }),
    });
    assert.equal(res.status, 201);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /aee_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, /Secure/, "session cookie must be Secure by default");
    const body = (await res.json()) as { user: { role: string; email: string } };
    // First user ever created against a brand-new brokerage becomes its
    // admin - that is legitimate server-side business logic, not a
    // client-chosen role. What matters is that a *second* user in the
    // same brokerage cannot also claim it (checked in the next test).
    assert.equal(body.user.email, "founder@example.com");
    assert.equal(body.user.role, "Brokerage Administrator");
  } finally {
    if (previous === undefined) delete process.env.ALLOW_DEV_AUTH;
    else process.env.ALLOW_DEV_AUTH = previous;
  }
});

test("a second dev-login against the same brokerage is never granted admin, even if it asks for one", async () => {
  const previous = process.env.ALLOW_DEV_AUTH;
  process.env.ALLOW_DEV_AUTH = "true";
  try {
    const res = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "second-user@example.com",
        firstName: "Second",
        lastName: "User",
        brokerageName: testBrokerageName,
        role: "Brokerage Administrator",
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { user: { role: string } };
    assert.equal(body.user.role, "Agent", "only the first user in a brokerage may become its admin");
  } finally {
    if (previous === undefined) delete process.env.ALLOW_DEV_AUTH;
    else process.env.ALLOW_DEV_AUTH = previous;
  }
});

test("GET /api/auth/me rejects a missing session with 401", async () => {
  const res = await fetch(`${baseUrl}/api/auth/me`);
  assert.equal(res.status, 401);
});

test("GET /api/auth/me rejects a forged session cookie with 401", async () => {
  const res = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: "aee_session=not.avalidtoken" },
  });
  assert.equal(res.status, 401);
});

test("GET /api/auth/me rejects a well-formed but wrongly-signed session cookie with 401", async () => {
  const forgedPayload = Buffer.from(JSON.stringify({ uid: 1, iat: Date.now() })).toString("base64url");
  const res = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { cookie: `aee_session=${forgedPayload}.not-a-real-signature` },
  });
  assert.equal(res.status, 401);
});
