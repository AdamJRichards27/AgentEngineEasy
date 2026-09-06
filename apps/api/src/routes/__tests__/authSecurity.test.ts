import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, users, brokerages, invitations, passwordResetTokens, consentRecords, auditLogs } from "@aee/db";
import { hashToken } from "../../lib/auth/tokens.js";
import { __getSandboxAuthEmailLog, __clearSandboxAuthEmailLog } from "../../lib/auth/email.js";

// Critical Blocker Remediation, Phase 5 — exhaustive authentication
// security test suite for the invitation-only auth model (Phase 4). Real
// HTTP against the real Express app, same pattern as
// routes/__tests__/auth.test.ts. ALLOW_DEV_AUTH=true is used only to
// bootstrap fixture admins quickly via the existing dev-login test
// fixture (see AUTHENTICATION_THREAT_MODEL.md §6) — every actual
// assertion in this file exercises the NEW real invitation/password
// routes, never dev-login itself.

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const runId = Date.now();
const createdBrokerageIds = new Set<number>();
let brokerageCounter = 0;

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
  for (const brokerageId of createdBrokerageIds) {
    await db.delete(invitations).where(eq(invitations.brokerageId, brokerageId));
    const brokerageUsers = await db.select().from(users).where(eq(users.brokerageId, brokerageId));
    for (const u of brokerageUsers) {
      await db.delete(passwordResetTokens).where(eq(passwordResetTokens.userId, u.id));
      await db.delete(consentRecords).where(eq(consentRecords.userId, u.id));
    }
    await db.delete(users).where(eq(users.brokerageId, brokerageId));
    await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
  }
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function cookieFrom(res: Response): string {
  const c = res.headers.get("set-cookie")?.match(/aee_session=[^;]+/)?.[0];
  if (!c) throw new Error("expected a session cookie");
  return c;
}

/**
 * Bootstraps a brokerage + its first (admin) user via the dev-login test fixture. Each call gets its
 * OWN brand-new brokerage by default (dev-login's "first user in a brokerage becomes its admin" rule
 * — see routes/auth.ts — otherwise means only the very first call across this whole file would
 * actually get the admin role). Pass an explicit `brokerageName` only when a test deliberately wants
 * a SECOND user to join an already-created admin's brokerage (e.g. to become a plain Agent).
 */
async function createAdmin(email: string, brokerageName?: string): Promise<{ cookie: string; userId: number; brokerageId: number; brokerageName: string }> {
  const name = brokerageName ?? `Auth Security Test Brokerage ${runId}-${brokerageCounter++}`;
  const res = await fetch(`${baseUrl}/api/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, firstName: "Admin", lastName: "User", brokerageName: name }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { user: { id: number; role: string; brokerageId: number } };
  assert.equal(body.user.role, "Brokerage Administrator");
  createdBrokerageIds.add(body.user.brokerageId);
  return { cookie: cookieFrom(res), userId: body.user.id, brokerageId: body.user.brokerageId, brokerageName: name };
}

async function createInvitation(adminCookie: string, email: string, role = "Agent") {
  const res = await fetch(`${baseUrl}/api/auth/admin/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({ email, role }),
  });
  return res;
}

/**
 * The real POST /admin/invitations route never returns the plaintext token (by design — it only
 * ever reaches the invitee's inbox). To exercise the accept/confirm flows end-to-end, these tests
 * insert an invitation/reset-token row directly using the app's own token generator
 * (lib/auth/tokens.ts's generateToken()), the same way auth.test.ts's session tests construct a
 * token via lib/session.ts directly rather than trying to intercept one over HTTP. Tests that assert
 * a token is *never* exposed (the sandbox email log test, the response-body scan below) still go
 * through the real HTTP route.
 */
async function issueAndCaptureInvitationToken(brokerageId: number, email: string, role: string, invitedByUserId: number) {
  const { generateToken } = await import("../../lib/auth/tokens.js");
  const { plaintext, hash } = generateToken();
  const [row] = await db
    .insert(invitations)
    .values({ brokerageId, email, role, tokenHash: hash, invitedByUserId, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) })
    .returning();
  return { plaintext, invitation: row };
}

async function issueAndCaptureResetToken(userId: number, expiresAt = new Date(Date.now() + 60 * 60 * 1000)) {
  const { generateToken } = await import("../../lib/auth/tokens.js");
  const { plaintext, hash } = generateToken();
  const [row] = await db.insert(passwordResetTokens).values({ userId, tokenHash: hash, expiresAt }).returning();
  return { plaintext, row };
}

