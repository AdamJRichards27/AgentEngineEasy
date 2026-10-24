import { Router, type Response } from "express";
import { eq, sql, and, gt, isNull, desc, count } from "drizzle-orm";
import { z } from "zod";
import { db, users, brokerages, invitations, passwordResetTokens, consentRecords, auditLogs, entitlementGrants, USER_ROLES } from "@aee/db";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { setSessionCookie, clearSessionCookie, parseCookies } from "../lib/session.js";
import {
  MINIMAL_UX_VIEW_COOKIE,
  applyMinimalUxViewCookie,
  minimalUxClientPayload,
  resolveMinimalUx,
} from "../lib/minimalUx.js";
import { logAudit } from "../lib/audit.js";
import { isDevAuthEnabled } from "../lib/env.js";
import { incrementCounter, logger } from "@aee/events";
import { hashPassword, verifyPassword, passwordPolicyViolation } from "../lib/auth/password.js";
import { generateToken, hashToken } from "../lib/auth/tokens.js";
import { getAuthEmailProvider } from "../lib/auth/email.js";
import { assertOutboundAllowed, outboundBlocked } from "../lib/outboundGuard.js";
import { getActiveLegalVersions } from "../lib/auth/legalVersions.js";
import { normalizePersonName } from "../lib/auth/personName.js";
import { dispatchOperationalAlert } from "../lib/operationalAlerts.js";
import { resolveEntitlements } from "../lib/entitlements/resolver.js";
import {
  gatePlatformOwnerInvitation,
  invalidatePendingInvitationsFromRevokedOwners,
  isPlatformOwner,
  platformOwnerAdminGuard,
  platformOwnerInvitationActor,
  recordPlatformOwnerInvitation,
  setOwnerContextCookie,
} from "../lib/platformOwner.js";

export const authRouter = Router();

const OWNER_TARGET_PROTECTED = {
  error: "Platform Owner accounts cannot be deactivated, have their role changed, have their password reset, or have their sessions revoked through brokerage administration.",
  code: "OWNER_TARGET_PROTECTED",
};

/** True when the response has already been sent. A user outside this brokerage is left for the route's own 404. */
async function rejectPlatformOwnerTarget(res: Response, brokerageId: number, targetUserId: number): Promise<boolean> {
  const [visible] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, targetUserId), eq(users.brokerageId, brokerageId)));
  if (!visible) return false;
  const guard = await platformOwnerAdminGuard(visible.id);
  if (guard === "protected") {
    res.status(403).json(OWNER_TARGET_PROTECTED);
    return true;
  }
  if (guard === "unavailable") {
    res.status(503).json({ error: "Your access could not be verified. Please retry." });
    return true;
  }
  return false;
}

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
  //
  // Critical Blocker Remediation, Phase 3: this route is retained
  // unchanged, purely as a local-development/automated-test fixture — see
  // docs/gate-evidence/AUTHENTICATION_THREAT_MODEL.md §6. The pilot's real
  // Login screen (apps/web/src/pages/Login.tsx) no longer calls this route
  // at all; it is rebuilt on POST /auth/login (below). Real, authenticated,
  // tenant-scoped, paginated, audited user discovery for admins is
  // GET /auth/admin/users, also below.
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
//
// Critical Blocker Remediation, Phase 3: retained unchanged as a
// local-development/automated-test fixture only (~50 existing test files
// depend on it) — see docs/gate-evidence/AUTHENTICATION_THREAT_MODEL.md §6
// for why this is the correct bounded-remediation choice rather than
// removing it. It already satisfies Phase 3's requirement ("unregistered
// or 404 in production, fail-closed, proven by tests") today; this pass
// adds no new capability to this route and the pilot's real sign-in no
// longer depends on it.
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
    let ownerAccount = false;
    try {
      ownerAccount = await isPlatformOwner(existing.id);
    } catch {
      res.status(503).json({ error: "Your access could not be verified. Please retry." });
      return;
    }
    if (ownerAccount) {
      res.status(403).json({ error: "Platform Owners must sign in with their password." });
      return;
    }
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
    // AE GROW Priority 0.5 — Workstream 3: every brand-new brokerage automatically receives
    // run.access at creation time, matching pre-Grow behaviour where every brokerage could use
    // the RUN surface (Pit Crew, Financial) with no separate purchase step — see
    // lib/billing/runAccessBackfill.ts for the equivalent, idempotent backfill covering
    // brokerages that already existed before run.access was introduced. grow.access is
    // deliberately NOT auto-granted here — Grow stays purchase-gated, unchanged from before
    // this phase.
    await db.insert(entitlementGrants).values({
      brokerageId: brokerage.id,
      entitlementKey: "run.access",
      granteeType: "brokerage",
      granteeId: brokerage.id,
      sourceType: "migration",
      status: "Active",
    });
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

