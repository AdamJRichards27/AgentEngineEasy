import { db, products, prices, entitlementDefinitions, productEntitlements } from "@aee/db";
import { eq, and } from "drizzle-orm";
import { ENTITLEMENT_KEYS } from "@aee/db";

/**
 * Idempotent product/price/entitlement catalogue bootstrap. Safe to call on every boot -
 * everything here is check-then-insert, never a blind insert, so restarts never duplicate rows.
 *
 * Pricing is DATA, not logic: the amounts below are the current marketing prices (Grow $99/mo,
 * Starter $69/mo, Pro+Grow bundle $289/mo) captured as seeded catalogue rows. Nothing in the
 * entitlement resolver reads these numbers - it only reads entitlementGrants. Change a price by
 * editing this seed (or, later, an admin UI over the `prices` table), never by editing
 * permission logic.
 */

const ENTITLEMENT_DEFS: Record<(typeof ENTITLEMENT_KEYS)[number], string> = {
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
};

const GROW_PRODUCT_CODE = "grow";
const STARTER_PRODUCT_CODE = "agent_engine_starter";
const BUNDLE_PRODUCT_CODE = "agent_engine_pro_grow_bundle";

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
  if (existing) return;
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
  if (existing) return existing.id;
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
  const bundleProductId = await ensureProduct(BUNDLE_PRODUCT_CODE, "Pro + Grow Bundle", "Agent Engine Pro with Grow included.");

  await ensurePrice(growProductId, 9900, "month");
  await ensurePrice(starterProductId, 6900, "month");
  await ensurePrice(bundleProductId, 28900, "month");

  const entitlementDefIds: Record<string, number> = {};
  for (const key of ENTITLEMENT_KEYS) {
    entitlementDefIds[key] = await ensureEntitlementDefinition(key, ENTITLEMENT_DEFS[key]);
  }

  for (const key of ENTITLEMENT_KEYS) {
    await ensureProductEntitlement(growProductId, entitlementDefIds[key]);
    await ensureProductEntitlement(bundleProductId, entitlementDefIds[key]);
  }
}

export { GROW_PRODUCT_CODE, STARTER_PRODUCT_CODE, BUNDLE_PRODUCT_CODE };
