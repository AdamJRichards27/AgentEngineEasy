// Own-property scope shared by Command Centre, Exceptions, Home, and the
// property list. Extracted from routes/exceptions.ts's restrictedPropertyIdsFor
// so those surfaces use one rule.
//
// Brokerage Administrator and Pit Crew (BROKERAGE_ADMIN_ROLES / PIT_CREW_ROLES)
// see the whole brokerage: the function returns null. Every other role,
// including Agent, is limited to properties.agent_id = the caller, inside
// the caller's brokerage. An empty array means the caller owns none.

import { and, eq, inArray, isNull, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db, properties } from "@aee/db";
import { BROKERAGE_ADMIN_ROLES, PIT_CREW_ROLES, type AuthedUser } from "../middlewares/auth.js";

/** Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7): Pit Crew now
 * gets whole-tenant visibility here too, same as Brokerage Administrator --
 * the pit_crew_assignments overlay table (lib/pitCrew) is the service-
 * assignment record. Agents remain scoped to properties they are the agent for. */
export async function restrictedPropertyIdsFor(user: AuthedUser): Promise<number[] | null> {
  if (BROKERAGE_ADMIN_ROLES.includes(user.role) || PIT_CREW_ROLES.includes(user.role)) return null;
  const rows = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.brokerageId, user.brokerageId), eq(properties.agentId, user.id)));
  return rows.map((r) => r.id);
}

/** Same 404 a cross-tenant property read already returns: the caller is
 * own-property scoped and this property is not one they are the agent for.
 * Brokerage Administrator and Pit Crew are not hidden (`restrictTo` is null). */
export async function propertyHiddenFromCaller(user: AuthedUser, propertyId: number): Promise<boolean> {
  const restrictTo = await restrictedPropertyIdsFor(user);
  return restrictTo !== null && !restrictTo.includes(propertyId);
}

/** A row linked to a property outside the caller's own-property set.
 * `restrictTo === null` is brokerage-wide. A null `propertyId` is not
 * property-linked (a contact-only row) and stays. */
export function linkedPropertyHidden(propertyId: number | null, restrictTo: number[] | null): boolean {
  if (restrictTo === null || propertyId === null) return false;
  return !restrictTo.includes(propertyId);
}

/** SQL for a nullable property id: keep rows with no property, plus rows
 * whose property is in `restrictTo`. `undefined` when the caller is
 * brokerage-wide, so the existing statement is unchanged. An empty set
 * keeps only the null-property rows — `inArray` of `[]` is not valid SQL. */
export function visibleLinkedPropertySql(propertyId: AnyColumn, restrictTo: number[] | null): SQL | undefined {
  if (restrictTo === null) return undefined;
  if (restrictTo.length === 0) return isNull(propertyId);
  return or(isNull(propertyId), inArray(propertyId, restrictTo));
}

/** SQL for a property id that is always set (an appraisal). An empty set
 * matches nothing. `undefined` when the caller is brokerage-wide. */
export function visibleRequiredPropertySql(propertyId: AnyColumn, restrictTo: number[] | null): SQL | undefined {
  if (restrictTo === null) return undefined;
  if (restrictTo.length === 0) return sql`false`;
  return inArray(propertyId, restrictTo);
}