// AE GROW Priority 0.5 — Workstream 1: frontend entitlement awareness. `entitlements` is added
// as a new top-level sibling field alongside `user`, never merged into it — the entitlement set
// is a resolver decision (lib/entitlements/resolver.ts), not a user-record field, so the `user`
// shape itself never changes for any existing consumer of this endpoint. See
// apps/web/src/lib/session.ts's useEntitlements() for the frontend side of this.
authRouter.get("/me", requireAuth, async (req, res) => {
  const authed = req.authedUser!;
  const [row] = await db.select().from(users).where(eq(users.id, authed.id));
  if (!row) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const [b] = await db.select().from(brokerages).where(eq(brokerages.id, authed.brokerageId));
  const entitlements = await resolveEntitlements(authed);
  const viewCookie = parseCookies(req.header("cookie"))[MINIMAL_UX_VIEW_COOKIE];
  const ux = minimalUxClientPayload(resolveMinimalUx({
    userId: row.id,
    email: row.email,
    viewCookie,
  }));
  res.json({ user: {
    ...userView({ ...row, brokerageId: authed.brokerageId, role: authed.role }, b?.name),
    platformOwner: !!req.platformOwner,
    ...(req.platformOwner ? {
      ownerHomeBrokerageId: req.platformOwner.homeBrokerageId,
      ownerSelectedBrokerageId: req.platformOwner.selectedBrokerageId,
    } : {}),
  }, entitlements: Array.from(entitlements), ux });
});

const uxViewSchema = z.object({
  variant: z.enum(["classic", "minimal"]),
}).strict();

// Classic / Minimal shell choice. Eligibility is decided here from the flag
// and the per-user allowlist. A caller who is not eligible cannot opt in.
// The preference cookie is scoped to this user id, so it does not follow a
// different account on the same browser.
authRouter.post("/ux-view", requireAuth, async (req, res) => {
  const parsed = uxViewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose classic or minimal." });
    return;
  }
  const authed = req.authedUser!;
  const [row] = await db.select().from(users).where(eq(users.id, authed.id));
  if (!row) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const decision = resolveMinimalUx({ userId: row.id, email: row.email });
  if (parsed.data.variant === "minimal" && !decision.eligible) {
    res.status(403).json({
      error: "AE Minimal is not enabled for this account.",
      ux: { eligible: false, variant: "classic" },
    });
    return;
  }
  const variant = decision.eligible ? parsed.data.variant : "classic";
  if (decision.eligible) applyMinimalUxViewCookie(res, row.id, variant);
  res.json({ ux: { eligible: decision.eligible, variant } });
});

const updateOwnNameSchema = z
  .object({
    firstName: z.string({ required_error: "First name is required.", invalid_type_error: "First name is required." }),
    lastName: z.string({ required_error: "Last name is required.", invalid_type_error: "Last name is required." }),
  })
  .strict();

