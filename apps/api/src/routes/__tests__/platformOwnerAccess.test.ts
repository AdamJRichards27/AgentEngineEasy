import "../../lib/asyncRouteErrors.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { db, pool, brokerages, users, platformOwners, platformOwnerAudit } from "@aee/db";
import { eq, sql } from "drizzle-orm";
import { loadSession, requireAuth } from "../../middlewares/auth.js";
import { platformOwnerRouter } from "../platformOwner.js";
import { authRouter } from "../auth.js";
import { createSessionToken } from "../../lib/session.js";
import { hashPassword } from "../../lib/auth/password.js";

test("isolated Owner authorization, context, audit and revocation boundaries", {
  skip: !process.env.DATABASE_URL || new URL(process.env.DATABASE_URL).port !== "55439",
}, async () => {
  // Refuse to create fixtures anywhere except the explicitly isolated database.
  assert.equal(new URL(process.env.DATABASE_URL!).port, "55439");
  const [home, a, b] = await db.insert(brokerages).values([
    { name: "Owner test home" }, { name: "Owner test tenant A" }, { name: "Owner test tenant B" },
  ]).returning();
  const password = "test-only-password-unrelated-to-owner-secrets";
  const hash = await hashPassword(password);
  const [owner, otherOwner, admin, agent] = await db.insert(users).values([
    { email: "owner-one@example.invalid", authProviderId: "owner-fixture-1", brokerageId: home!.id, role: "Brokerage Administrator", passwordHash: hash },
    { email: "owner-two@example.invalid", authProviderId: "owner-fixture-2", brokerageId: home!.id, role: "Brokerage Administrator", passwordHash: hash },
    { email: "admin@example.invalid", authProviderId: "owner-fixture-3", brokerageId: a!.id, role: "Brokerage Administrator" },
    { email: "agent@example.invalid", authProviderId: "owner-fixture-4", brokerageId: b!.id, role: "Agent" },
  ]).returning();
  await db.insert(platformOwners).values([{ userId: owner!.id }, { userId: otherOwner!.id }]);
  const app = express();
  app.use(express.json(), loadSession);
  app.use("/api/owner", platformOwnerRouter);
  app.use("/api/auth", authRouter);
  app.all("/api/scope-probe", requireAuth, (req, res) => res.json(req.authedUser));
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.name : "unexpected" });
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const ownerCookie = `aee_session=${createSessionToken(owner!.id, 0)}`;
  const adminCookie = `aee_session=${createSessionToken(admin!.id, 0)}`;
  const agentCookie = `aee_session=${createSessionToken(agent!.id, 0)}`;
  const call = (path: string, cookie = "", method = "GET", body?: unknown, extra: Record<string, string> = {}) =>
    fetch(`${base}/api${path}`, { method, headers: { cookie, "Content-Type": "application/json", ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.equal((await call("/owner/brokerages")).status, 401);
    for (const cookie of [adminCookie, agentCookie]) {
      assert.deepEqual(await (await call("/owner/status", cookie)).json(), { isOwner: false });
      assert.equal((await call("/owner/brokerages", cookie)).status, 403);
      assert.equal((await call("/owner/context", cookie, "POST", { brokerageId: b!.id }, { "X-AEE-Owner-Action": "1" })).status, 403);
    }
    assert.equal((await call("/scope-probe", ownerCookie)).status, 409);
    assert.equal((await call("/owner/context", ownerCookie, "POST", { brokerageId: a!.id })).status, 403);
    assert.equal((await call("/owner/context", ownerCookie, "POST", { brokerageId: 2147483647 }, { "X-AEE-Owner-Action": "1" })).status, 404);
    const selected = await call("/owner/context", ownerCookie, "POST", { brokerageId: a!.id }, { "X-AEE-Owner-Action": "1" });
    assert.equal(selected.status, 200);
    const contextCookie = selected.headers.get("set-cookie")!.split(";")[0]!;
    const scoped = `${ownerCookie}; ${contextCookie}`;
    assert.equal(((await (await call("/scope-probe", scoped)).json()) as { brokerageId: number }).brokerageId, a!.id);
    const me = await (await call("/auth/me", scoped)).json() as { user: { platformOwner: boolean; brokerageId: number; ownerHomeBrokerageId: number } };
    assert.equal(me.user.platformOwner, true);
    assert.equal(me.user.brokerageId, a!.id);
    assert.equal(me.user.ownerHomeBrokerageId, home!.id);
    assert.equal((await call("/scope-probe", scoped, "POST", {})).status, 409);
    assert.equal((await call("/scope-probe", scoped, "POST", {}, { "X-AEE-Owner-Brokerage": String(b!.id) })).status, 409);
    assert.equal((await call("/scope-probe", scoped, "POST", {}, { "X-AEE-Owner-Brokerage": String(a!.id) })).status, 200);
    // A stolen/tampered context cannot select a tenant for another login.
    assert.equal((await call("/scope-probe", `${ownerCookie}; ${contextCookie}x`)).status, 409);
    assert.equal((await call("/scope-probe", `aee_session=${createSessionToken(otherOwner!.id, 0)}; ${contextCookie}`)).status, 409);
    const regular = await (await call("/scope-probe", `${adminCookie}; ${contextCookie}`)).json() as { id: number; brokerageId: number };
    assert.equal(regular.id, admin!.id);
    assert.equal(regular.brokerageId, a!.id);
    // Password login still requires legal acceptance; Owner does not bypass it.
    assert.equal((await call("/auth/login", "", "POST", { email: owner!.email, password })).status, 428);
    const create = await call("/owner/brokerages", ownerCookie, "POST", { name: "Created through Owner API" }, { "X-AEE-Owner-Action": "1" });
    assert.equal(create.status, 201);
    const createdId = (await create.json() as { brokerage: { id: number } }).brokerage.id;
    assert.equal((await call(`/owner/brokerages/${createdId}`, ownerCookie, "PATCH", { name: "Renamed by Owner" }, { "X-AEE-Owner-Action": "1" })).status, 200);
    const audit = await db.select().from(platformOwnerAudit).where(eq(platformOwnerAudit.ownerUserId, owner!.id));
    assert.ok(audit.some(row => row.action === "context_selected" && row.brokerageId === a!.id));
    assert.ok(audit.some(row => row.action === "brokerage_created" && row.brokerageId === createdId));
    assert.ok(audit.some(row => row.action === "brokerage_renamed" && row.brokerageId === createdId));
    assert.ok(audit.every(row => !row.surface.includes("session") && !row.surface.includes("password")));
    const exit = await call("/owner/context", scoped, "POST", { brokerageId: null }, { "X-AEE-Owner-Action": "1" });
    assert.equal(exit.status, 200);
    assert.ok(exit.headers.get("set-cookie")!.includes("Max-Age=0"));
    await db.update(users).set({ sessionEpoch: 1 }).where(eq(users.id, owner!.id));
    assert.equal((await call("/owner/brokerages", scoped)).status, 401);
    const refreshed = `aee_session=${createSessionToken(owner!.id, 1)}`;
    assert.equal((await call("/scope-probe", `${refreshed}; ${contextCookie}`)).status, 409);
    await db.update(users).set({ isActive: false }).where(eq(users.id, otherOwner!.id));
    assert.equal((await call("/owner/brokerages", `aee_session=${createSessionToken(otherOwner!.id, 0)}`)).status, 401);
    await db.delete(platformOwners).where(eq(platformOwners.userId, owner!.id));
    assert.equal((await call("/owner/brokerages", refreshed)).status, 403);
    assert.equal((await (await call("/scope-probe", `${refreshed}; ${contextCookie}`)).json() as { brokerageId: number }).brokerageId, home!.id);
    // The Owner audit is mandatory: removing its table makes access fail closed.
    await db.insert(platformOwners).values({ userId: owner!.id });
    await db.execute(sql`ALTER TABLE platform_owner_audit RENAME TO platform_owner_audit_unavailable`);
    try { assert.equal((await call("/owner/brokerages", refreshed)).status, 503); }
    finally { await db.execute(sql`ALTER TABLE platform_owner_audit_unavailable RENAME TO platform_owner_audit`); }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pool.end();
  }
});
