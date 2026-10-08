import "../../lib/asyncRouteErrors.js";
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import express from "express";
import type { Server } from "node:http";
import {
  db,
  brokerages,
  users,
  platformOwners,
  platformOwnerAudit,
  invitations,
  auditLogs,
  consentRecords,
  passwordResetTokens,
} from "@aee/db";
import { and, eq, inArray } from "drizzle-orm";
import { loadSession, requireAuth } from "../../middlewares/auth.js";
import { platformOwnerRouter } from "../platformOwner.js";
import { authRouter } from "../auth.js";
import { createSessionToken } from "../../lib/session.js";
import { hashPassword } from "../../lib/auth/password.js";
import { generateToken } from "../../lib/auth/tokens.js";
import {
  __resetPlatformOwnerTestHooks,
  __setPlatformOwnerAuditInsertForTests,
  __setPlatformOwnerLookupForTests,
  platformOwnerInvitationAction,
} from "../../lib/platformOwner.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";

function ownerIntegrationDatabaseAllowed(): boolean {
  if (process.env.NODE_ENV === "production" || process.env.REPLIT_DEPLOYMENT) return false;
  const raw = process.env.DATABASE_URL;
  if (!raw) return false;
  try {
    const url = new URL(raw);
    const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (name === "aee_ci" || url.port === "55439") return true;
    return process.env.AEE_ISOLATED_OWNER_TEST === "1" && process.env.NODE_ENV === "test";
  } catch {
    return false;
  }
}

const password = "test-only-password-unrelated-to-owner-secrets";
const suffix = randomUUID().slice(0, 8);
const deniedWrites = [
  "/api/payments/refund",
  "/api/billing/checkout",
  "/api/integrations/config",
  "/api/privacy/requests/1/resolve",
  "/api/aml/exceptions/1/resolve",
  "/api/launch/overrides",
  "/api/transactions/admin",
  "/api/financial/admin",
  "/api/automation/ops",
  "/api/communications/admin",
];

let server: Server;
let base = "";
let homeId = 0;
let tenantAId = 0;
let tenantBId = 0;
let ownerId = 0;
let otherOwnerId = 0;
let adminId = 0;
let agentId = 0;
let memberId = 0;
let ownerCookie = "";
let otherOwnerCookie = "";
let adminCookie = "";
let agentCookie = "";
const writes: string[] = [];