// UAT-OB1 — a signed-in user updates their OWN first and last name.
// There is no user id in the path or a trusted id in the body: the only
// row written is req.authedUser.id. Unknown keys (userId, email, role,
// brokerageId) are rejected so this route cannot target or reshape
// another account. Names use the same trim / blank / length rules as
// invitation accept. The audit row follows the other user-account
// changes in this file (logAudit, recordType "user", previous/updated
// values).
authRouter.patch("/profile", requireAuth, async (req, res) => {
  const parsed = updateOwnNameSchema.safeParse(req.body);
  if (!parsed.success) {
    const unrecognized = parsed.error.issues.some((issue) => issue.code === "unrecognized_keys");
    res.status(400).json({
      error: unrecognized
        ? "You can only update your own first and last name."
        : (parsed.error.issues[0]?.message ?? "Enter your first and last name."),
    });
    return;
  }
  const firstName = normalizePersonName(parsed.data.firstName, "First name");
  if (!firstName.ok) {
    res.status(400).json({ error: firstName.error });
    return;
  }
  const lastName = normalizePersonName(parsed.data.lastName, "Last name");
  if (!lastName.ok) {
    res.status(400).json({ error: lastName.error });
    return;
  }

  const authed = req.authedUser!;
  const [existing] = await db.select().from(users).where(eq(users.id, authed.id));
  if (!existing || existing.id !== authed.id) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const [updated] = await db
    .update(users)
    .set({ firstName: firstName.value, lastName: lastName.value, updatedAt: new Date() })
    .where(eq(users.id, authed.id))
    .returning();
  if (!updated || updated.id !== authed.id) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  await logAudit({
    brokerageId: updated.brokerageId ?? undefined,
    userId: updated.id,
    userEmail: updated.email,
    action: "user_name_updated",
    recordType: "user",
    recordId: String(updated.id),
    previousValue: JSON.stringify({ firstName: existing.firstName, lastName: existing.lastName }),
    updatedValue: JSON.stringify({ firstName: updated.firstName, lastName: updated.lastName }),
  });

  const [brokerage] = updated.brokerageId ? await db.select().from(brokerages).where(eq(brokerages.id, updated.brokerageId)) : [];
  res.json({ user: userView(updated, brokerage?.name) });
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
  setOwnerContextCookie(res, null, "");
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Critical Blocker Remediation, Phase 4 — invitation-only authentication.
// See docs/gate-evidence/PHASE2_AUTHENTICATION_DESIGN.md for the full design
// this section implements.
// ---------------------------------------------------------------------------

const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const GENERIC_LOGIN_ERROR = { error: "Invalid email or password." };

function frontendBaseUrl(): string {
  // No hardcoded production domain — this pilot has none yet (Phase 9
  // deployment is still pending approval). FRONTEND_BASE_URL is required
  // wherever a real link must be emailed; the sandbox provider never
  // actually transmits the link anywhere, so a missing value only affects
  // what a human would eventually click, never the token's security.
  return process.env.FRONTEND_BASE_URL ?? "http://localhost:5173";
}

const createInvitationSchema = z.object({
  email: z.string().email(),
  role: z.enum(USER_ROLES),
});

// Admin-issued invitations (Phase 2 design §4.1). Tenant-scoped: an admin
// can only invite into their own brokerage — brokerageId is taken from the
// caller's own session (req.authedUser), never from the request body, so
// there is no way to invite a user into a brokerage the caller does not
// administer.
authRouter.post("/admin/invitations", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  try {
    getActiveLegalVersions();
  } catch {
    res.status(503).json({ error: "Invitations are unavailable until approved Terms of Use and Privacy Policy versions are active." });
    return;
  }
  const parsed = createInvitationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid email address and role." });
    return;
  }
  const { email, role } = parsed.data;
  const admin = req.authedUser!;
  const normalizedEmail = email.toLowerCase();

  const [existingUser] = await db.select().from(users).where(eq(users.email, normalizedEmail));
  if (existingUser) {
    res.status(409).json({ error: "A user with this email already exists." });
    return;
  }

  // WS4-11 D-INV: a restored environment cannot send the invitation email, so refuse (503
  // RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED) BEFORE revoking or inserting anything — no dead row.
  assertOutboundAllowed("auth_email");

  // Re-inviting an email revokes any prior pending invitation first — one
  // live invitation per email at a time (Phase 2 design §4.1).
  await db
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(invitations.email, normalizedEmail),
        eq(invitations.brokerageId, admin.brokerageId),
        isNull(invitations.acceptedAt),
        isNull(invitations.revokedAt),
      ),
    );

  const { plaintext, hash } = generateToken();
  const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS);
  const [created] = await db
    .insert(invitations)
    .values({
      brokerageId: admin.brokerageId,
      email: normalizedEmail,
      role,
      tokenHash: hash,
      invitedByUserId: admin.id,
      expiresAt,
    })
    .returning();

  if (req.platformOwner) {
    try {
      await recordPlatformOwnerInvitation({
        ownerUserId: admin.id,
        brokerageId: admin.brokerageId,
        invitationId: created.id,
        role,
        method: req.method,
      });
    } catch {
      await db.update(invitations).set({ revokedAt: new Date() }).where(eq(invitations.id, created.id));
      res.status(503).json({ error: "The invitation could not be audited. It was not issued." });
      return;
    }
  }

  const [brokerage] = await db.select().from(brokerages).where(eq(brokerages.id, admin.brokerageId));
  const acceptUrl = `${frontendBaseUrl()}/accept-invitation/${plaintext}`;
  await getAuthEmailProvider().sendInvitation({
    to: normalizedEmail,
    brokerageName: brokerage?.name ?? "",
    acceptUrl,
    expiresAt,
  });

  await logAudit({
    userId: admin.id,
    action: "invitation_created",
    recordType: "invitation",
    recordId: String(created.id),
    ...(req.platformOwner
      ? {
          brokerageId: admin.brokerageId,
          updatedValue: "platform_owner=true",
          providerReference: `actor:${admin.id}`,
        }
      : {}),
  });

  // Never returns the token or acceptUrl — those exist only in the email
  // (Phase 2 design §2/§6: "no password or reset token in ... production
  // API responses").
  res.status(201).json({ invitation: { id: created.id, email: created.email, role: created.role, expiresAt: created.expiresAt } });
});

