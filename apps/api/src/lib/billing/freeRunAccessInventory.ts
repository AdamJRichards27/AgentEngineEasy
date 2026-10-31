import { and, eq, inArray, ne } from "drizzle-orm";
import { db, brokerages, entitlementGrants, platformOwners, subscriptions, users } from "@aee/db";

/**
 * Owner t222u (2026-10-31): READ-ONLY inventory of free (non-subscription) run.access grants, for the
 * safe-removal plan in docs/T222U_FREE_RUN_ACCESS_REMOVAL_PLAN.md. This module never writes: it has no
 * apply mode. Removal itself is a separately approved step and must never run on a shared database
 * without explicit Owner authorisation.
 *
 * Sources of free run.access today: the boot backfill (lib/billing/runAccessBackfill.ts, every
 * brokerage on every boot) and dev-login brokerage creation (routes/auth.ts), both sourceType
 * "migration". Any other non-subscription source (e.g. "manual") is reported too.
 *
 * Classification, first match wins:
 *   PROTECTED_PLATFORM_ADMIN     a Platform Owner belongs to the brokerage
 *   PROTECTED_TEST_OR_ALLOWLIST  listed by id or name prefix (test/QA/demo tenants the Owner names)
 *   PROTECTED_AUTHORISED_TRIAL   a Trialing subscription whose recorded trial end is in the future
 *   REDUNDANT_PAID_RUN           also holds a current subscription run.access grant (removal changes nothing)
 *   WOULD_LOSE_RUN_ACCESS        loses Run on removal (Grow from a Grow subscription, if any, is unaffected)
 */
export type FreeRunClassification =
  | "PROTECTED_PLATFORM_ADMIN"
  | "PROTECTED_TEST_OR_ALLOWLIST"
  | "PROTECTED_AUTHORISED_TRIAL"
  | "REDUNDANT_PAID_RUN"
  | "WOULD_LOSE_RUN_ACCESS";

export interface FreeRunRow {
  brokerageId: number;
  brokerageName: string;
  grantIds: number[];
  sourceTypes: string[];
  activeUsers: number;
  hasGrowSubscription: boolean;
  classification: FreeRunClassification;
}

export interface FreeRunPlan {
  generatedAt: string;
  rows: FreeRunRow[];
  counts: Record<FreeRunClassification, number>;
  usersLosingRunAccess: number;
}

export async function planFreeRunAccessRemoval(opts: { protectBrokerageIds?: number[]; protectNamePrefixes?: string[]; now?: Date } = {}): Promise<FreeRunPlan> {
  const now = opts.now ?? new Date();
  const live = (g: { status: string; startsAt: Date | null; endsAt: Date | null }) =>
    g.status === "Active" && (!g.startsAt || g.startsAt <= now) && (!g.endsAt || g.endsAt >= now);

  const free = (await db.select().from(entitlementGrants)
    .where(and(eq(entitlementGrants.entitlementKey, "run.access"), ne(entitlementGrants.sourceType, "subscription")))).filter(live);
  const ids = [...new Set(free.map((g) => g.brokerageId))];
  const counts = { PROTECTED_PLATFORM_ADMIN: 0, PROTECTED_TEST_OR_ALLOWLIST: 0, PROTECTED_AUTHORISED_TRIAL: 0, REDUNDANT_PAID_RUN: 0, WOULD_LOSE_RUN_ACCESS: 0 };
  if (ids.length === 0) return { generatedAt: now.toISOString(), rows: [], counts, usersLosingRunAccess: 0 };

  const bRows = await db.select({ id: brokerages.id, name: brokerages.name }).from(brokerages).where(inArray(brokerages.id, ids));
  const uRows = await db.select({ id: users.id, brokerageId: users.brokerageId, isActive: users.isActive }).from(users).where(inArray(users.brokerageId, ids));
  const owners = new Set((await db.select({ userId: platformOwners.userId }).from(platformOwners)).map((o) => o.userId));
  const subGrants = (await db.select().from(entitlementGrants)
    .where(and(inArray(entitlementGrants.brokerageId, ids), eq(entitlementGrants.sourceType, "subscription")))).filter(live);
  const subs = await db.select().from(subscriptions).where(inArray(subscriptions.brokerageId, ids));
  const protectIds = new Set(opts.protectBrokerageIds ?? []);
  const prefixes = (opts.protectNamePrefixes ?? []).filter((p) => p.length > 0);

  const rows: FreeRunRow[] = [];
  for (const b of bRows.sort((x, y) => x.id - y.id)) {
    const members = uRows.filter((u) => u.brokerageId === b.id);
    const grants = free.filter((g) => g.brokerageId === b.id);
    const paidRun = subGrants.some((g) => g.brokerageId === b.id && g.entitlementKey === "run.access");
    const hasGrowSubscription = subGrants.some((g) => g.brokerageId === b.id && g.entitlementKey === "grow.access");
    const trial = subs.some((s) => s.brokerageId === b.id && s.status === "Trialing" && s.trialEndsAt && s.trialEndsAt > now);
    let classification: FreeRunClassification;
    if (members.some((u) => owners.has(u.id))) classification = "PROTECTED_PLATFORM_ADMIN";
    else if (protectIds.has(b.id) || prefixes.some((p) => b.name.startsWith(p))) classification = "PROTECTED_TEST_OR_ALLOWLIST";
    else if (trial) classification = "PROTECTED_AUTHORISED_TRIAL";
    else if (paidRun) classification = "REDUNDANT_PAID_RUN";
    else classification = "WOULD_LOSE_RUN_ACCESS";
    counts[classification] += 1;
    rows.push({
      brokerageId: b.id, brokerageName: b.name, grantIds: grants.map((g) => g.id), sourceTypes: [...new Set(grants.map((g) => g.sourceType))],
      activeUsers: members.filter((u) => u.isActive).length, hasGrowSubscription, classification,
    });
  }
  const usersLosingRunAccess = rows.filter((r) => r.classification === "WOULD_LOSE_RUN_ACCESS").reduce((n, r) => n + r.activeUsers, 0);
  return { generatedAt: now.toISOString(), rows, counts, usersLosingRunAccess };
}
