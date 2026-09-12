import { eq } from "drizzle-orm";
import { db, properties, brokerages, users } from "@aee/db";
import { getDashboardOverview } from "../../homeSummary.js";
import { getTransactionByProperty } from "../../transactions.js";
import { resolveBrokerageTier } from "../entitlements.js";
import { buildGrowContext } from "./growContext.js";
import { buildPitCrewContext } from "./pitCrewContext.js";
import type {
  AiContextPackage,
  AiRole,
  BrokerageContext,
  BusinessContext,
  PropertyContext,
  TransactionSummary,
  UserContext,
} from "../types.js";

export interface BuildContextInput {
  requestId: string;
  brokerageId: number;
  userId: number;
  userRole: string;
  role: AiRole;
  // "transaction" reuses the property id as contextId - transactions are 1:1
  // with properties in this schema (see lib/transactions.ts getTransactionByProperty).
  //
  // AE GROW Priority 6 Stage B: "grow" is additive. contextId is unused for
  // "grow" (Grow's Ask AE is brokerage-wide, not scoped to one property/
  // transaction) - a specific Grow Today item to explain is instead threaded
  // through growFocusItemId below, since a Grow Today item id is a string
  // (e.g. "opportunity:123"), not the number contextId already commits to.
  contextType: "property" | "transaction" | "business" | "grow" | null;
  contextId: number | null;
  growFocusItemId: string | null;
}

async function buildUserContext(userId: number): Promise<UserContext> {
  const [row] = await db.select().from(users).where(eq(users.id, userId));
  if (row === undefined) {
    throw new Error(`AI context: user ${userId} not found`);
  }
  return { id: row.id, firstName: row.firstName, lastName: row.lastName, role: row.role };
}

async function buildBrokerageContext(brokerageId: number): Promise<BrokerageContext> {
  const [row] = await db.select().from(brokerages).where(eq(brokerages.id, brokerageId));
  if (row === undefined) {
    throw new Error(`AI context: brokerage ${brokerageId} not found`);
  }
  return { id: row.id, name: row.name, tier: await resolveBrokerageTier(brokerageId) };
}

async function buildBusinessContext(brokerageId: number): Promise<BusinessContext> {
  const overview = await getDashboardOverview(brokerageId);
  return {
    activePropertyCount: overview.activeProperties.length,
    upcomingSettlementCount: overview.upcomingSettlements.length,
  };
}

// Tenant isolation: a property is only returned if it belongs to the caller's
// own brokerage - the same brokerageId scoping every route in this app uses. A
// property id from another brokerage resolves to null, not an error, so a
// response never confirms or denies that a foreign id exists.
export async function buildPropertyContext(brokerageId: number, propertyId: number): Promise<PropertyContext | null> {
  const [row] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (row === undefined || row.brokerageId !== brokerageId) {
    return null;
  }
  return { id: row.id, address: row.formattedAddress, workflowStage: row.workflowStage };
}

async function buildTransactionContext(brokerageId: number, propertyId: number): Promise<TransactionSummary | null> {
  const property = await buildPropertyContext(brokerageId, propertyId);
  if (property === null) {
    return null;
  }
  const transaction = await getTransactionByProperty(propertyId);
  if (transaction === null) {
    return null;
  }
  return { id: transaction.id, propertyId: transaction.propertyId, status: transaction.status };
}

// Context Engine: assembles the single AiContextPackage every prompt and tool
// sees. Every sub-builder re-checks brokerageId itself rather than trusting the
// caller, so a bug in one context type can never leak another brokerage's data
// through another (Build Instructions "Context Engine" + "Security").
export async function buildContext(input: BuildContextInput): Promise<AiContextPackage> {
  const [user, brokerage, business, pitCrew] = await Promise.all([
    buildUserContext(input.userId),
    buildBrokerageContext(input.brokerageId),
    buildBusinessContext(input.brokerageId),
    buildPitCrewContext(input.brokerageId),
  ]);

  let property: PropertyContext | null = null;
  let transaction: TransactionSummary | null = null;
  // AE GROW Priority 6 Stage B: grow is built ONLY for contextType "grow" -
  // never unconditionally like the old placeholder was. This mirrors the
  // property/transaction branches below rather than the previous
  // always-build-and-discard pattern, so a non-Grow ask never pays for or
  // exposes a Grow query at all.
  let grow: AiContextPackage["grow"] = null;
  if (input.contextType === "property" && input.contextId !== null) {
    property = await buildPropertyContext(input.brokerageId, input.contextId);
  } else if (input.contextType === "transaction" && input.contextId !== null) {
    transaction = await buildTransactionContext(input.brokerageId, input.contextId);
  } else if (input.contextType === "grow") {
    grow = await buildGrowContext(input.brokerageId, input.growFocusItemId);
  }

  return {
    requestId: input.requestId,
    brokerageId: input.brokerageId,
    userId: input.userId,
    userRole: input.userRole,
    tier: brokerage.tier,
    role: input.role,
    contextType: input.contextType,
    contextId: input.contextId,
    user,
    brokerage,
    business,
    property,
    transaction,
    grow,
    pitCrew,
  };
}