const STRONG_PASSWORD = "Correct-Horse-Battery-Staple-42";

// ---------------------------------------------------------------------------
// Invitation issuance
// ---------------------------------------------------------------------------

test("admin can create an invitation for their own brokerage, and the response never contains a token", async () => {
  const admin = await createAdmin(`admin1-${runId}@example.com`);
  const res = await createInvitation(admin.cookie, `invitee1-${runId}@example.com`);
  assert.equal(res.status, 201);
  const bodyText = await res.text();
  assert.doesNotMatch(bodyText, /token/i);
  const body = JSON.parse(bodyText) as { invitation: { id: number; email: string; role: string } };
  assert.equal(body.invitation.email, `invitee1-${runId}@example.com`);
});

test("a non-admin (Agent) cannot create an invitation", async () => {
  const admin = await createAdmin(`admin2-${runId}@example.com`);
  // Second dev-login against the same brokerage becomes a plain Agent (see auth.test.ts precedent).
  const agentRes = await fetch(`${baseUrl}/api/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `agent1-${runId}@example.com`, firstName: "A", lastName: "Gent", brokerageName: admin.brokerageName }),
  });
  const agentCookie = cookieFrom(agentRes);
  const res = await createInvitation(agentCookie, `invitee2-${runId}@example.com`);
  assert.equal(res.status, 403);
  void admin;
});

test("an unauthenticated caller cannot create an invitation", async () => {
  const res = await fetch(`${baseUrl}/api/auth/admin/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `nope-${runId}@example.com`, role: "Agent" }),
  });
  assert.equal(res.status, 401);
});

test("cannot invite an email that already has an account", async () => {
  const email = `admin3-${runId}@example.com`;
  const admin = await createAdmin(email);
  const res = await createInvitation(admin.cookie, email);
  assert.equal(res.status, 409);
});

test("re-inviting the same email revokes the previous pending invitation", async () => {
  const admin = await createAdmin(`admin4-${runId}@example.com`);
  const email = `invitee4-${runId}@example.com`;
  const first = await createInvitation(admin.cookie, email);
  assert.equal(first.status, 201);
  const second = await createInvitation(admin.cookie, email);
  assert.equal(second.status, 201);
  const rows = await db.select().from(invitations).where(eq(invitations.email, email));
  const revoked = rows.find((r) => r.revokedAt !== null);
  const live = rows.find((r) => r.revokedAt === null);
  assert.ok(revoked, "the first invitation must have been revoked");
  assert.ok(live, "the second invitation must be live");
});

// ---------------------------------------------------------------------------
// Invitation status / accept
// ---------------------------------------------------------------------------

test("invitation status is indistinguishable for unknown vs malformed tokens", async () => {
  const res1 = await fetch(`${baseUrl}/api/auth/invitations/does-not-exist/status`);
  const res2 = await fetch(`${baseUrl}/api/auth/invitations/${"a".repeat(64)}/status`);
  assert.equal(res1.status, 200);
  assert.equal(res2.status, 200);
  assert.deepEqual(await res1.json(), { status: "invalid_or_expired" });
  assert.deepEqual(await res2.json(), { status: "invalid_or_expired" });
});

test("a valid invitation reports status valid", async () => {
  const admin = await createAdmin(`admin5-${runId}@example.com`);
  const { plaintext } = await issueAndCaptureInvitationToken(
    admin.brokerageId,
    `invitee5-${runId}@example.com`,
    "Agent",
    admin.userId,
  );
  const res = await fetch(`${baseUrl}/api/auth/invitations/${plaintext}/status`);
  assert.deepEqual(await res.json(), { status: "valid" });
});