function sessionAt(userId: number, epoch: number, iat: number): string {
  const payload = Buffer.from(JSON.stringify({ uid: userId, iat, epoch })).toString("base64url");
  const signature = createHmac("sha256", process.env.SESSION_SECRET!).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function call(path: string, cookie = "", method = "GET", body?: unknown, extra: Record<string, string> = {}) {
  return fetch(`${base}/api${path}`, {
    method,
    headers: { cookie, "Content-Type": "application/json", ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function selectBrokerage(brokerageId: number | null, cookie = ownerCookie): Promise<string> {
  const selected = await call("/owner/context", cookie, "POST", { brokerageId, currentPassword: password }, { "X-AEE-Owner-Action": "1" });
  assert.equal(selected.status, 200, await selected.clone().text());
  const contextCookie = selected.headers.get("set-cookie")?.split(";")[0];
  assert.ok(contextCookie);
  return `${cookie}; ${contextCookie}`;
}

describe("platform owner access", { skip: !ownerIntegrationDatabaseAllowed(), concurrency: 1 }, () => {
  before(async () => {
    const [home, a, b] = await db.insert(brokerages).values([
      { name: `Owner test home ${suffix}` },
      { name: `Owner test tenant A ${suffix}` },
      { name: `Owner test tenant B ${suffix}` },
    ]).returning();
    homeId = home!.id;
    tenantAId = a!.id;
    tenantBId = b!.id;
    const hash = await hashPassword(password);
    const [owner, otherOwner, admin, agent, member] = await db.insert(users).values([
      { email: `owner-one-${suffix}@example.invalid`, authProviderId: `owner-fixture-1-${suffix}`, brokerageId: homeId, role: "Brokerage Administrator", passwordHash: hash },
      { email: `owner-two-${suffix}@example.invalid`, authProviderId: `owner-fixture-2-${suffix}`, brokerageId: homeId, role: "Brokerage Administrator", passwordHash: hash },
      { email: `admin-${suffix}@example.invalid`, authProviderId: `owner-fixture-3-${suffix}`, brokerageId: tenantAId, role: "Brokerage Administrator" },
      { email: `agent-${suffix}@example.invalid`, authProviderId: `owner-fixture-4-${suffix}`, brokerageId: tenantBId, role: "Agent" },
      { email: `member-${suffix}@example.invalid`, authProviderId: `owner-fixture-5-${suffix}`, brokerageId: tenantAId, role: "Agent" },
    ]).returning();
    ownerId = owner!.id;
    otherOwnerId = otherOwner!.id;
    adminId = admin!.id;
    agentId = agent!.id;
    memberId = member!.id;
    await db.insert(platformOwners).values([{ userId: ownerId }, { userId: otherOwnerId }]);
    const app = express();
    app.use(express.json(), loadSession);
    app.use("/api/owner", platformOwnerRouter);
    app.use("/api/auth", authRouter);
    app.all("/api/scope-probe", requireAuth, (req, res) => res.json(req.authedUser));
    for (const path of deniedWrites) {
      app.post(path, requireAuth, (_req, res) => {
        writes.push(path);
        res.status(200).json({ wrote: true });
      });
    }
    app.get("/api/payments/refund", requireAuth, (_req, res) => res.status(200).json({ read: true }));
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.name : "unexpected" });
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
    ownerCookie = `aee_session=${createSessionToken(ownerId, 0)}`;
    otherOwnerCookie = `aee_session=${createSessionToken(otherOwnerId, 0)}`;
    adminCookie = `aee_session=${createSessionToken(adminId, 0)}`;
    agentCookie = `aee_session=${createSessionToken(agentId, 0)}`;
  });

  after(async () => {
    __resetPlatformOwnerTestHooks();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const userIds = [ownerId, otherOwnerId, adminId, agentId, memberId].filter((id) => id > 0);
    const brokerageIds = [homeId, tenantAId, tenantBId].filter((id) => id > 0);
    if (userIds.length === 0) return;
    await db.delete(consentRecords).where(inArray(consentRecords.userId, userIds));
    await db.delete(passwordResetTokens).where(inArray(passwordResetTokens.userId, userIds));
    await db.delete(platformOwnerAudit).where(inArray(platformOwnerAudit.ownerUserId, userIds));
    await db.delete(platformOwners).where(inArray(platformOwners.userId, userIds));
    if (brokerageIds.length > 0) await db.delete(invitations).where(inArray(invitations.brokerageId, brokerageIds));
    await db.delete(auditLogs).where(inArray(auditLogs.userId, userIds));
    const extraUsers = brokerageIds.length === 0 ? [] : await db.select({ id: users.id }).from(users).where(inArray(users.brokerageId, brokerageIds));
    const extraIds = extraUsers.map((row) => row.id).filter((id) => !userIds.includes(id));
    if (extraIds.length > 0) {
      await db.delete(consentRecords).where(inArray(consentRecords.userId, extraIds));
      await db.delete(auditLogs).where(inArray(auditLogs.userId, extraIds));
      await db.delete(users).where(inArray(users.id, extraIds));
    }
    await db.delete(users).where(inArray(users.id, userIds));
    if (brokerageIds.length > 0) await db.delete(brokerages).where(inArray(brokerages.id, brokerageIds));
  });

  test("anonymous and non-owner requests stay denied, and context requires the current password", async () => {
    assert.equal((await call("/owner/brokerages")).status, 401);
    for (const cookie of [adminCookie, agentCookie]) {
      assert.deepEqual(await (await call("/owner/status", cookie)).json(), { isOwner: false });
      assert.equal((await call("/owner/brokerages", cookie)).status, 403);
      assert.equal((await call("/owner/context", cookie, "POST", { brokerageId: tenantBId, currentPassword: password }, { "X-AEE-Owner-Action": "1" })).status, 403);
    }
    assert.equal((await call("/scope-probe", ownerCookie)).status, 409);
    assert.equal((await call("/owner/context", ownerCookie, "POST", { brokerageId: tenantAId })).status, 403);
    assert.equal((await call("/owner/context", ownerCookie, "POST", { brokerageId: tenantAId, currentPassword: password })).status, 403);
    const missingPassword = await call("/owner/context", ownerCookie, "POST", { brokerageId: tenantAId }, { "X-AEE-Owner-Action": "1" });
    assert.equal(missingPassword.status, 401);
    assert.equal((await missingPassword.json() as { code?: string }).code, "OWNER_REAUTH_REQUIRED");
    assert.equal((await call("/owner/context", ownerCookie, "POST", { brokerageId: tenantAId, currentPassword: "wrong-password-value" }, { "X-AEE-Owner-Action": "1" })).status, 401);
    assert.equal((await call("/owner/context", ownerCookie, "POST", { brokerageId: 2147483647, currentPassword: password }, { "X-AEE-Owner-Action": "1" })).status, 404);
    const scoped = await selectBrokerage(tenantAId);
    assert.equal(((await (await call("/scope-probe", scoped)).json()) as { brokerageId: number }).brokerageId, tenantAId);
    const me = await (await call("/auth/me", scoped)).json() as { user: { platformOwner: boolean; brokerageId: number; ownerHomeBrokerageId: number } };
    assert.equal(me.user.platformOwner, true);
    assert.equal(me.user.brokerageId, tenantAId);
    assert.equal(me.user.ownerHomeBrokerageId, homeId);
    assert.equal((await call("/scope-probe", scoped, "POST", {})).status, 409);
    assert.equal((await call("/scope-probe", scoped, "POST", {}, { "X-AEE-Owner-Brokerage": String(tenantBId) })).status, 409);
    const deniedProbe = await call("/scope-probe", scoped, "POST", {}, { "X-AEE-Owner-Brokerage": String(tenantAId) });
    assert.equal(deniedProbe.status, 403);
    assert.equal((await deniedProbe.json() as { code?: string }).code, "OWNER_ACTION_NOT_PERMITTED");
    const contextCookie = scoped.split("; ").find((part) => part.startsWith("aee_owner_context="))!;
    assert.equal((await call("/scope-probe", `${ownerCookie}; ${contextCookie}x`)).status, 409);
    assert.equal((await call("/scope-probe", `${otherOwnerCookie}; ${contextCookie}`)).status, 409);
    const regular = await (await call("/scope-probe", `${adminCookie}; ${contextCookie}`)).json() as { id: number; brokerageId: number };
    assert.equal(regular.id, adminId);
    assert.equal(regular.brokerageId, tenantAId);
    assert.equal((await call("/auth/login", "", "POST", { email: `owner-one-${suffix}@example.invalid`, password })).status, 428);
  });

  test("F6 owner actions are classified as surface owner, including context selection", async () => {
    const scoped = await selectBrokerage(tenantAId);
    const create = await call("/owner/brokerages", ownerCookie, "POST", { name: `Created through Owner API ${suffix}` }, { "X-AEE-Owner-Action": "1" });
    assert.equal(create.status, 201, await create.clone().text());
    const createdId = (await create.json() as { brokerage: { id: number } }).brokerage.id;
    const renamed = `Renamed by Owner ${suffix}`;
    assert.equal((await call(`/owner/brokerages/${createdId}`, ownerCookie, "PATCH", { name: renamed }, { "X-AEE-Owner-Action": "1" })).status, 200);
    const audit = await db.select().from(platformOwnerAudit).where(eq(platformOwnerAudit.ownerUserId, ownerId));
    const selected = audit.filter((row) => row.action === "context_selected" && row.brokerageId === tenantAId);
    assert.ok(selected.length > 0);
    assert.ok(selected.every((row) => row.surface === "owner"));
    const created = audit.find((row) => row.action === "brokerage_created" && row.brokerageId === createdId);
    const rename = audit.find((row) => row.brokerageId === createdId && row.action.startsWith("brokerage_renamed:"));
    assert.equal(created?.surface, "owner");
    assert.equal(rename?.surface, "owner");
    assert.match(rename?.action ?? "", new RegExp(`Created through Owner API ${suffix}`));
    assert.match(rename?.action ?? "", new RegExp(renamed));
    assert.equal((await call("/owner/brokerages", ownerCookie)).status, 200);
    const authorized = await db.select().from(platformOwnerAudit).where(and(
      eq(platformOwnerAudit.ownerUserId, ownerId),
      eq(platformOwnerAudit.action, "request_authorized"),
      eq(platformOwnerAudit.method, "GET"),
    ));
    assert.ok(authorized.some((row) => row.surface === "owner"));
    assert.ok(audit.every((row) => !row.surface.includes("session") && !row.surface.includes("password")));
    const exit = await call("/owner/context", scoped, "POST", { brokerageId: null, currentPassword: password }, { "X-AEE-Owner-Action": "1" });
    assert.equal(exit.status, 200);
    assert.ok(exit.headers.get("set-cookie")!.includes("Max-Age=0"));
    await db.delete(auditLogs).where(eq(auditLogs.brokerageId, createdId));
    await db.delete(platformOwnerAudit).where(eq(platformOwnerAudit.brokerageId, createdId));
    await db.delete(brokerages).where(eq(brokerages.id, createdId));
  });

  test("F8 brokerage names are unique case-insensitively", async () => {
    const first = await call("/owner/brokerages", ownerCookie, "POST", { name: `Unique Owner Brokerage ${suffix}` }, { "X-AEE-Owner-Action": "1" });
    assert.equal(first.status, 201);
    const createdId = (await first.json() as { brokerage: { id: number } }).brokerage.id;
    const duplicate = await call("/owner/brokerages", ownerCookie, "POST", { name: `unique owner brokerage ${suffix}` }, { "X-AEE-Owner-Action": "1" });
    assert.equal(duplicate.status, 409);
    const clash = await call(`/owner/brokerages/${tenantBId}`, ownerCookie, "PATCH", { name: `UNIQUE OWNER BROKERAGE ${suffix}` }, { "X-AEE-Owner-Action": "1" });
    assert.equal(clash.status, 409);
    await db.delete(auditLogs).where(eq(auditLogs.brokerageId, createdId));
    await db.delete(platformOwnerAudit).where(eq(platformOwnerAudit.brokerageId, createdId));
    await db.delete(brokerages).where(eq(brokerages.id, createdId));
  });

  test("F2 cross-brokerage writes outside user and invitation admin are denied, and reads stay allowed", async () => {
    const scoped = await selectBrokerage(tenantAId);
    writes.length = 0;
    for (const path of deniedWrites) {
      const relative = path.slice("/api".length);
      const res = await call(relative, scoped, "POST", {}, { "X-AEE-Owner-Brokerage": String(tenantAId) });
      assert.equal(res.status, 403, path);
      const body = await res.json() as { code?: string };
      assert.equal(body.code, "OWNER_ACTION_NOT_PERMITTED", path);
    }
    assert.deepEqual(writes, []);
    const read = await call("/payments/refund", scoped);
    assert.equal(read.status, 200);
    const homeScoped = await selectBrokerage(homeId);
    const homeWrite = await call("/payments/refund", homeScoped, "POST", {}, { "X-AEE-Owner-Brokerage": String(homeId) });
    assert.equal(homeWrite.status, 200);
    assert.deepEqual(writes, ["/api/payments/refund"]);
  });

  test("F2 allowed user-admin and invitation routes still work, and a non-owner admin is unchanged", async () => {
    const scoped = await selectBrokerage(tenantAId);
    const invited = await call("/auth/admin/invitations", scoped, "POST", {
      email: `invited-${suffix}@example.invalid`,
      role: "Brokerage Administrator",
    }, { "X-AEE-Owner-Brokerage": String(tenantAId) });
    assert.equal(invited.status, 201, await invited.clone().text());
    const invitation = await invited.json() as { invitation: { id: number; role: string } };
    const ownerAudit = await db.select().from(platformOwnerAudit).where(eq(platformOwnerAudit.ownerUserId, ownerId));
    assert.ok(ownerAudit.some((row) => row.action === platformOwnerInvitationAction(invitation.invitation.id, "Brokerage Administrator") && row.surface === "auth"));
    const [audit] = await db.select().from(auditLogs).where(and(eq(auditLogs.recordType, "invitation"), eq(auditLogs.recordId, String(invitation.invitation.id)), eq(auditLogs.action, "invitation_created")));
    assert.equal(audit?.userId, ownerId);
    assert.equal(audit?.updatedValue, "platform_owner=true");
    assert.equal(audit?.providerReference, `actor:${ownerId}`);
    const disabled = await call(`/auth/admin/users/${memberId}/disable`, scoped, "POST", {}, { "X-AEE-Owner-Brokerage": String(tenantAId) });
    assert.equal(disabled.status, 204, await disabled.clone().text());
    const [member] = await db.select().from(users).where(eq(users.id, memberId));
    assert.equal(member?.isActive, false);
    await db.update(users).set({ isActive: true }).where(eq(users.id, memberId));
    const adminDisable = await call(`/auth/admin/users/${memberId}/disable`, adminCookie, "POST", {});
    assert.equal(adminDisable.status, 204, await adminDisable.clone().text());
    await db.update(users).set({ isActive: true, sessionEpoch: 0 }).where(eq(users.id, memberId));
  });

  test("F3 a revoked owner's pending invitation is invalidated and attribution stays visible", async () => {
    const token = generateToken();
    const [created] = await db.insert(invitations).values({
      brokerageId: tenantAId,
      email: `revoked-invite-${suffix}@example.invalid`,
      role: "Brokerage Administrator",
      tokenHash: token.hash,
      invitedByUserId: ownerId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }).returning();
    await db.insert(platformOwnerAudit).values({
      ownerUserId: ownerId,
      brokerageId: tenantAId,
      action: platformOwnerInvitationAction(created!.id, "Brokerage Administrator"),
      method: "POST",
      surface: "auth",
    });
    await db.delete(platformOwners).where(eq(platformOwners.userId, ownerId));
    try {
      const status = await call(`/auth/invitations/${token.plaintext}/status`);
      assert.deepEqual(await status.json(), { status: "invalid_or_expired" });
      const [row] = await db.select().from(invitations).where(eq(invitations.id, created!.id));
      assert.ok(row?.revokedAt);
      const attributed = (await db.select().from(platformOwnerAudit).where(eq(platformOwnerAudit.ownerUserId, ownerId)))
        .find((entry) => entry.action.startsWith(`invitation_created:id=${created!.id}:`));
      assert.equal(attributed?.ownerUserId, ownerId);
      assert.match(attributed?.action ?? "", /platform_owner=1/);
    } finally {
      await db.insert(platformOwners).values({ userId: ownerId });
    }
  });

  test("F3 accepting an owner invitation records the acting owner on the new admin", async () => {
    const token = generateToken();
    const [created] = await db.insert(invitations).values({
      brokerageId: tenantAId,
      email: `accepted-admin-${suffix}@example.invalid`,
      role: "Brokerage Administrator",
      tokenHash: token.hash,
      invitedByUserId: ownerId,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    }).returning();
    await db.insert(platformOwnerAudit).values({
      ownerUserId: ownerId,
      brokerageId: tenantAId,
      action: platformOwnerInvitationAction(created!.id, "Brokerage Administrator"),
      method: "POST",
      surface: "auth",
    });
    const accepted = await call(`/auth/invitations/${token.plaintext}/accept`, "", "POST", {
      password: "Invite-Accept-Password",
      firstName: "Ada",
      lastName: "Owner",
      acceptedTerms: true,
      acceptedPrivacyPolicy: true,
    });
    assert.equal(accepted.status, 201, await accepted.clone().text());
    const body = await accepted.json() as { user: { id: number } };
    const [provision] = await db.select().from(auditLogs).where(and(eq(auditLogs.action, "platform_owner_admin_provisioned"), eq(auditLogs.recordId, String(body.user.id))));
    assert.equal(provision?.userId, ownerId);
    assert.equal(provision?.updatedValue, "platform_owner=true");
    assert.match(provision?.providerReference ?? "", new RegExp(`actor:${ownerId}`));
  });

  test("F9 one platform owner cannot deactivate, change role, reset password, or revoke sessions of another", async () => {
    const [before] = await db.select().from(users).where(eq(users.id, otherOwnerId));
    const scoped = await selectBrokerage(homeId);
    const disabled = await call(`/auth/admin/users/${otherOwnerId}/disable`, scoped, "POST", {}, { "X-AEE-Owner-Brokerage": String(homeId) });
    assert.equal(disabled.status, 403);
    assert.equal((await disabled.json() as { code?: string }).code, "OWNER_TARGET_PROTECTED");
    const succession = await call("/auth/admin/succession", scoped, "POST", {
      targetUserId: otherOwnerId,
      currentPassword: password,
      confirmation: "TRANSFER ADMINISTRATOR",
    }, { "X-AEE-Owner-Brokerage": String(homeId) });
    assert.equal(succession.status, 403);
    assert.equal((await succession.json() as { code?: string }).code, "OWNER_TARGET_PROTECTED");
    const token = generateToken();
    await db.insert(passwordResetTokens).values({
      userId: otherOwnerId,
      tokenHash: token.hash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const reset = await call("/auth/password-reset/confirm", scoped, "POST", { token: token.plaintext, password: "Replacement-Password-99" });
    assert.equal(reset.status, 403);
    assert.equal((await reset.json() as { code?: string }).code, "OWNER_TARGET_PROTECTED");
    const [after] = await db.select().from(users).where(eq(users.id, otherOwnerId));
    assert.equal(after?.isActive, true);
    assert.equal(after?.role, before?.role);
    assert.equal(after?.sessionEpoch, before?.sessionEpoch);
    assert.equal(after?.passwordHash, before?.passwordHash);
  });

  test("platform owner sessions expire after 12 hours and ordinary sessions do not", async () => {
    const staleOwner = `aee_session=${sessionAt(ownerId, 0, Date.now() - 12 * 60 * 60 * 1000 - 60_000)}`;
    const staleOwnerRes = await call("/owner/brokerages", staleOwner);
    assert.equal(staleOwnerRes.status, 401);
    assert.equal((await staleOwnerRes.json() as { code?: string }).code, "OWNER_SESSION_EXPIRED");
    const withinCap = `aee_session=${sessionAt(ownerId, 0, Date.now() - 11 * 60 * 60 * 1000)}`;
    assert.equal((await call("/owner/status", withinCap)).status, 200);
    const staleAgent = `aee_session=${sessionAt(agentId, 0, Date.now() - 13 * 60 * 60 * 1000)}`;
    const agentRes = await call("/scope-probe", staleAgent);
    assert.equal(agentRes.status, 200);
    assert.equal((await agentRes.json() as { id: number }).id, agentId);
    const oldButValid = `aee_session=${sessionAt(agentId, 0, Date.now() - 20 * 24 * 60 * 60 * 1000)}`;
    assert.equal((await call("/scope-probe", oldButValid)).status, 200);
  });

  test("F1 a missing platform_owners table does not 503 ordinary sessions and fails closed for owner privileges", async () => {
    __setPlatformOwnerLookupForTests(async () => "missing");
    try {
      const nonOwner = await call("/scope-probe", adminCookie);
      assert.equal(nonOwner.status, 200);
      assert.equal((await nonOwner.json() as { brokerageId: number }).brokerageId, tenantAId);
      const ownerNormal = await call("/scope-probe", ownerCookie);
      assert.equal(ownerNormal.status, 200);
      assert.equal((await ownerNormal.json() as { brokerageId: number }).brokerageId, homeId);
      const ownerConsole = await call("/owner/brokerages", ownerCookie);
      assert.equal(ownerConsole.status, 503);
      assert.equal((await ownerConsole.json() as { code?: string }).code, "OWNER_TABLES_MISSING");
    } finally {
      __resetPlatformOwnerTestHooks();
    }
  });

  test("F1 a missing platform_owner_audit table fails closed for a confirmed owner only", async () => {
    __setPlatformOwnerAuditInsertForTests(async () => {
      throw Object.assign(new Error("relation platform_owner_audit does not exist"), { code: "42P01" });
    });
    try {
      assert.equal((await call("/scope-probe", adminCookie)).status, 200);
      const ownerConsole = await call("/owner/brokerages", ownerCookie);
      assert.equal(ownerConsole.status, 503);
    } finally {
      __resetPlatformOwnerTestHooks();
    }
  });

  test("logout epoch, deactivation, and owner revocation still fail closed", async () => {
    const scoped = await selectBrokerage(tenantAId);
    await db.update(users).set({ sessionEpoch: 1 }).where(eq(users.id, ownerId));
    assert.equal((await call("/owner/brokerages", scoped)).status, 401);
    const refreshed = `aee_session=${createSessionToken(ownerId, 1)}`;
    const contextCookie = scoped.split("; ").find((part) => part.startsWith("aee_owner_context="))!;
    assert.equal((await call("/scope-probe", `${refreshed}; ${contextCookie}`)).status, 409);
    await db.update(users).set({ isActive: false }).where(eq(users.id, otherOwnerId));
    assert.equal((await call("/owner/brokerages", otherOwnerCookie)).status, 401);
    await db.delete(platformOwners).where(eq(platformOwners.userId, ownerId));
    assert.equal((await call("/owner/brokerages", refreshed)).status, 403);
    assert.equal((await (await call("/scope-probe", `${refreshed}; ${contextCookie}`)).json() as { brokerageId: number }).brokerageId, homeId);
    await db.insert(platformOwners).values({ userId: ownerId });
    await db.update(users).set({ isActive: true, sessionEpoch: 0 }).where(eq(users.id, otherOwnerId));
    await db.update(users).set({ sessionEpoch: 0 }).where(eq(users.id, ownerId));
  });
});