// Tenant-scoped, paginated, admin-only invitation listing — lets an admin
// see and manage what they've sent without ever exposing a token.
authRouter.get("/admin/invitations", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const admin = req.authedUser!;
  await invalidatePendingInvitationsFromRevokedOwners(admin.brokerageId);
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

  const rows = await db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      revokedAt: invitations.revokedAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(eq(invitations.brokerageId, admin.brokerageId))
    .orderBy(desc(invitations.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  const [{ value: total }] = await db
    .select({ value: count() })
    .from(invitations)
    .where(eq(invitations.brokerageId, admin.brokerageId));

  res.json({ invitations: rows, page, pageSize, total });
});

authRouter.post("/admin/invitations/:id/revoke", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const admin = req.authedUser!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid invitation id." });
    return;
  }
  // Tenant scoping: the WHERE clause requires brokerageId to match the
  // caller's own brokerage, so an admin can never revoke another tenant's
  // invitation even by guessing/enumerating ids (cross-tenant test
  // coverage in Phase 5).
  const [updated] = await db
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(invitations.id, id), eq(invitations.brokerageId, admin.brokerageId), isNull(invitations.acceptedAt)))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "Invitation not found." });
    return;
  }
  await logAudit({ userId: admin.id, action: "invitation_revoked", recordType: "invitation", recordId: String(id) });
  res.status(204).end();
});

async function findLiveInvitationByPlaintextToken(plaintextToken: string) {
  const hash = hashToken(plaintextToken);
  const [invitation] = await db
    .select()
    .from(invitations)
    .where(and(eq(invitations.tokenHash, hash), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date())));
  if (!invitation) return null;
  const gate = await gatePlatformOwnerInvitation(invitation.id);
  if (gate !== "allow") return null;
  return invitation;
}

// Public, but reveals nothing about WHO was invited or WHY a token is
// invalid — only one of three opaque states (Phase 2 design §4.2).
authRouter.get("/invitations/:token/status", async (req, res) => {
  const invitation = await findLiveInvitationByPlaintextToken(req.params.token);
  res.json({ status: invitation ? "valid" : "invalid_or_expired" });
});

const acceptInvitationSchema = z.object({
  password: z.string(),
  // UAT-OB1: invitation accept must capture the person's own name. Extra
  // keys (role, brokerageId, userId) stay stripped, never trusted — role
  // and tenant still come only from the invitation row below.
  firstName: z.string({ required_error: "First name is required.", invalid_type_error: "First name is required." }),
  lastName: z.string({ required_error: "Last name is required.", invalid_type_error: "Last name is required." }),
  // Critical Blocker Remediation, Phase 8: acceptance of the current
  // Terms of Use / Privacy Policy is mandatory to create an account — both
  // documents are still marked DRAFT — LEGAL REVIEW REQUIRED (see
  // docs/legal/LEGAL_APPROVAL_REGISTER.md) and must not be presented to a
  // real pilot participant as final. The VERSION recorded is always
  // CURRENT_TERMS_VERSION/CURRENT_PRIVACY_VERSION as known to the server,
  // never a client-supplied value — see lib/auth/legalVersions.ts.
  acceptedTerms: z.literal(true, { errorMap: () => ({ message: "You must accept the Terms of Use to continue." }) }),
  acceptedPrivacyPolicy: z.literal(true, { errorMap: () => ({ message: "You must accept the Privacy Policy to continue." }) }),
});