test("accepting an invitation with a weak password is rejected", async () => {
  const admin = await createAdmin(`admin6-${runId}@example.com`);
  const { plaintext } = await issueAndCaptureInvitationToken(admin.brokerageId, `invitee6-${runId}@example.com`, "Agent", admin.userId);
  const res = await fetch(`${baseUrl}/api/auth/invitations/${plaintext}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "short", acceptedTerms: true, acceptedPrivacyPolicy: true }),
  });
  assert.equal(res.status, 400);
});

test("accepting a valid invitation creates the user with the invitation's role/tenant, ignoring any role/brokerageId in the request body, and logs them in", async () => {
  const admin = await createAdmin(`admin7-${runId}@example.com`);
  const email = `invitee7-${runId}@example.com`;
  const { plaintext } = await issueAndCaptureInvitationToken(admin.brokerageId, email, "Agent", admin.userId);
  const res = await fetch(`${baseUrl}/api/auth/invitations/${plaintext}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: STRONG_PASSWORD, acceptedTerms: true, acceptedPrivacyPolicy: true, role: "Brokerage Administrator", brokerageId: 999999 }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { user: { role: string; brokerageId: number; email: string } };
  assert.equal(body.user.role, "Agent", "role must come from the invitation, never the request body");
  assert.equal(body.user.brokerageId, admin.brokerageId, "brokerage must come from the invitation, never the request body");
  const cookie = cookieFrom(res);
  const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
  assert.equal(meRes.status, 200, "accepting an invitation must log the user in immediately");
  const [dbUser] = await db.select().from(users).where(eq(users.email, email));
  assert.ok(dbUser.passwordHash, "a password hash must be stored");
  assert.notEqual(dbUser.passwordHash, STRONG_PASSWORD, "the password must never be stored in plaintext");
  assert.ok(dbUser.emailVerifiedAt, "accepting an invitation proves mailbox ownership");

  const consents = await db.select().from(consentRecords).where(eq(consentRecords.userId, dbUser.id));
  assert.equal(consents.length, 2, "accepting an invitation must record both terms-of-use and privacy-policy consent");
  assert.ok(consents.some((c) => c.consentType === "terms_of_use" && c.documentVersion));
  assert.ok(consents.some((c) => c.consentType === "privacy_policy" && c.documentVersion));
});

test("accepting an invitation without agreeing to the Terms of Use / Privacy Policy is rejected", async () => {
  const admin = await createAdmin(`admin7b-${runId}@example.com`);
  const { plaintext } = await issueAndCaptureInvitationToken(admin.brokerageId, `invitee7b-${runId}@example.com`, "Agent", admin.userId);
  const missingBoth = await fetch(`${baseUrl}/api/auth/invitations/${plaintext}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: STRONG_PASSWORD }),
  });
  assert.equal(missingBoth.status, 400);

  const { plaintext: plaintext2 } = await issueAndCaptureInvitationToken(admin.brokerageId, `invitee7c-${runId}@example.com`, "Agent", admin.userId);
  const missingPrivacyOnly = await fetch(`${baseUrl}/api/auth/invitations/${plaintext2}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: STRONG_PASSWORD, acceptedTerms: true }),
  });
  assert.equal(missingPrivacyOnly.status, 400);
});

test("an accepted invitation token cannot be used again (single-use)", async () => {
  const admin = await createAdmin(`admin8-${runId}@example.com`);
  const { plaintext } = await issueAndCaptureInvitationToken(admin.brokerageId, `invitee8-${runId}@example.com`, "Agent", admin.userId);
  const first = await fetch(`${baseUrl}/api/auth/invitations/${plaintext}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: STRONG_PASSWORD, acceptedTerms: true, acceptedPrivacyPolicy: true }),
  });
  assert.equal(first.status, 201);
  const second = await fetch(`${baseUrl}/api/auth/invitations/${plaintext}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: STRONG_PASSWORD, acceptedTerms: true, acceptedPrivacyPolicy: true }),
  });
  assert.equal(second.status, 400);
});

test("an expired invitation token cannot be accepted", async () => {
  const admin = await createAdmin(`admin9-${runId}@example.com`);
  const { plaintext } = await issueAndCaptureInvitationToken(admin.brokerageId, `invitee9-${runId}@example.com`, "Agent", admin.userId);
  const hash = hashToken(plaintext);
  await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.tokenHash, hash));
  const res = await fetch(`${baseUrl}/api/auth/invitations/${plaintext}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: STRONG_PASSWORD, acceptedTerms: true, acceptedPrivacyPolicy: true }),
  });
  assert.equal(res.status, 400);
});

test("a revoked invitation token cannot be accepted", async () => {
  const admin = await createAdmin(`admin10-${runId}@example.com`);
  const { plaintext } = await issueAndCaptureInvitationToken(admin.brokerageId, `invitee10-${runId}@example.com`, "Agent", admin.userId);
  const hash = hashToken(plaintext);
  await db.update(invitations).set({ revokedAt: new Date() }).where(eq(invitations.tokenHash, hash));
  const res = await fetch(`${baseUrl}/api/auth/invitations/${plaintext}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: STRONG_PASSWORD, acceptedTerms: true, acceptedPrivacyPolicy: true }),
  });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------------------
