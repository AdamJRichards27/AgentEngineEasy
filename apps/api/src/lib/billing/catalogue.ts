import { db, products, prices, entitlementDefinitions, productEntitlements } from "@aee/db";
import { eq, and } from "drizzle-orm";
import { ENTITLEMENT_KEYS } from "@aee/db";
import { logger } from "@aee/events";

/**
 * Idempotent product/price/entitlement catalogue bootstrap. Safe to call on every boot -
 * everything here is check-then-insert, never a blind insert, so restarts never duplicate rows.
 *
 * Pricing is DATA, not logic: the amounts below are the current marketing prices (t222u: Grow $139/mo,
 * Run incl. Grow (Pro+Grow bundle) $289/mo; legacy Starter $69/mo not offered) captured as seeded catalogue rows. Nothing in the
 * entitlement resolver reads these numbers - it only reads entitlementGrants. Change a price by
 * editing this seed (or, later, an admin UI over the `prices` table), never by editing
 * permission logic.
 *
 * AE GROW Priority 0.5 — Workstream 3: this file previously mapped every ENTITLEMENT_KEYS entry
 * onto both growProductId and bundleProductId in one undifferentiated loop. Now that
 * ENTITLEMENT_KEYS also includes "run.access" (packages/db/src/schema/billing.ts), that same
 * loop would have silently given every Grow-only purchaser RUN access too — exactly the product
 * boundary violation Priority 0.5 exists to prevent. GROW_ENTITLEMENT_KEYS below keeps the Grow
 * product to the grow.* keys only (Grow never grants run.access). RUN-INCLUDES-GROW (t220u,
 * 2026-10-31): the Starter/RUN product now gets the full union (run.access + every grow.* key),
 * because Run includes Grow; the Pro+Grow bundle also gets the full union — matching its name and its $289/mo
 * price point, which has always been positioned as "Pro (RUN) + Grow" rather than Grow alone.
 */

const ENTITLEMENT_DEFS: Record<(typeof ENTITLEMENT_KEYS)[number], string> = {
  "run.access": "Access the RUN operational platform (transaction workflow, Pit Crew, financial transaction engine) at all.",
  "grow.access": "Access the Grow module at all.",
  "grow.contacts.read": "View Grow people/organisation records.",
  "grow.contacts.manage": "Create and edit Grow people/organisation records.",
  "grow.properties.link": "Link people to properties via Grow relationships.",
  "grow.relationships.manage": "Create, edit and review person-property relationships.",
  "grow.activities.manage": "Log and edit Grow activities (calls, emails, meetings, notes).",
  "grow.opportunities.manage": "Create, progress and convert Grow opportunities.",
  "grow.import.execute": "Run a Grow contact/property import job.",
  "grow.import.review": "Review and resolve import matches/merges without executing the import.",
  "grow.ai.use": "Ask Agent Engine questions scoped to Grow context.",
  "grow.automation.use": "Use Grow automation rules once available.",
  "grow.campaigns.use": "Use Grow campaign orchestration once available.",
  "grow.admin.configure": "Configure Grow settings for the brokerage.",
  "grow.propertyIntelligence.read": "View property provider observations, match candidates and opportunity signals.",
  "grow.propertyIntelligence.manage": "Confirm or reject property matches, review or dismiss opportunity signals, and promote a signal into a Grow opportunity.",
  "grow.calling.access": "Initiate and manage sandbox call sessions and check contact call eligibility.",
  "grow.calling.recording": "Capture, grant and withdraw call recording consent, separate from call access.",
  "grow.calling.transcription": "Transcribe a consented call recording, review and edit its draft summary, and propose governed follow-ups from the approved items.",
};

const GROW_ENTITLEMENT_KEYS = ENTITLEMENT_KEYS.filter((key) => key !== "run.access");

const GROW_PRODUCT_CODE = "grow";
const STARTER_PRODUCT_CODE = "agent_engine_starter";
const BUNDLE_PRODUCT_CODE = "agent_engine_pro_grow_bundle";

/**
 * Owner t222u (2026-10-31) commercial catalogue: Grow $139/month; Run $289/month TOTAL including every
 * Grow feature (the Pro + Grow bundle product). The $69 Starter offer is obsolete: it is no longer OFFERED
 * to new subscriptions (hidden from GET /billing/catalogue and refused by POST /billing/checkout), but the
 * product, its price and its entitlement mapping stay so EXISTING Starter subscriptions keep syncing
 * unchanged. Any change to an existing customer's billing is a separately reviewed, approved migration
 * (see docs/T222U_STARTER_SUBSCRIPTION_REVIEW.md); nothing here changes one.
 *
 * Seed amounts apply only where no Active price exists yet (ensurePrice is insert-only). A database
 * already seeded at the old amounts (Grow $99) keeps them until an approved price change; boot logs
 * catalogue_seed_price_differs so the drift is visible. This never rewrites a live price row.
 */
export const CATALOGUE_PRICES_CENTS: Record<string, number> = {
  [GROW_PRODUCT_CODE]: 13900,
  [STARTER_PRODUCT_CODE]: 6900, // legacy only: existing subscriptions; not offered
  [BUNDLE_PRODUCT_CODE]: 28900,
};
export const OFFERED_PRODUCT_CODES: readonly string[] = [GROW_PRODUCT_CODE, BUNDLE_PRODUCT_CODE];
export const RETIRED_PRODUCT_CODES: readonly string[] = [STARTER_PRODUCT_CODE];
export function isOfferedProductCode(code: string): boolean {
  return OFFERED_PRODUCT_CODES.includes(code);
}

