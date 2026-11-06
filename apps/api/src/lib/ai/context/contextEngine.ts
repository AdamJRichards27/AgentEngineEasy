import { eq } from "drizzle-orm";
import { db, properties, brokerages, users, type UserRole } from "@aee/db";
import { getDashboardOverview } from "../../homeSummary.js";
import { getTransactionByProperty } from "../../transactions.js";
import { propertyHiddenFromCaller, restrictedPropertyIdsFor } from "../../propertyVisibility.js";
import { resolveBrokerageTier } from "../entitlements.js";
import { buildGrowContext } from "./growContext.js";
import { buildPitCrewContext } from "./pitCrewContext.js";
import { buildBusinessCoachContext } from "./businessCoachContext.js";
import type { CoachingPeriodKey } from "../coaching/period.js";
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
  // AE GROW Priority 6 Stage C — additive. mode/period* are only meaningful
  // when contextType is "grow" and mode is "coach"; ignored otherwise, same
  // as growFocusItemId is already ignored outside contextType "grow".
  mode?: "ask" | "coach";
  period?: CoachingPeriodKey;
  periodStartDate?: string | null;
  periodEndDate?: string | null;
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
//
// Owner t171u: when the caller is supplied, the existing own-property rule
// (lib/propertyVisibility) applies too, exactly as GET /properties/:id,
// /:id/workspace and /:id/timeline already apply it: an Agent who is not the
// property's listing agent gets null (Brokerage Administrator and Pit Crew
// see the whole brokerage). Without this, Copilot handed a colleague's
// listing (address, stage, timeline, AML status, offers) to an Agent the
// Property pages already 404. Grow's own context is unaffected: it was
// already own-property scoped through restrictedPropertyIdsFor below.
export interface PropertyContextCaller {
  id: number;
  role: string;
  brokerageId: number;
}

export async function buildPropertyContext(
  brokerageId: number,
  propertyId: number,
  caller?: PropertyContextCaller,
): Promise<PropertyContext | null> {
  const [row] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (row === undefined || row.brokerageId !== brokerageId) {
    return null;
  }
  if (caller !== undefined) {
    if (caller.brokerageId !== brokerageId) return null;
    if (await propertyHiddenFromCaller({ id: caller.id, role: caller.role as UserRole, brokerageId }, row.id)) return null;
  }
  return { id: row.id, address: row.formattedAddress, workflowStage: row.workflowStage };
}

// Price-free by construction: id, propertyId and status only. The
// transaction's purchase price never enters the AI context package
// (pinned by tools/__tests__/offerPriceAccess.test.ts).
async function buildTransactionContext(
  brokerageId: number,
  propertyId: number,
  caller?: PropertyContextCaller,
): Promise<TransactionSummary | null> {
  const property = await buildPropertyContext(brokerageId, propertyId, caller);
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
  // AE GROW Priority 6 Stage C: coach is built ONLY when contextType is
  // "grow" AND mode is "coach" - a plain Grow Ask AE request (mode "ask" or
  // omitted) never pays for or exposes the coaching-metrics queries.
  let coach: AiContextPackage["coach"] = null;
  const caller: PropertyContextCaller = { id: input.userId, role: input.userRole, brokerageId: input.brokerageId };
  if (input.contextType === "property" && input.contextId !== null) {
    property = await buildPropertyContext(input.brokerageId, input.contextId, caller);
  } else if (input.contextType === "transaction" && input.contextId !== null) {
    transaction = await buildTransactionContext(input.brokerageId, input.contextId, caller);
  } else if (input.contextType === "grow") {
    const restrictToPropertyIds = await restrictedPropertyIdsFor({
      id: input.userId,
      role: input.userRole as UserRole,
      brokerageId: input.brokerageId,
    });
    grow = await buildGrowContext(input.brokerageId, input.growFocusItemId, restrictToPropertyIds, input.userId);
    if (input.mode === "coach") {
      coach = await buildBusinessCoachContext(input.brokerageId, grow, {
        period: input.period ?? "last7days",
        startDate: input.periodStartDate ?? null,
        endDate: input.periodEndDate ?? null,
        restrictToPropertyIds,
        callerUserId: input.userId,
      });
    }
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
    coach,
  };
}