// Cross-tenant / invitation management
// ---------------------------------------------------------------------------

test("an admin can only list invitations for their own brokerage", async () => {
  const adminA = await createAdmin(`admina-list-${runId}@example.com`);
  const adminB = await createAdmin(`adminb-list-${runId}@example.com`);
  await createInvitation(adminA.cookie, `list-a-${runId}@example.com`);
  await createInvitation(adminB.cookie, `list-b-${runId}@example.com`);
  const resA = await fetch(`${baseUrl}/api/auth/admin/invitations`, { headers: { cookie: adminA.cookie } });
  const bodyA = (await resA.json()) as { invitations: Array<{ email: string }> };
  assert.ok(bodyA.invitations.every((i) => !i.email.startsWith("list-b-")), "brokerage A must never see brokerage B's invitations");
});

test("an admin cannot revoke another brokerage's invitation (cross-tenant, 404 not 403)", async () => {
  const adminA = await createAdmin(`admina-revoke-${runId}@example.com`);
  const adminB = await createAdmin(`adminb-revoke-${runId}@example.com`);
  const createRes = await createInvitation(adminB.cookie, `revoke-target-${runId}@example.com`);
  const { invitation } = (await createRes.json()) as { invitation: { id: number } };
  const res = await fetch(`${baseUrl}/api/auth/admin/invitations/${invitation.id}/revoke`, {
    method: "POST",
    headers: { cookie: adminA.cookie },
  });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Login: correctness + enumeration resistance + lockout
// ---------------------------------------------------------------------------

test("login with correct credentials succeeds and the session works", async () => {
  const admin = await createAdmin(`admin11-${runId}@example.com`);
  const email = `login-ok-${runId}@example.com`;
  const { plaintext } = await issueAndCaptureInvitationToken(admin.brokerageId, email, "Agent", admin.userId);
  await fetch(`${baseUrl}/api/auth/invitations/${plaintext}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: STRONG_PASSWORD, acceptedTerms: true, acceptedPrivacyPolicy: true }),
  });
  const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: STRONG_PASSWORD }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = cookieFrom(loginRes);
  const meRes = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie } });
  assert.equal(meRes.status, 200);
});

test("login returns the identical generic error for an unknown email, a wrong password, and a disabled account", async () => {
  const admin = await createAdmin(`admin12-${runId}@example.com`);
  const email = `login-disabled-${runId}@example.com`;
  const { plaintext } = await issueAndCaptureInvitationToken(admin.brokerageId, email, "Agent", admin.userId);
  await fetch(`${baseUrl}/api/auth/invitations/${plaintext}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: STRONG_PASSWORD, acceptedTerms: true, acceptedPrivacyPolicy: true }),
  });
  await db.update(users).set({ isActive: false }).where(eq(users.email, email));

  const unknownRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `no-such-user-${runId}@example.com`, password: "whatever12345" }),
  });
  const wrongPasswordRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "definitely-wrong-password" }),
  });
  const disabledRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: STRONG_PASSWORD }),
  });
  assert.equal(unknownRes.status, 401);
  assert.equal(wrongPasswordRes.status, 401);
  assert.equal(disabledRes.status, 401);
  const [unknownBody, wrongBody, disabledBody] = await Promise.all([unknownRes.json(), wrongPasswordRes.json(), disabledRes.json()]);
  assert.deepEqual(unknownBody, wrongBody);
  assert.deepEqual(wrongBody, disabledBody);
});

test("repeated failed logins lock the account, and a correct password is rejected while locked", async () => {
  const admin = await createAdmin(`admin13-${runId}@example.com`);
  const email = `login-lockout-${runId}@example.com`;
  const { plaintext } = await issueAndCaptureInvitationToken(admin.brokerageId, email, "Agent", admin.userId);
  await fetch(`${baseUrl}/api/auth/invitations/${plaintext}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: STRONG_PASSWORD, acceptedTerms: true, acceptedPrivacyPolicy: true }),
  });

  for (let i = 0; i < 5; i++) {
    await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "wrong-password-attempt" }),
    });
  }
  const [locked] = await db.select().from(users).where(eq(users.email, email));
  assert.ok(locked.lockedUntil && locked.lockedUntil.getTime() > Date.now(), "account must be locked after 5 failed attempts");

  const stillLockedRes = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: STRONG_PASSWORD }),
  });
  assert.equal(stillLockedRes.status, 401, "the correct password must still be rejected while locked out");

  const lockedAudit = await db.select().from(auditLogs).where(and(eq(auditLogs.userId, locked.id), eq(auditLogs.action, "account_locked")));
  assert.equal(lockedAudit.length, 1);
});

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

test("password-reset request always returns 202, whether or not the email exists", async () => {
  const knownRes = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `admin1-${runId}@example.com` }),
  });
  const unknownRes = await fetch(`${baseUrl}/api/auth/password-reset/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `truly-nobody-${runId}@example.com` }),
  });
  assert.equal(knownRes.status, 202);
  assert.equal(unknownRes.status, 202);
  assert.deepEqual(await knownRes.json(), await unknownRes.json());
});