async function ensureProduct(code: string, name: string, description: string): Promise<number> {
  const [existing] = await db.select().from(products).where(eq(products.code, code));
  if (existing) return existing.id;
  const [created] = await db.insert(products).values({ code, name, description, status: "Active" }).returning();
  return created.id;
}

async function ensurePrice(productId: number, amountCents: number, billingInterval: string): Promise<void> {
  const [existing] = await db
    .select()
    .from(prices)
    .where(and(eq(prices.productId, productId), eq(prices.billingInterval, billingInterval), eq(prices.status, "Active")));
  if (existing) {
    if (existing.amountCents !== amountCents) {
      logger.warn("catalogue_seed_price_differs", { productId, billingInterval, activeAmountCents: existing.amountCents, seedAmountCents: amountCents });
    }
    return;
  }
  await db.insert(prices).values({
    productId,
    amountCents,
    billingInterval,
    currency: "AUD",
    status: "Active",
  });
}

async function ensureEntitlementDefinition(key: string, description: string): Promise<number> {
  const [existing] = await db.select().from(entitlementDefinitions).where(eq(entitlementDefinitions.key, key));
  if (existing) {
    // Descriptions are operator-facing: a key whose capability has since shipped
    // (grow.calling.transcription) must not keep describing itself as reserved on
    // an already-seeded database. Only the description is refreshed here.
    if (existing.description !== description) {
      await db.update(entitlementDefinitions).set({ description }).where(eq(entitlementDefinitions.id, existing.id));
    }
    return existing.id;
  }
  const [created] = await db.insert(entitlementDefinitions).values({ key, name: key, description }).returning();
  return created.id;
}

async function ensureProductEntitlement(productId: number, entitlementDefinitionId: number): Promise<void> {
  const [existing] = await db
    .select()
    .from(productEntitlements)
    .where(and(eq(productEntitlements.productId, productId), eq(productEntitlements.entitlementDefinitionId, entitlementDefinitionId)));
  if (existing) return;
  await db.insert(productEntitlements).values({ productId, entitlementDefinitionId, enabled: true });
}

export async function ensureCatalogueSeeded(): Promise<void> {
  const growProductId = await ensureProduct(GROW_PRODUCT_CODE, "Grow", "Relationship, prospecting and opportunity management add-on.");
  const starterProductId = await ensureProduct(STARTER_PRODUCT_CODE, "Starter", "Core Agent Engine RUN platform.");
  const bundleProductId = await ensureProduct(BUNDLE_PRODUCT_CODE, "Pro + Grow Bundle", "Agent Engine Pro (RUN) with Grow included.");

  await ensurePrice(growProductId, CATALOGUE_PRICES_CENTS[GROW_PRODUCT_CODE]!, "month");
  await ensurePrice(starterProductId, CATALOGUE_PRICES_CENTS[STARTER_PRODUCT_CODE]!, "month");
  await ensurePrice(bundleProductId, CATALOGUE_PRICES_CENTS[BUNDLE_PRODUCT_CODE]!, "month");

  const entitlementDefIds: Record<string, number> = {};
  for (const key of ENTITLEMENT_KEYS) {
    entitlementDefIds[key] = await ensureEntitlementDefinition(key, ENTITLEMENT_DEFS[key]);
  }

  // Grow: only the 13 grow.* keys - never run.access. Purchasing Grow standalone must never
  // grant RUN/Pit Crew/Financial access (AE GROW Priority 0.5 Stop Condition 7 territory).
  for (const key of GROW_ENTITLEMENT_KEYS) {
    await ensureProductEntitlement(growProductId, entitlementDefIds[key]);
  }
  // Starter (RUN): run.access AND every grow.* key. Owner decision (t220u, 2026-10-31): Run includes
  // every Grow feature (AI and calling included, still subject to the usage limits in lib/ai/usageLimits.ts
  // and any provider charges). Granted through the subscription model like every other product:
  // applySubscriptionSnapshot grants these while the subscription is Trialing/Active and revokes them on
  // Cancelled/Ended. Starter subscriptions synced before this change are topped up by the additive
  // backfill in lib/billing/runIncludesGrowBackfill.ts (scripts/backfillRunIncludesGrow.ts, dry-run first).
  // The separate migration run.access grant (lib/billing/runAccessBackfill.ts) is NOT a subscription and
  // still grants no Grow: unsubscribed brokerages get no paid Grow access.
  for (const key of ENTITLEMENT_KEYS) {
    await ensureProductEntitlement(starterProductId, entitlementDefIds[key]);
  }
  // Bundle: the full union - every grow.* key AND run.access, matching "Pro + Grow".
  for (const key of ENTITLEMENT_KEYS) {
    await ensureProductEntitlement(bundleProductId, entitlementDefIds[key]);
  }
}

export { GROW_PRODUCT_CODE, STARTER_PRODUCT_CODE, BUNDLE_PRODUCT_CODE };