authRouter.post("/invitations/:token/accept", async (req, res) => {
  const parsed = acceptInvitationSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "A password, your name, and acceptance of the Terms of Use and Privacy Policy are required." });
    return;
  }
  const firstName = normalizePersonName(parsed.data.firstName, "First name");
  if (!firstName.ok) {
    res.status(400).json({ error: firstName.error });
    return;
  }
  const lastName = normalizePersonName(parsed.data.lastName, "Last name");
  if (!lastName.ok) {
    res.status(400).json({ error: lastName.error });
    return;
  }
  const invitation = await findLiveInvitationByPlaintextToken(req.params.token);
  if (!invitation) {
    res.status(400).json({ error: "This invitation link is invalid or has expired." });
    return;
  }
  const policyViolation = passwordPolicyViolation(parsed.data.password);
  if (policyViolation) {
    res.status(400).json({ error: policyViolation });
    return;
  }

  const [existingUser] = await db.select().from(users).where(eq(users.email, invitation.email));
  if (existingUser) {
    // Extremely rare race (two accept requests for the same invitation, or
    // an account created out-of-band between invite and accept) — fail
    // closed rather than silently overwrite an existing account's
    // credentials via an invitation link.
    res.status(409).json({ error: "An account with this email already exists." });
    return;
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const now = new Date();
  let legalVersions;
  try {
    legalVersions = getActiveLegalVersions();
  } catch {
    res.status(503).json({ error: "Account creation is unavailable until approved legal documents are active." });
    return;
  }

  // Role/tenant come only from the invitation row created by an admin,
  // never from this request body (Phase 1 threat model T8).
  const [created] = await db
    .insert(users)
    .values({
      authProviderId: `invite:${invitation.email}`,
      email: invitation.email,
      firstName: firstName.value,
      lastName: lastName.value,
      role: invitation.role,
      brokerageId: invitation.brokerageId,
      passwordHash,
      emailVerifiedAt: now,
    })
    .returning();

  await db.update(invitations).set({ acceptedAt: now }).where(eq(invitations.id, invitation.id));

  await db.insert(consentRecords).values([
    { userId: created.id, consentType: "terms_of_use", documentVersion: legalVersions.termsVersion, acceptedAt: now },
    { userId: created.id, consentType: "privacy_policy", documentVersion: legalVersions.privacyVersion, acceptedAt: now },
  ]);

  await logAudit({ userId: created.id, userEmail: created.email, action: "invitation_accepted", recordType: "invitation", recordId: String(invitation.id) });
  await logAudit({ userId: created.id, userEmail: created.email, action: "user_signed_up", recordType: "user", recordId: String(created.id) });
  const invitingOwner = await platformOwnerInvitationActor(invitation.id);
  if (invitingOwner) {
    await logAudit({
      brokerageId: invitation.brokerageId,
      userId: invitingOwner.ownerUserId,
      action: "platform_owner_admin_provisioned",
      recordType: "user",
      recordId: String(created.id),
      updatedValue: "platform_owner=true",
      providerReference: `invitation:${invitation.id};actor:${invitingOwner.ownerUserId}`,
    });
  }

  setSessionCookie(res, created.id, created.sessionEpoch);
  const [brokerage] = await db.select().from(brokerages).where(eq(brokerages.id, created.brokerageId!));
  res.status(201).json({ user: userView(created, brokerage?.name) });
});

const loginSchema = z.object({ email: z.string().email(), password: z.string() });

// Real sign-in for the controlled pilot (Phase 2 design §4.3). Every
// failure mode below — unknown email, disabled account, never-completed
// invitation, wrong password, active lockout — returns the identical
// response, so none is distinguishable from outside (enumeration
// resistance, Phase 1 threat model T4).
authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(GENERIC_LOGIN_ERROR);
    return;
  }
  const { email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase();
  const [user] = await db.select().from(users).where(eq(users.email, normalizedEmail));

  if (!user || !user.isActive || !user.passwordHash) {
    // Still perform a hash comparison against a fixed dummy hash so this
    // branch takes roughly the same time as a real failed-password check —
    // otherwise a fast 401 here vs. a slower one below would itself leak
    // account existence via timing.
    await verifyPassword(await dummyHashForTiming(), password);
    res.status(401).json(GENERIC_LOGIN_ERROR);
    return;
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    res.status(401).json(GENERIC_LOGIN_ERROR);
    return;
  }

  const passwordOk = await verifyPassword(user.passwordHash, password);
  if (!passwordOk) {
    const attempts = user.failedLoginAttempts + 1;
    const shouldLock = attempts >= MAX_FAILED_LOGIN_ATTEMPTS;
    await db
      .update(users)
      .set({
        failedLoginAttempts: shouldLock ? 0 : attempts,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCKOUT_MS) : null,
      })
      .where(eq(users.id, user.id));
    await logAudit({ userId: user.id, userEmail: user.email, action: "login_failed", recordType: "user", recordId: String(user.id) });
    if (shouldLock) {
      await logAudit({ userId: user.id, userEmail: user.email, action: "account_locked", recordType: "user", recordId: String(user.id) });
      await dispatchOperationalAlert({
        type: "AUTH_ANOMALY",
        summary: "Account locked after repeated failed sign-in attempts",
        dedupKey: `auth-lockout:${user.id}`,
        details: { userId: user.id, brokerageId: user.brokerageId },
      });
    }
    res.status(401).json(GENERIC_LOGIN_ERROR);
    return;
  }

  let legalVersions;
  try {
    legalVersions = getActiveLegalVersions();
  } catch {
    res.status(503).json({ error: "Sign-in is unavailable until approved legal documents are active." });
    return;
  }
  const accepted = await db.select().from(consentRecords).where(eq(consentRecords.userId, user.id));
  if (
    !accepted.some((r) => r.consentType === "terms_of_use" && r.documentVersion === legalVersions.termsVersion) ||
    !accepted.some((r) => r.consentType === "privacy_policy" && r.documentVersion === legalVersions.privacyVersion)
  ) {
    res.status(428).json({
      error: "You must accept the current Terms of Use and Privacy Policy before signing in.",
      code: "LEGAL_ACCEPTANCE_REQUIRED",
      termsVersion: legalVersions.termsVersion,
      privacyVersion: legalVersions.privacyVersion,
    });
    return;
  }

  await db.update(users).set({ failedLoginAttempts: 0, lockedUntil: null }).where(eq(users.id, user.id));
  await logAudit({ userId: user.id, userEmail: user.email, action: "user_signed_in", recordType: "user", recordId: String(user.id) });
  setSessionCookie(res, user.id, user.sessionEpoch);
  const [brokerage] = user.brokerageId ? await db.select().from(brokerages).where(eq(brokerages.id, user.brokerageId)) : [];
  res.json({ user: userView(user, brokerage?.name) });
});