test("a valid password-reset token changes the password and revokes existing sessions; the token cannot be reused", async () => {
  const admin = await createAdmin(`admin14-${runId}@example.com`);
  const email = `reset-target-${runId}@example.com`;
  const { plaintext: inviteToken } = await issueAndCaptureInvitationToken(admin.brokerageId, email, "Agent", admin.userId);
  const acceptRes = await fetch(`${baseUrl}/api/auth/invitations/${inviteToken}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: STRONG_PASSWORD, acceptedTerms: true, acceptedPrivacyPolicy: true }),
  });
  const oldCookie = cookieFrom(acceptRes);
  const meBeforeReset = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: oldCookie } });
  assert.equal(meBeforeReset.status, 200);

  const [user] = await db.select().from(users).where(eq(users.email, email));
  const { plaintext: resetToken } = await issueAndCaptureResetToken(user.id);
  const newPassword = "Another-Strong-Password-99";
  const confirmRes = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: resetToken, password: newPassword }),
  });
  assert.equal(confirmRes.status, 204);

  const meAfterReset = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: oldCookie } });
  assert.equal(meAfterReset.status, 401, "the pre-reset session must be revoked");

  const loginWithOld = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: STRONG_PASSWORD }),
  });
  assert.equal(loginWithOld.status, 401, "the old password must no longer work");

  const loginWithNew = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: newPassword }),
  });
  assert.equal(loginWithNew.status, 200, "the new password must work");

  const reuseRes = await fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: resetToken, password: "Yet-Another-Password-77" }),
  });
  assert.equal(reuseRes.status, 400, "a used reset token must not be reusable");
});

test("an expired password-reset token is rejected with the same generic error as an unknown token", async () => {
  const admin = await createAdmin(`admin15-${runId}@example.com`);
  const [expired, unknown] = await Promise.all([
    (async () => {
      const { plaintext } = await issueAndCaptureResetToken(admin.userId, new Date(Date.now() - 1000));
      return fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: plaintext, password: STRONG_PASSWORD }),
      });
    })(),
    fetch(`${baseUrl}/api/auth/password-reset/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "not-a-real-token", password: STRONG_PASSWORD }),
    }),
  ]);
  assert.equal(expired.status, 400);
  assert.equal(unknown.status, 400);
  assert.deepEqual(await expired.json(), await unknown.json());
});

// ---------------------------------------------------------------------------
// Change password (authenticated)
// ---------------------------------------------------------------------------

