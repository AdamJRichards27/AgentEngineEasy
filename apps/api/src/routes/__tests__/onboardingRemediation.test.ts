import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, users, brokerages, invitations, consentRecords, auditLogs, entitlementGrants } from "@aee/db";
import { hashPassword } from "../../lib/auth/password.js";
import { CURRENT_PRIVACY_VERSION, CURRENT_TERMS_VERSION } from "../../lib/auth/legalVersions.js";
import { PERSON_NAME_MAX_LENGTH } from "../../lib/auth/personName.js";

// UAT-OB1 — legal acceptance on the real login path, invitation names, and
// the signed-in user's own name. ALLOW_DEV_AUTH is only used to mint
// session cookies for the name-update cases.

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const runId = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const STRONG_PASSWORD = "Correct-Horse-Battery-Staple-42";
let passwordHash = "";
const createdBrokerageIds = new Set<number>();

before(async () => {
  passwordHash = await hashPassword(STRONG_PASSWORD);
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
    const brokerageUsers = await db.select().from(users).where(eq(users.brokerageId, brokerageId));
    await db.delete(invitations).where(eq(invitations.brokerageId, brokerageId));
    await db.delete(entitlementGrants).where(eq(entitlementGrants.brokerageId, brokerageId));
    for (const user of brokerageUsers) {
      await db.delete(consentRecords).where(eq(consentRecords.userId, user.id));
      await db.delete(auditLogs).where(eq(auditLogs.userId, user.id));
    }
    await db.delete(auditLogs).where(eq(auditLogs.brokerageId, brokerageId));
    await db.delete(users).where(eq(users.brokerageId, brokerageId));
    await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
  }
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function cookieFrom(res: Response): string {
  const cookie = res.headers.get("set-cookie")?.match(/aee_session=[^;]+/)?.[0];
  if (!cookie) throw new Error("expected a session cookie");
  return cookie;
}

async function insertBrokerage(name: string): Promise<number> {
  const [row] = await db.insert(brokerages).values({ name }).returning();
  createdBrokerageIds.add(row.id);
  return row.id;
}

async function insertPasswordUser(email: string, brokerageId: number, names: { firstName: string; lastName: string } = { firstName: "", lastName: "" }) {
  const [row] = await db
    .insert(users)
    .values({
      authProviderId: `bootstrap:${email}`,
      email,
      firstName: names.firstName,
      lastName: names.lastName,
      role: "Brokerage Administrator",
      brokerageId,
      passwordHash,
      emailVerifiedAt: new Date(),
    })
    .returning();
  return row;
}

async function devLogin(email: string, brokerageName: string, firstName: string, lastName: string) {
  const res = await fetch(`${baseUrl}/api/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, firstName, lastName, brokerageName }),
  });
  assert.equal(res.status, 201);
  const body = (await res.json()) as { user: { id: number; brokerageId: number; firstName: string; lastName: string } };
  createdBrokerageIds.add(body.user.brokerageId);
  return { cookie: cookieFrom(res), user: body.user };
}

async function issueInvitation(brokerageId: number, email: string, invitedByUserId: number) {
  const { generateToken } = await import("../../lib/auth/tokens.js");
  const { plaintext, hash } = generateToken();
  await db.insert(invitations).values({
    brokerageId,
    email,
    role: "Agent",
    tokenHash: hash,
    invitedByUserId,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  return plaintext;
}

test("login without current legal acceptance returns 428 and does not start a session", async () => {
  const email = `legal-gap-${runId}@example.com`;
  const brokerageId = await insertBrokerage(`Legal Gap ${runId}`);
  await insertPasswordUser(email, brokerageId);
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: STRONG_PASSWORD }),
  });
  assert.equal(res.status, 428);
  const body = (await res.json()) as { code: string; termsVersion: string; privacyVersion: string };
  assert.equal(body.code, "LEGAL_ACCEPTANCE_REQUIRED");
  assert.equal(body.termsVersion, CURRENT_TERMS_VERSION);
  assert.equal(body.privacyVersion, CURRENT_PRIVACY_VERSION);
  assert.equal(res.headers.get("set-cookie"), null);
  const [user] = await db.select().from(users).where(eq(users.email, email));
  const consents = await db.select().from(consentRecords).where(eq(consentRecords.userId, user.id));
  assert.equal(consents.length, 0);
});

test("accepting the current legal documents then logging in succeeds, and rejected or blank acceptance does not", async () => {
  const email = `legal-accept-${runId}@example.com`;
  const brokerageId = await insertBrokerage(`Legal Accept ${runId}`);
  const user = await insertPasswordUser(email, brokerageId);

  const blank = await fetch(`${baseUrl}/api/legal/acceptance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: STRONG_PASSWORD }),
  });
  assert.equal(blank.status, 400);
  assert.equal(blank.headers.get("set-cookie"), null);

  const rejected = await fetch(`${baseUrl}/api/legal/acceptance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: STRONG_PASSWORD, acceptedTerms: false, acceptedPrivacyPolicy: true }),
  });
  assert.equal(rejected.status, 400);

  const wrongPassword = await fetch(`${baseUrl}/api/legal/acceptance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "not-the-password", acceptedTerms: true, acceptedPrivacyPolicy: true }),
  });
  assert.equal(wrongPassword.status, 401);

  let consents = await db.select().from(consentRecords).where(eq(consentRecords.userId, user.id));
  assert.equal(consents.length, 0, "rejected or blank acceptance must not record consent");
  const stillBlocked = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: STRONG_PASSWORD }),
  });
  assert.equal(stillBlocked.status, 428);

  const accepted = await fetch(`${baseUrl}/api/legal/acceptance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: STRONG_PASSWORD, acceptedTerms: true, acceptedPrivacyPolicy: true }),
  });
  assert.equal(accepted.status, 204);
  assert.equal(accepted.headers.get("set-cookie"), null, "acceptance itself must not start a session");

  consents = await db.select().from(consentRecords).where(eq(consentRecords.userId, user.id));
  assert.equal(consents.length, 2);
  assert.ok(consents.some((row) => row.consentType === "terms_of_use" && row.documentVersion === CURRENT_TERMS_VERSION));
  assert.ok(consents.some((row) => row.consentType === "privacy_policy" && row.documentVersion === CURRENT_PRIVACY_VERSION));
  const audits = await db.select().from(auditLogs).where(eq(auditLogs.userId, user.id));
  assert.ok(audits.some((row) => row.action === "legal_documents_accepted"));

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: STRONG_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: cookieFrom(login) } });
  assert.equal(me.status, 200);
});

test("PATCH /auth/profile updates only the signed-in user's name", async () => {
  const owner = await devLogin(`owner-${runId}@example.com`, `Owner Brokerage ${runId}`, "Owner", "Original");
  const other = await devLogin(`other-${runId}@example.com`, `Other Brokerage ${runId}`, "Other", "Person");

  const unauthenticated = await fetch(`${baseUrl}/api/auth/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ firstName: "Nope", lastName: "Nope" }),
  });
  assert.equal(unauthenticated.status, 401);

  const blank = await fetch(`${baseUrl}/api/auth/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: owner.cookie },
    body: JSON.stringify({ firstName: "   ", lastName: "Shore" }),
  });
  assert.equal(blank.status, 400);

  const tooLong = await fetch(`${baseUrl}/api/auth/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: owner.cookie },
    body: JSON.stringify({ firstName: "A".repeat(PERSON_NAME_MAX_LENGTH + 1), lastName: "Shore" }),
  });
  assert.equal(tooLong.status, 400);

  const targeted = await fetch(`${baseUrl}/api/auth/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: owner.cookie },
    body: JSON.stringify({ firstName: "Mallory", lastName: "Attack", userId: other.user.id }),
  });
  assert.equal(targeted.status, 400);

  const saved = await fetch(`${baseUrl}/api/auth/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie: owner.cookie },
    body: JSON.stringify({ firstName: "  Nina  ", lastName: "  Shore  " }),
  });
  assert.equal(saved.status, 200);
  const savedBody = (await saved.json()) as { user: { id: number; firstName: string; lastName: string; email: string } };
  assert.equal(savedBody.user.id, owner.user.id);
  assert.equal(savedBody.user.firstName, "Nina");
  assert.equal(savedBody.user.lastName, "Shore");

  const [ownerRow] = await db.select().from(users).where(eq(users.id, owner.user.id));
  const [otherRow] = await db.select().from(users).where(eq(users.id, other.user.id));
  assert.equal(ownerRow.firstName, "Nina");
  assert.equal(ownerRow.lastName, "Shore");
  assert.equal(otherRow.firstName, "Other");
  assert.equal(otherRow.lastName, "Person");

  const audits = await db.select().from(auditLogs).where(eq(auditLogs.userId, owner.user.id));
  const nameAudit = audits.find((row) => row.action === "user_name_updated");
  assert.ok(nameAudit, "the name change must be audited");
  assert.equal(nameAudit.recordType, "user");
  assert.equal(nameAudit.recordId, String(owner.user.id));
  assert.equal(nameAudit.previousValue, JSON.stringify({ firstName: "Owner", lastName: "Original" }));
  assert.equal(nameAudit.updatedValue, JSON.stringify({ firstName: "Nina", lastName: "Shore" }));
  const otherAudits = await db.select().from(auditLogs).where(eq(auditLogs.recordId, String(other.user.id)));
  assert.equal(
    otherAudits.some((row) => row.action === "user_name_updated"),
    false,
  );

  const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { cookie: owner.cookie } });
  const meBody = (await me.json()) as { user: { firstName: string; lastName: string } };
  assert.equal(meBody.user.firstName, "Nina");
  assert.equal(meBody.user.lastName, "Shore");
});