// A real (never-usable) Argon2id hash, computed lazily on first use and
// cached, purely so the "no such user" / "no password set yet" branch above
// can spend approximately the same wall-clock time as a genuine
// wrong-password check. Never derived from, or comparable to, any real
// account's password.
let dummyHashPromise: Promise<string> | null = null;
function dummyHashForTiming(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword("timing-safety-dummy-value-never-a-real-password");
  }
  return dummyHashPromise;
}

const requestResetSchema = z.object({ email: z.string().email() });

const PASSWORD_RESET_ACCEPTED = { message: "If that email address has an account, a reset link has been sent." } as const;

authRouter.post("/password-reset/request", async (req, res) => {
  // WS4-11 D-PR: a restored environment sends no reset email. Answer the same 202 for every address
  // before any lookup — no token row, no account-existence oracle (body or timing).
  if (outboundBlocked("auth_email")) {
    res.status(202).json(PASSWORD_RESET_ACCEPTED);
    return;
  }
  const parsed = requestResetSchema.safeParse(req.body);
  if (parsed.success) {
    const normalizedEmail = parsed.data.email.toLowerCase();
    const [user] = await db.select().from(users).where(eq(users.email, normalizedEmail));
    if (user && user.isActive) {
      const { plaintext, hash } = generateToken();
      const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);
      await db.insert(passwordResetTokens).values({ userId: user.id, tokenHash: hash, expiresAt });
      const resetUrl = `${frontendBaseUrl()}/reset-password/${plaintext}`;
      await getAuthEmailProvider().sendPasswordReset({ to: user.email, resetUrl, expiresAt });
      await logAudit({ userId: user.id, userEmail: user.email, action: "password_reset_requested", recordType: "user", recordId: String(user.id) });
    }
  }
  // Always 202, regardless of whether the email exists, whether the body
  // was even valid, or whether the account is disabled — no
  // account-existence leak (Phase 1 threat model T4, Phase 2 design §4.5).
  res.status(202).json(PASSWORD_RESET_ACCEPTED);
});

const confirmResetSchema = z.object({ token: z.string().min(1), password: z.string() });
const GENERIC_RESET_ERROR = { error: "This reset link is invalid or has expired." };

authRouter.post("/password-reset/confirm", async (req, res) => {
  const parsed = confirmResetSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(GENERIC_RESET_ERROR);
    return;
  }
  const hash = hashToken(parsed.data.token);
  const [tokenRow] = await db
    .select()
    .from(passwordResetTokens)
    .where(and(eq(passwordResetTokens.tokenHash, hash), isNull(passwordResetTokens.usedAt), gt(passwordResetTokens.expiresAt, new Date())));
  if (!tokenRow) {
    res.status(400).json(GENERIC_RESET_ERROR);
    return;
  }
  const policyViolation = passwordPolicyViolation(parsed.data.password);
  if (policyViolation) {
    res.status(400).json({ error: policyViolation });
    return;
  }

  if (req.platformOwner && req.authedUser && tokenRow.userId !== req.authedUser.id) {
    const guard = await platformOwnerAdminGuard(tokenRow.userId);
    if (guard === "protected") {
      res.status(403).json(OWNER_TARGET_PROTECTED);
      return;
    }
    if (guard === "unavailable") {
      res.status(503).json({ error: "Your access could not be verified. Please retry." });
      return;
    }
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const [updated] = await db
    .update(users)
    // Bumping sessionEpoch revokes every existing session for this user —
    // a password reset must invalidate any session an attacker may already
    // hold (Phase 2 design §4.5).
    .set({ passwordHash, failedLoginAttempts: 0, lockedUntil: null, sessionEpoch: sql`${users.sessionEpoch} + 1` })
    .where(eq(users.id, tokenRow.userId))
    .returning();
  await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, tokenRow.id));

  if (updated) {
    await logAudit({ userId: updated.id, userEmail: updated.email, action: "password_reset_completed", recordType: "user", recordId: String(updated.id) });
  }
  res.status(204).end();
});

