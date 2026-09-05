import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, users, brokerages } from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { setSessionCookie, clearSessionCookie } from "../lib/session.js";
import { logAudit } from "../lib/audit.js";
import { isDevAuthEnabled } from "../lib/env.js";
import { incrementCounter } from "@aee/events";

export const authRouter = Router();

function userView(row: typeof users.$inferSelect, brokerageName?: string | null) {
  return {
    id: row.id,
    email: row.email,
    firstName: row.firstName,
    lastName: row.lastName,
    role: row.role,
    brokerageId: row.brokerageId,
    brokerageName: brokerageName ?? null,
  };
}

// Staging sign-in picker (Login prototype-priority screen): lets an agent
// pick a previously created identity without retyping it. Deliberately not
// scoped to "your brokerage only" — pre-login there's no brokerage context
// yet, and this is a staging tool for a small internal test group, not a
// public directory.
authRouter.get("/known-users", async (_req, res) => {
  // Foundation Remediation Stage 1.1: unauthenticated user enumeration
  // must never be reachable outside an explicitly declared development
  // environment. Returns 404 (not 403) so a disabled environment gives
  // no signal that this route exists at all.
  if (!isDevAuthEnabled()) {
    incrementCounter("auth_security_event_total", { event: "dev_login_disabled_attempt" });
    res.status(404).end();
    return;
  }

  const rows = await db.select().from(users).innerJoin(brokerages, eq(users.brokerageId, brokerages.id));
  res.json({
    users: rows
      .filter((r) => r.users.isActive)
      .map((r) => userView(r.users, r.brokerages.name)),
  });
});

const devLoginSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  brokerageName: z.string().min(1),
});

// Dev/staging sign-in (ARCHITECTURE.md §10 closing note — real Clerk
// integration is documented future scope; this makes every requireAuth
// route usable on staging in the meantime). No password: finds-or-creates
// the user by email, finds-or-creates the brokerage by name, and signs the
// browser in with an HMAC session cookie (lib/session.ts). The first user
// ever created against a brokerage becomes its Brokerage Administrator —
// every brokerage needs at least one, since refunds/exception-resolution/
// transaction-close are all Brokerage-Administrator-only actions elsewhere
// in this app.
authRouter.post("/dev-login", async (req, res) => {
  // Foundation Remediation Stage 1.1: passwordless account creation and
  // sign-in must never be reachable outside an explicitly declared
  // development environment (see lib/env.ts::isDevAuthEnabled). Returns
  // 404, matching /known-users above, rather than a 403 that would
  // confirm the route exists.
  if (!isDevAuthEnabled()) {
    incrementCounter("auth_security_event_total", { event: "dev_login_disabled_attempt" });
    res.status(404).end();
    return;
  }

  const parsed = devLoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a name, email, and brokerage to continue." });
    return;
  }
  const { email, firstName, lastName, brokerageName } = parsed.data;

  const [existing] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));
  if (existing) {
    if (!existing.isActive) {
      res.status(403).json({ error: "This account has been deactivated." });
      return;
    }
    setSessionCookie(res, existing.id, existing.sessionEpoch);
    await logAudit({
      userId: existing.id,
      userEmail: existing.email,
      action: "user_signed_in",
      recordType: "user",
      recordId: String(existing.id),
    });
    const [b] = existing.brokerageId ? await db.select().from(brokerages).where(eq(brokerages.id, existing.brokerageId)) : [];
    res.json({ user: userView(existing, b?.name) });
    return;
  }

  let [brokerage] = await db.select().from(brokerages).where(eq(brokerages.name, brokerageName));
  let isFirstInBrokerage = false;
  if (!brokerage) {
    [brokerage] = await db.insert(brokerages).values({ name: brokerageName }).returning();
    isFirstInBrokerage = true;
  } else {
    const existingInBrokerage = await db.select().from(users).where(eq(users.brokerageId, brokerage.id));
    isFirstInBrokerage = existingInBrokerage.length === 0;
  }

  const [created] = await db
    .insert(users)
    .values({
      authProviderId: `dev:${email.toLowerCase()}`,
      email: email.toLowerCase(),
      firstName,
      lastName,
      role: isFirstInBrokerage ? "Brokerage Administrator" : "Agent",
      brokerageId: brokerage.id,
    })
    .returning();

  await logAudit({
    userId: created.id,
    userEmail: created.email,
    action: "user_signed_up",
    recordType: "user",
    recordId: String(created.id),
  });

  setSessionCookie(res, created.id, created.sessionEpoch);
  res.status(201).json({ user: userView(created, brokerage.name) });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const authed = req.authedUser!;
  const [row] = await db.select().from(users).where(eq(users.id, authed.id));
  if (!row) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const [b] = row.brokerageId ? await db.select().from(brokerages).where(eq(brokerages.id, row.brokerageId)) : [];
  res.json({ user: userView(row, b?.name) });
});

// Foundation Remediation - server-side session revocation: this session
// mechanism has no server-side session state (lib/session.ts's module
// comment), so merely clearing the cookie leaves every other token already
// issued to this user - captured via XSS, synced to another device,
// whatever - cryptographically valid and accepted for the rest of its
// MAX_AGE_SECONDS lifetime if it's ever replayed directly. Bumping the
// user's sessionEpoch here invalidates ALL of that user's outstanding
// tokens at once (logout-everywhere semantics): loadSession (middlewares/
// auth.ts) rejects any token whose embedded epoch no longer matches on the
// very next request, the same way a role change or deactivation already
// takes effect immediately there. req.authedUser is populated by the
// global loadSession middleware (app.ts) ahead of this route, so a request
// with no valid session just clears the (already-not-useful) cookie with
// nothing to revoke or audit.
authRouter.post("/logout", async (req, res) => {
  const authed = req.authedUser;
  if (authed) {
    const [updated] = await db
      .update(users)
      .set({ sessionEpoch: sql`${users.sessionEpoch} + 1` })
      .where(eq(users.id, authed.id))
      .returning();
    if (updated) {
      await logAudit({
        userId: updated.id,
        userEmail: updated.email,
        action: "user_signed_out",
        recordType: "user",
        recordId: String(updated.id),
        previousValue: String(updated.sessionEpoch - 1),
        updatedValue: String(updated.sessionEpoch),
      });
    }
  }
  clearSessionCookie(res);
  res.status(204).end();
});
