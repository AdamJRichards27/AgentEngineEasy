// Own-property scope shared by Command Centre, Exceptions, Home, and the
// property list. Extracted from routes/exceptions.ts's restrictedPropertyIdsFor
// so those surfaces use one rule.
//
// Brokerage Administrator and Pit Crew (BROKERAGE_ADMIN_ROLES / PIT_CREW_ROLES)
// see the whole brokerage: the function returns null. Every other role,
// including Agent, is limited to properties.agent_id = the caller, inside
// the caller's brokerage. An empty array means the caller owns none.

import { and, eq } from "drizzle-orm";
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