const changePasswordSchema = z.object({ currentPassword: z.string(), newPassword: z.string() });

authRouter.post("/change-password", requireAuth, async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter your current and new password." });
    return;
  }
  const authed = req.authedUser!;
  const [user] = await db.select().from(users).where(eq(users.id, authed.id));
  if (!user || !user.passwordHash || !(await verifyPassword(user.passwordHash, parsed.data.currentPassword))) {
    res.status(401).json({ error: "Current password is incorrect." });
    return;
  }
  const policyViolation = passwordPolicyViolation(parsed.data.newPassword);
  if (policyViolation) {
    res.status(400).json({ error: policyViolation });
    return;
  }
  const passwordHash = await hashPassword(parsed.data.newPassword);
  await db
    .update(users)
    .set({ passwordHash, sessionEpoch: sql`${users.sessionEpoch} + 1` })
    .where(eq(users.id, user.id));
  await logAudit({ userId: user.id, userEmail: user.email, action: "password_changed", recordType: "user", recordId: String(user.id) });
  // The caller's own current session must keep working after this — issue
  // a fresh cookie against the new epoch rather than logging them out.
  const [refreshed] = await db.select().from(users).where(eq(users.id, user.id));
  setSessionCookie(res, user.id, refreshed!.sessionEpoch);
  res.status(204).end();
});

// Secure, authenticated, tenant-scoped, paginated user directory — the
// legitimate replacement for GET /known-users' enumeration (Phase 3
// priority: "secure user discovery and account administration").
authRouter.get("/admin/users", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const admin = req.authedUser!;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));

  const rows = await db
    .select()
    .from(users)
    .where(eq(users.brokerageId, admin.brokerageId))
    .orderBy(desc(users.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const [{ value: total }] = await db.select({ value: count() }).from(users).where(eq(users.brokerageId, admin.brokerageId));

  res.json({
    users: rows.map((r) => ({
      id: r.id,
      email: r.email,
      firstName: r.firstName,
      lastName: r.lastName,
      role: r.role,
      isActive: r.isActive,
      emailVerifiedAt: r.emailVerifiedAt,
      createdAt: r.createdAt,
    })),
    page,
    pageSize,
    total,
  });
});

