import { db, entitlementGrants } from "@aee/db";
import type { EntitlementGrant } from "@aee/db";
import { logger } from "@aee/events";
import { and, eq } from "drizzle-orm";
import type { EntitlementActor, EntitlementDecision, DenialReasonCode } from "./types.js";
import { EntitlementError } from "./types.js";

/**
 * Central entitlement resolver (Grow Stage A). Grants are the sole source of truth read here -
 * the billing webhook keeps entitlementGrants in sync with subscription state, so this never
 * re-derives access from a subscription row at request time. Deny on missing/ambiguous tenant
 * context, deny on resolver error (fail closed), never leak another brokerage's grants.
 */

interface CacheEntry {
  grants: EntitlementGrant[];
  expiresAt: number;
}
const CACHE_TTL_MS = 30_000;
const cache = new Map<number, CacheEntry>();

async function loadGrantsForBrokerage(brokerageId: number): Promise<EntitlementGrant[]> {
  const cached = cache.get(brokerageId);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.grants;
  const rows = await db.select().from(entitlementGrants).where(eq(entitlementGrants.brokerageId, brokerageId));
  cache.set(brokerageId, { grants: rows, expiresAt: now + CACHE_TTL_MS });
  return rows;
}

export function invalidateEntitlementCache(brokerageId: number): void {
  cache.delete(brokerageId);
}

function grantAppliesToActor(grant: EntitlementGrant, actor: EntitlementActor): boolean {
  if (grant.granteeType === "user") return grant.granteeId === actor.id;
  if (grant.granteeType === "brokerage") return true;
  if (grant.granteeType === "platform") return true;
  // office / team: no tenancy table exists yet to resolve membership against - fail closed
  // rather than guess. Schema-ready, not resolvable, in Stage A.
  return false;
}

function grantIsCurrentlyActive(grant: EntitlementGrant, now: Date): boolean {
  if (grant.status !== "Active") return false;
  if (grant.startsAt && new Date(grant.startsAt) > now) return false;
  if (grant.endsAt && new Date(grant.endsAt) < now) return false;
  return true;
}

/**
 * Fast path for the hot request loop (middleware, UI capability checks) - returns the set of
 * entitlement keys currently granted to this actor. Empty set (not a throw) when actor/tenant
 * context is missing, so callers that only need a boolean don't have to catch.
 */
export async function resolveEntitlements(actor: EntitlementActor | null | undefined): Promise<Set<string>> {
  if (!actor || !actor.brokerageId) return new Set();
  let grants: EntitlementGrant[];
  try {
    grants = await loadGrantsForBrokerage(actor.brokerageId);
  } catch (err) {
    logger.error("resolve_entitlements_grant_lookup_failed", { brokerageId: actor.brokerageId, actorId: actor.id, error: err });
    return new Set();
  }
  const now = new Date();
  const keys = new Set<string>();
  for (const grant of grants) {
    if (grantIsCurrentlyActive(grant, now) && grantAppliesToActor(grant, actor)) {
      keys.add(grant.entitlementKey);
    }
  }
  return keys;
}

export async function hasEntitlement(actor: EntitlementActor | null | undefined, entitlementKey: string): Promise<boolean> {
  const keys = await resolveEntitlements(actor);
  return keys.has(entitlementKey);
}

export async function getEntitlementLimit(actor: EntitlementActor | null | undefined, entitlementKey: string): Promise<number | null> {
  if (!actor || !actor.brokerageId) return null;
  const grants = await loadGrantsForBrokerage(actor.brokerageId);
  const now = new Date();
  const match = grants.find(
    (g) => g.entitlementKey === entitlementKey && grantIsCurrentlyActive(g, now) && grantAppliesToActor(g, actor),
  );
  return match?.limitValue ?? null;
}

/**
 * Diagnostic path - not on the hot loop. Distinguishes MISSING vs EXPIRED vs SUBSCRIPTION_
 * INACTIVE for a 403 response / support debugging, by looking at every grant row for this
 * (brokerage, key) pair regardless of current status, not just the active set.
 */
export async function explainEntitlementDecision(
  actor: EntitlementActor | null | undefined,
  entitlementKey: string,
): Promise<EntitlementDecision> {
  const base = { entitlementKey, limitValue: null as number | null, grantId: null as number | null };
  if (!actor) {
    return { ...base, allowed: false, reason: "NOT_AUTHENTICATED" };
  }
  if (!actor.brokerageId) {
    return { ...base, allowed: false, reason: "TENANT_CONTEXT_REQUIRED" };
  }
  try {
    const allRows = await db.select().from(entitlementGrants).where(
      and(eq(entitlementGrants.brokerageId, actor.brokerageId), eq(entitlementGrants.entitlementKey, entitlementKey)),
    );
    const applicable = allRows.filter((g) => grantAppliesToActor(g, actor));
    if (applicable.length === 0) {
      return { ...base, allowed: false, reason: "ENTITLEMENT_MISSING" };
    }
    const now = new Date();
    const active = applicable.find((g) => grantIsCurrentlyActive(g, now));
    if (active) {
      return { ...base, allowed: true, reason: "OK", limitValue: active.limitValue ?? null, grantId: active.id };
    }
    const revokedFromSubscription = applicable.find((g) => g.status === "Revoked" && g.sourceType === "subscription");
    if (revokedFromSubscription) {
      return { ...base, allowed: false, reason: "SUBSCRIPTION_INACTIVE", grantId: revokedFromSubscription.id };
    }
    const expired = applicable.find((g) => g.endsAt && new Date(g.endsAt) < now);
    if (expired) {
      return { ...base, allowed: false, reason: "ENTITLEMENT_EXPIRED", grantId: expired.id };
    }
    return { ...base, allowed: false, reason: "ENTITLEMENT_MISSING" };
  } catch (err) {
    logger.error("explain_entitlement_decision_failed", { brokerageId: actor.brokerageId, entitlementKey, error: err });
    return { ...base, allowed: false, reason: "ENTITLEMENT_MISSING" };
  }
}

export async function requireEntitlement(actor: EntitlementActor | null | undefined, entitlementKey: string): Promise<void> {
  const decision = await explainEntitlementDecision(actor, entitlementKey);
  if (decision.allowed === false) {
    throw new EntitlementError(decision.reason as DenialReasonCode, entitlementKey);
  }
}
