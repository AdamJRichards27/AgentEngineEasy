// Owner t171u (5): "eliminate the AI Assistant offer-price disclosure
// vulnerability. Apply permissions at the server/tool level, not merely in
// the interface." Policy is Owner t165u: "Offer prices: listing agent and
// authorised brokerage administrators only."
//
// This module is the one place the AI tool path decides whether offer
// prices (and the transaction purchase price an accepted offer becomes) may
// leave the server in a tool result. It mirrors the Run lane's rule on draft
// #271 (lib/offers.ts canSeeOfferTerms, routes/offers.ts
// offerPropertyAccess, lib/transactionPriceAccess.ts) without importing that
// moving branch, so the two copies can be consolidated once #271 lands:
//
//   - Brokerage Administrator of the property's brokerage: full.
//   - the Agent who is the property's listing agent (properties.agent_id):
//     full.
//   - anyone else in the same brokerage (other Agents, Pit Crew, any other
//     or unknown role): redacted. Price fields are omitted, never nulled or
//     zeroed, and a marker says they were withheld so the model does not
//     guess or infer a figure. (#271 lets an ASSIGNED Pit Crew user see the
//     transaction purchase price under Owner t170u; that is an audited
//     route-level reveal. The AI tools never return a purchase price to Pit
//     Crew, which is the stricter of the two and needs no audit write.)
//   - a caller without run.access (e.g. a Grow-only brokerage or user):
//     no offer data at all. routes/offers.ts gates every offer route on
//     requireEntitlement("run.access"); POST /ai/ask is requireAuth only, so
//     the AI tools re-check it here. The entitlement is read fresh
//     (explainEntitlementDecision, uncached) and any lookup failure denies.
//   - a property in another brokerage, a missing property, or a caller whose
//     identity or brokerage cannot be confirmed: denied. The tool returns
//     nothing about the property.
//
// Fail closed: identity is re-read from the users table rather than trusted
// from the context package. A missing/inactive user, a user whose brokerage
// differs from the request's, or a role the context and the database
// disagree on is denied; a role this rule does not name is redacted; an
// unset listing agent means only a Brokerage Administrator gets full access.

import { eq } from "drizzle-orm";
import { db, properties, users } from "@aee/db";
import { BROKERAGE_ADMIN_ROLES } from "../../../middlewares/auth.js";
import { explainEntitlementDecision } from "../../entitlements/resolver.js";
import type { AiContextPackage } from "../types.js";

export type AiOfferPriceAccess =
  | { kind: "full"; role: string; listingAgentId: number | null }
  | { kind: "redacted"; role: string; listingAgentId: number | null }
  | { kind: "no_run_access"; role: string }
  | { kind: "denied" };

/** Offers are a Run surface: the same entitlement routes/offers.ts requires. */
export const AI_OFFER_ENTITLEMENT = "run.access";

/** Shown to the model wherever a price field was removed. */
export const AI_PRICE_WITHHELD_MARKER =
  "WITHHELD: offer and sale prices are visible only to the listing agent and Brokerage Administrators. Do not estimate, infer or restate a price.";

/** Replaces a dollar figure inside a free-text label for a redacted caller. */
export const AI_PRICE_WITHHELD_INLINE = "[price withheld]";

/** Pure rule, same as #271's canSeeOfferTerms. */
export function canSeeOfferPricesForAi(role: string, userId: number, listingAgentId: number | null | undefined): boolean {
  if ((BROKERAGE_ADMIN_ROLES as readonly string[]).includes(role)) return true;
  return role === "Agent" && listingAgentId != null && listingAgentId === userId;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Decides access to price fields for the property `propertyId` for the caller
 * described by `ctx`. Never throws for a missing row; a database error
 * propagates, and the tool's caller treats a thrown tool as a failure.
 */
export async function resolveAiOfferPriceAccess(
  ctx: Pick<AiContextPackage, "userId" | "brokerageId" | "userRole">,
  propertyId: number | null | undefined,
): Promise<AiOfferPriceAccess> {
  if (!isPositiveInt(ctx.userId) || !isPositiveInt(ctx.brokerageId) || !isPositiveInt(propertyId)) return { kind: "denied" };
  if (typeof ctx.userRole !== "string" || ctx.userRole.trim() === "") return { kind: "denied" };

  const [property] = await db
    .select({ brokerageId: properties.brokerageId, agentId: properties.agentId })
    .from(properties)
    .where(eq(properties.id, propertyId));
  if (!property || property.brokerageId !== ctx.brokerageId) return { kind: "denied" };

  const [caller] = await db
    .select({ role: users.role, brokerageId: users.brokerageId, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, ctx.userId));
  if (!caller || caller.isActive === false || caller.brokerageId !== ctx.brokerageId) return { kind: "denied" };
  if (caller.role !== ctx.userRole) return { kind: "denied" };

  const runAccess = await explainEntitlementDecision(
    { id: ctx.userId, role: caller.role, brokerageId: ctx.brokerageId },
    AI_OFFER_ENTITLEMENT,
  );
  if (runAccess.allowed !== true) return { kind: "no_run_access", role: caller.role };

  const listingAgentId = property.agentId ?? null;
  return canSeeOfferPricesForAi(caller.role, ctx.userId, listingAgentId)
    ? { kind: "full", role: caller.role, listingAgentId }
    : { kind: "redacted", role: caller.role, listingAgentId };
}

const DOLLAR_FIGURE = /\$\s?\d[\d,]*(?:\.\d+)?/g;

/** Removes every dollar figure from a label (redacted callers only). */
export function scrubDollarFigures(text: string): string {
  return text.replace(DOLLAR_FIGURE, AI_PRICE_WITHHELD_INLINE);
}

// Keys that carry, or let a reader derive, an offer or transaction figure.
const PRICE_KEY = /price|amount|commission|gst|deposit|cents|fee|payout|funds/i;

/** True when any key at any depth of `value` looks like a price/financial field. */
export function containsPriceKey(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsPriceKey(item, depth + 1));
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (PRICE_KEY.test(key)) return true;
    if (typeof inner === "string" && /^\s*\{/.test(inner)) {
      try {
        if (containsPriceKey(JSON.parse(inner), depth + 1)) return true;
      } catch {
        // not JSON; fall through
      }
    }
    if (containsPriceKey(inner, depth + 1)) return true;
  }
  return false;
}
