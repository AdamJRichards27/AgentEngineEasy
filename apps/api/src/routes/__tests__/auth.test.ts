import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, users, brokerages, auditLogs, entitlementGrants } from "@aee/db";

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
    // AE GROW Priority 0.5 — Workstream 3: dev-login now auto-grants a run.access
    // entitlementGrants row when it creates a brand-new brokerage (see routes/auth.ts).
    // entitlementGrants.brokerageId is a non-cascading FK onto brokerages.id (see
    // packages/db/src/schema/billing.ts), so it must be deleted before the brokerage itself or
    // this cleanup fails with a foreign key violation.
    await db.delete(entitlementGrants).where(eq(entitlementGrants.brokerageId, brokerage.id));
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

// Foundation Remediation - server-side session revocation (Gap 1): logout
// (POST /api/auth/logout) has no server-side session store to delete from -
// the session cookie is just an HMAC-signed { uid, epoch, iat } (lib/
// session.ts). Revocation works by bumping the user's sessionEpoch column
// (packages/db/src/schema/users.ts) so any token minted before that bump -
// including the very one just used to log out, replayed directly here
// rather than relying on the browser to have discarded it - fails
// loadSession's epoch check (middlewares/auth.ts) on its very next use.
test("a session token that was valid before logout is rejected as unauthenticated afterward, and a fresh dev-login after logout still works", async () => {
  const previous = process.env.ALLOW_DEV_AUTH;
  process.env.ALLOW_DEV_AUTH = "true";
  const email = "revocation-target@example.com";
  const credentials = { email, firstName: "Revoke", lastName: "Target", brokerageName: testBrokerageName };
  try {
    const loginRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
    });
    assert.equal(loginRes.status, 201);
    const oldCookie = loginRes.headers.get("set-cookie")?.match(/aee_session=[^;]+/)?.[0];
    assert.ok(oldCookie, "expected a session cookie from dev-login");

    // The freshly issued token authenticates normally.
    const meBeforeLogout = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: oldCookie! } });
    assert.equal(meBeforeLogout.status, 200);

    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { cookie: oldCookie! } });
    assert.equal(logoutRes.status, 204);

    // Replaying that SAME token after logout - it never expired and its
    // signature is still valid - must now be rejected. This is the core
    // new behaviour: without epoch-based revocation this request would
    // still succeed for the token's full 30-day lifetime.
    const meAfterLogout = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: oldCookie! } });
    assert.equal(meAfterLogout.status, 401);

    // Logging out bumps the epoch for the whole user, not just "this"
    // token - so a brand new dev-login for the SAME user right after
    // logout must mint a token against the new epoch and authenticate
    // fine. Logout must not lock the user out of signing back in.
    const reLoginRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
    });
    assert.equal(reLoginRes.status, 200);
    const newCookie = reLoginRes.headers.get("set-cookie")?.match(/aee_session=[^;]+/)?.[0];
    assert.ok(newCookie, "expected a session cookie from the post-logout dev-login");
    assert.notEqual(newCookie, oldCookie, "the re-issued token must differ from the revoked one");

    const meAfterReLogin = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: newCookie! } });
    assert.equal(meAfterReLogin.status, 200);
    const meBody = (await meAfterReLogin.json()) as { user: { email: string } };
    assert.equal(meBody.user.email, email);
  } finally {
    if (previous === undefined) delete process.env.ALLOW_DEV_AUTH;
    else process.env.ALLOW_DEV_AUTH = previous;
  }
});

// Foundation Remediation - auth event auditing (Gap 2): only first-time
// signup (user_signed_up) was previously audited; an existing user signing
// in, and logout, were not.
test("dev-login by an existing user and logout each write their own audit log entry", async () => {
  const previous = process.env.ALLOW_DEV_AUTH;
  process.env.ALLOW_DEV_AUTH = "true";
  const email = "audit-target@example.com";
  const credentials = { email, firstName: "Audit", lastName: "Target", brokerageName: testBrokerageName };
  try {
    // First dev-login for this email creates the account (user_signed_up -
    // already covered by existing coverage above). The SECOND dev-login is
    // the "existing user signs in" branch this test targets.
    await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
    });
    const signInRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(credentials),
    });
    assert.equal(signInRes.status, 200);
    const cookie = signInRes.headers.get("set-cookie")?.match(/aee_session=[^;]+/)?.[0];
    const { user } = (await signInRes.json()) as { user: { id: number } };

    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers: { cookie: cookie! } });
    assert.equal(logoutRes.status, 204);

    const signInAudit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.userId, user.id), eq(auditLogs.action, "user_signed_in")));
    assert.equal(signInAudit.length, 1, "expected exactly one user_signed_in audit entry");
    assert.equal(signInAudit[0].recordType, "user");
    assert.equal(signInAudit[0].recordId, String(user.id));
    assert.equal(signInAudit[0].userEmail, email);

    const signOutAudit = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.userId, user.id), eq(auditLogs.action, "user_signed_out")));
    assert.equal(signOutAudit.length, 1, "expected exactly one user_signed_out audit entry");
    assert.equal(signOutAudit[0].recordType, "user");
    assert.equal(signOutAudit[0].recordId, String(user.id));
    // Never the token/cookie value itself - only the epoch counter, which
    // is not a credential.
    assert.equal(signOutAudit[0].previousValue, "0");
    assert.equal(signOutAudit[0].updatedValue, "1");
  } finally {
    if (previous === undefined) delete process.env.ALLOW_DEV_AUTH;
    else process.env.ALLOW_DEV_AUTH = previous;
  }
});
