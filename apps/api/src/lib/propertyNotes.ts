// Small, genuinely reusable domain function -- not AI-specific. A future
// manual "add a note" UI feature would call exactly this, same as the AI
// Action Execution Gateway does for the PROPERTY_NOTE_ADD action (Build
// Instructions Part 6: the gateway must call an existing/ordinary domain
// service, never write to the database itself).
import { db, properties } from "@aee/db";
import { eq } from "drizzle-orm";
import { logAudit } from "./audit.js";

export interface AddPropertyNoteInput {
  propertyId: number;
  brokerageId: number;
  userId: number;
  userEmail: string;
  note: string;
  actorType?: "USER" | "AI" | "PIT_CREW" | "ADMIN" | "SYSTEM";
}

export async function addPropertyNote(input: AddPropertyNoteInput): Promise<{ propertyId: number }> {
  const [property] = await db.select().from(properties).where(eq(properties.id, input.propertyId));
  if (!property || property.brokerageId !== input.brokerageId) {
    throw new Error("Property not found in this brokerage.");
  }
  await logAudit({
    userId: input.userId,
    userEmail: input.userEmail,
    action: input.actorType === "AI" ? "AI_NOTE_ADDED" : "NOTE_ADDED",
    recordType: "property",
    recordId: String(input.propertyId),
    propertyId: input.propertyId,
    updatedValue: input.note,
  });
  return { propertyId: input.propertyId };
}