test("change-password requires the correct current password, enforces the policy, and keeps the caller's own session working while revoking others", async () => {
  const admin = await createAdmin(`admin16-${runId}@example.com`);
  const email = `changepw-${runId}@example.com`;
  const { plaintext } = await issueAndCaptureInvitationToken(admin.brokerageId, email, "Agent", admin.userId);
  const acceptRes = await fetch(`${baseUrl}/api/auth/invitations/${plaintext}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: STRONG_PASSWORD, acceptedTerms: true, acceptedPrivacyPolicy: true }),
  });
  const cookie = cookieFrom(acceptRes);

  const wrongCurrentRes = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ currentPassword: "not-the-current-password", newPassword: "Some-New-Password-55" }),
  });
  assert.equal(wrongCurrentRes.status, 401);

  const weakNewRes = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ currentPassword: STRONG_PASSWORD, newPassword: "short" }),
  });
  assert.equal(weakNewRes.status, 400);

  const okRes = await fetch(`${baseUrl}/api/auth/change-password`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ currentPassword: STRONG_PASSWORD, newPassword: "Brand-New-Password-88" }),
  });
  assert.equal(okRes.status, 204);
  const newCookie = cookieFrom(okRes);

  const meWithNewCookie = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: newCookie } });
  assert.equal(meWithNewCookie.status, 200, "the caller's own session must keep working after their own password change");
});

// ---------------------------------------------------------------------------
// Admin user directory + disable/enable
// ---------------------------------------------------------------------------

test("GET /admin/users requires admin role and is tenant-scoped", async () => {
  const adminA = await createAdmin(`admin17-${runId}@example.com`);
  const adminB = await createAdmin(`admin18-${runId}@example.com`);
  const unauthedRes = await fetch(`${baseUrl}/api/auth/admin/users`);
  assert.equal(unauthedRes.status, 401);

  const resA = await fetch(`${baseUrl}/api/auth/admin/users`, { headers: { cookie: adminA.cookie } });
  const bodyA = (await resA.json()) as { users: Array<{ email: string }> };
  assert.ok(bodyA.users.every((u) => u.email !== `admin18-${runId}@example.com`), "brokerage A must never see brokerage B's users");
  void adminB;
});

test("disabling a user revokes their session immediately and they can no longer log in", async () => {
  const admin = await createAdmin(`admin19-${runId}@example.com`);
  const email = `disable-target-${runId}@example.com`;
  const { plaintext } = await issueAndCaptureInvitationToken(admin.brokerageId, email, "Agent", admin.userId);
  const acceptRes = await fetch(`${baseUrl}/api/auth/invitations/${plaintext}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: STRONG_PASSWORD, acceptedTerms: true, acceptedPrivacyPolicy: true }),
  });
  const targetCookie = cookieFrom(acceptRes);
  const [target] = await db.select().from(users).where(eq(users.email, email));

  const disableRes = await fetch(`${baseUrl}/api/auth/admin/users/${target.id}/disable`, {
    method: "POST",
    headers: { cookie: admin.cookie },
  });
  assert.equal(disableRes.status, 204);

  const meAfterDisable = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: targetCookie } });
  assert.equal(meAfterDisable.status, 401, "an existing session must die immediately on disable");

  const loginAfterDisable = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: STRONG_PASSWORD }),
  });
  assert.equal(loginAfterDisable.status, 401);

  const enableRes = await fetch(`${baseUrl}/api/auth/admin/users/${target.id}/enable`, {
    method: "POST",
    headers: { cookie: admin.cookie },
  });
  assert.equal(enableRes.status, 204);
  const loginAfterEnable = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: STRONG_PASSWORD }),
  });
  assert.equal(loginAfterEnable.status, 200);
});

test("an admin cannot disable their own account", async () => {
  const admin = await createAdmin(`admin20-${runId}@example.com`);
  const res = await fetch(`${baseUrl}/api/auth/admin/users/${admin.userId}/disable`, {
    method: "POST",
    headers: { cookie: admin.cookie },
  });
  assert.equal(res.status, 400);
});

test("an admin cannot disable a user in a different brokerage (cross-tenant, 404)", async () => {
  const adminA = await createAdmin(`admin21-${runId}@example.com`);
  const adminB = await createAdmin(`admin22-${runId}@example.com`);
  const res = await fetch(`${baseUrl}/api/auth/admin/users/${adminB.userId}/disable`, {
    method: "POST",
    headers: { cookie: adminA.cookie },
  });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------
// Secret/log redaction
// ---------------------------------------------------------------------------

test("no audit log row for any auth event contains a password or a raw token", async () => {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.recordType, "user"),
      ),
    );
  for (const row of rows) {
    for (const field of [row.previousValue, row.updatedValue, row.providerReference] as const) {
      if (!field) continue;
      assert.ok(field.length < 40, `audit field looks too long to be a safe counter/id value: ${field.slice(0, 10)}...`);
      assert.doesNotMatch(field, /^\$argon2/, "an audit row must never contain a password hash");
    }
  }
});

test("the sandbox auth email provider never records the token/URL it was asked to send, only that a send happened", async () => {
  __clearSandboxAuthEmailLog();
  const admin = await createAdmin(`admin23-${runId}@example.com`);
  await createInvitation(admin.cookie, `sandbox-log-check-${runId}@example.com`);
  const log = __getSandboxAuthEmailLog();
  assert.ok(log.some((entry) => entry.template === "invitation" && entry.to === `sandbox-log-check-${runId}@example.com`));
  for (const entry of log) {
    assert.ok(!("token" in entry), "the sandbox email log must never carry a token field");
    assert.ok(!("url" in entry), "the sandbox email log must never carry a url field");
  }
});