// Disable / re-enable a tenant member. Tenant-scoped (WHERE brokerageId =
// caller's own) so an admin can never act on another tenant's user even by
// guessing an id. Disabling bumps sessionEpoch in the same update so any
// already-issued token for that user dies immediately (Phase 2 design §4.6)
// — not just on its next epoch-check miss.
authRouter.post("/admin/users/:id/disable", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const admin = req.authedUser!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid user id." });
    return;
  }
  if (id === admin.id) {
    res.status(400).json({ error: "You cannot disable your own account." });
    return;
  }
  if (await rejectPlatformOwnerTarget(res, admin.brokerageId, id)) return;
  const updated = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${admin.brokerageId})`);
    const [target] = await tx.select().from(users).where(and(eq(users.id, id), eq(users.brokerageId, admin.brokerageId)));
    if (!target) return undefined;
    if (target.role === "Brokerage Administrator" && target.isActive) {
      const activeAdmins = await tx
        .select({ value: count() })
        .from(users)
        .where(and(eq(users.brokerageId, admin.brokerageId), eq(users.role, "Brokerage Administrator"), eq(users.isActive, true)));
      if (Number(activeAdmins[0]?.value ?? 0) <= 1) return null;
    }
    const [row] = await tx
      .update(users)
      .set({ isActive: false, sessionEpoch: sql`${users.sessionEpoch} + 1` })
      .where(and(eq(users.id, id), eq(users.brokerageId, admin.brokerageId)))
      .returning();
    return row;
  });
  if (updated === null) {
    res.status(409).json({ error: "The last active brokerage administrator cannot be disabled." });
    return;
  }
  if (!updated) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  await logAudit({ userId: admin.id, action: "account_disabled", recordType: "user", recordId: String(id) });
  res.status(204).end();
});

const administratorSuccessionSchema = z.object({
  targetUserId: z.number().int().positive(),
  currentPassword: z.string().min(1),
  confirmation: z.literal("TRANSFER ADMINISTRATOR"),
});

authRouter.post("/admin/succession", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const parsed = administratorSuccessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Target, current password, and exact confirmation are required." });
    return;
  }
  const admin = req.authedUser!;
  if (parsed.data.targetUserId === admin.id) {
    res.status(400).json({ error: "You cannot transfer administrator authority to yourself." });
    return;
  }
  if (await rejectPlatformOwnerTarget(res, admin.brokerageId, parsed.data.targetUserId)) return;

  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${admin.brokerageId})`);
    const [current] = await tx.select().from(users).where(eq(users.id, admin.id));
    if (
      !current ||
      current.brokerageId !== admin.brokerageId ||
      current.role !== "Brokerage Administrator" ||
      !current.isActive ||
      !current.passwordHash ||
      !(await verifyPassword(current.passwordHash, parsed.data.currentPassword))
    ) return { kind: "unauthorized" as const };
    const [target] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, parsed.data.targetUserId), eq(users.brokerageId, admin.brokerageId)));
    if (!target) return { kind: "not_found" as const };
    if (!target.isActive || !target.emailVerifiedAt) return { kind: "ineligible" as const };
    if (target.role === "Brokerage Administrator") return { kind: "already_admin" as const };

    await tx
      .update(users)
      .set({ role: "Agent", sessionEpoch: sql`${users.sessionEpoch} + 1` })
      .where(eq(users.id, current.id));
    await tx
      .update(users)
      .set({ role: "Brokerage Administrator", sessionEpoch: sql`${users.sessionEpoch} + 1` })
      .where(eq(users.id, target.id));
    await tx.insert(auditLogs).values([
      {
        userId: current.id,
        userEmail: current.email,
        action: "administrator_succession_completed",
        recordType: "user",
        recordId: String(current.id),
        previousValue: "Brokerage Administrator",
        updatedValue: "Agent",
        providerReference: String(target.id),
      },
      {
        userId: current.id,
        userEmail: current.email,
        action: "administrator_authority_granted",
        recordType: "user",
        recordId: String(target.id),
        previousValue: target.role,
        updatedValue: "Brokerage Administrator",
        providerReference: String(current.id),
      },
    ]);
    return { kind: "success" as const, current, target };
  });

  if (outcome.kind === "unauthorized") {
    res.status(401).json({ error: "Fresh authentication failed." });
    return;
  }
  if (outcome.kind === "not_found") {
    res.status(404).json({ error: "User not found." });
    return;
  }
  if (outcome.kind === "ineligible") {
    res.status(409).json({ error: "The successor must be an active, verified user in your brokerage." });
    return;
  }
  if (outcome.kind === "already_admin") {
    res.status(409).json({ error: "The selected user is already an administrator." });
    return;
  }

  const notifications = await Promise.allSettled([
    getAuthEmailProvider().sendAdministratorSuccession({
      to: outcome.current.email,
      counterpartEmail: outcome.target.email,
      becameAdministrator: false,
    }),
    getAuthEmailProvider().sendAdministratorSuccession({
      to: outcome.target.email,
      counterpartEmail: outcome.current.email,
      becameAdministrator: true,
    }),
  ]);
  const failedNotifications = notifications.filter((result) => result.status === "rejected");
  if (failedNotifications.length) {
    // The authority transfer has committed and must remain successful even
    // when a side-effecting notification provider is unavailable. The
    // operational-alert dispatcher records failure and releases its dedup
    // reservation on failed delivery so this evidence is retryable.
    const retryEvidence = {
      event: "administrator_succession_notification_retry_required",
      previousAdministratorId: outcome.current.id,
      newAdministratorId: outcome.target.id,
      failedRecipients: failedNotifications.length,
      retryable: true,
    };
    logger.error(retryEvidence.event, retryEvidence);
    await dispatchOperationalAlert({
      type: "AUTH_ANOMALY",
      summary: "Administrator succession notification delivery failed after commit",
      dedupKey: `administrator-succession-notification:${outcome.current.id}:${outcome.target.id}`,
      details: {
        retryable: true,
        failedRecipients: failedNotifications.length,
        previousAdministratorId: outcome.current.id,
        newAdministratorId: outcome.target.id,
      },
    });
  }
  clearSessionCookie(res);
  res.status(204).end();
});

authRouter.post("/admin/users/:id/enable", requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES), async (req, res) => {
  const admin = req.authedUser!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid user id." });
    return;
  }
  if (await rejectPlatformOwnerTarget(res, admin.brokerageId, id)) return;
  const [updated] = await db
    .update(users)
    .set({ isActive: true })
    .where(and(eq(users.id, id), eq(users.brokerageId, admin.brokerageId)))
    .returning();
  if (!updated) {
    res.status(404).json({ error: "User not found." });
    return;
  }
  await logAudit({ userId: admin.id, action: "account_enabled", recordType: "user", recordId: String(id) });
  res.status(204).end();
});