test("invitation accept requires a trimmed first and last name", async () => {
  const admin = await devLogin(`invite-admin-${runId}@example.com`, `Invite Brokerage ${runId}`, "Admin", "User");
  const email = `invitee-${runId}@example.com`;
  const token = await issueInvitation(admin.user.brokerageId, email, admin.user.id);
  const headers = { "content-type": "application/json" };
  const base = { password: STRONG_PASSWORD, acceptedTerms: true, acceptedPrivacyPolicy: true };

  const missing = await fetch(`${baseUrl}/api/auth/invitations/${token}/accept`, {
    method: "POST",
    headers,
    body: JSON.stringify(base),
  });
  assert.equal(missing.status, 400);

  const blank = await fetch(`${baseUrl}/api/auth/invitations/${token}/accept`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...base, firstName: "   ", lastName: "Lovelace" }),
  });
  assert.equal(blank.status, 400);

  const tooLong = await fetch(`${baseUrl}/api/auth/invitations/${token}/accept`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...base, firstName: "A".repeat(PERSON_NAME_MAX_LENGTH + 1), lastName: "Lovelace" }),
  });
  assert.equal(tooLong.status, 400);

  const [absent] = await db.select().from(users).where(eq(users.email, email));
  assert.equal(absent, undefined);

  const created = await fetch(`${baseUrl}/api/auth/invitations/${token}/accept`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...base, firstName: "  Ada  ", lastName: "  Lovelace  ", role: "Brokerage Administrator", brokerageId: 999999 }),
  });
  assert.equal(created.status, 201);
  const body = (await created.json()) as { user: { firstName: string; lastName: string; role: string; brokerageId: number } };
  assert.equal(body.user.firstName, "Ada");
  assert.equal(body.user.lastName, "Lovelace");
  assert.equal(body.user.role, "Agent");
  assert.equal(body.user.brokerageId, admin.user.brokerageId);
  const [row] = await db.select().from(users).where(eq(users.email, email));
  assert.equal(row.firstName, "Ada");
  assert.equal(row.lastName, "Lovelace");
});
