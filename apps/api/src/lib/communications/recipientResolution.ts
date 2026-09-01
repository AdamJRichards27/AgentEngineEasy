// Agent Engine 2.0 — Communications Hub (Priority 8).
//
// Recipient resolution from existing parties (Section 11). The primary
// path reuses packages/db/src/schema/property.ts's parties/propertyParties
// model outright — a seller or buyer entered once against a property is
// never re-entered here. Manual entry (a supplier, a non-party contact) is
// the explicit fallback the spec requires, never the default: it demands a
// name, role, destination, and a reason, and is fully audited.

import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  properties,
  propertyParties,
  parties,
  communicationParticipants,
  communicationThreads,
  type Party,
  type PropertyPartyLink,
  type CommunicationParticipant,
} from "@aee/db";
import { logAudit } from "../audit.js";
import { CommunicationTenancyError } from "./types.js";

export interface CandidateRecipient {
  partyId: number;
  role: string;
  isPrimary: boolean;
  displayName: string;
  email: string | null;
  mobile: string | null;
  // Section 11: surfaced so the composer can warn the user rather than
  // silently picking one — two links to the same party (e.g. Seller and
  // also Solicitor via a second role) are not an error, just worth flagging.
  isDuplicateContact: boolean;
}

export function partyDisplayName(party: Pick<Party, "partyType" | "firstName" | "lastName" | "organisationName">): string {
  if (party.partyType !== "Person" && party.organisationName) return party.organisationName;
  const name = [party.firstName, party.lastName].filter(Boolean).join(" ").trim();
  return name || party.organisationName || "Unnamed party";
}

/** Every party linked to a property, shaped as communication recipient candidates — the reuse target Section 11 requires. */
export async function listRecipientCandidatesForProperty(propertyId: number, brokerageId: number): Promise<CandidateRecipient[]> {
  const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (!property || property.brokerageId !== brokerageId) throw new CommunicationTenancyError();

  const links: PropertyPartyLink[] = await db.select().from(propertyParties).where(eq(propertyParties.propertyId, propertyId));
  if (links.length === 0) return [];

  const partyIds = [...new Set(links.map((l) => l.partyId))];
  const partyRows = await db.select().from(parties).where(and(eq(parties.brokerageId, brokerageId), inArray(parties.id, partyIds)));
  const byId = new Map(partyRows.map((p) => [p.id, p]));

  const seenDestination = new Set<string>();
  const candidates: CandidateRecipient[] = [];
  for (const link of links) {
    const party = byId.get(link.partyId);
    if (!party) continue;
    const destinationKey = (party.email ?? "") + "|" + (party.mobile ?? "");
    const isDuplicateContact = destinationKey !== "|" && seenDestination.has(destinationKey);
    seenDestination.add(destinationKey);
    candidates.push({
      partyId: party.id,
      role: link.role,
      isPrimary: link.isPrimary,
      displayName: partyDisplayName(party),
      email: party.email ?? null,
      mobile: party.mobile ?? null,
      isDuplicateContact,
    });
  }
  return candidates;
}

export interface AddParticipantFromPartyInput {
  threadId: number;
  brokerageId: number;
  partyId: number;
  role: string;
  addedByUserId: number;
}

export async function addParticipantFromParty(input: AddParticipantFromPartyInput): Promise<CommunicationParticipant> {
  const [thread] = await db.select().from(communicationThreads).where(eq(communicationThreads.id, input.threadId));
  if (!thread || thread.brokerageId !== input.brokerageId) throw new CommunicationTenancyError();

  const [party] = await db.select().from(parties).where(eq(parties.id, input.partyId));
  if (!party || party.brokerageId !== input.brokerageId) throw new CommunicationTenancyError();

  const [row] = await db
    .insert(communicationParticipants)
    .values({
      threadId: input.threadId,
      partyId: party.id,
      role: input.role,
      displayName: partyDisplayName(party),
      email: party.email ?? null,
      mobile: party.mobile ?? null,
      isManualEntry: false,
      addedByUserId: input.addedByUserId,
    })
    .returning();

  await logAudit({
    userId: input.addedByUserId,
    action: "communication_participant_added",
    recordType: "communication_thread",
    recordId: String(input.threadId),
    propertyId: thread.propertyId,
    updatedValue: `${row.displayName} (${row.role})`,
  });

  return row;
}

export interface AddManualParticipantInput {
  threadId: number;
  brokerageId: number;
  displayName: string;
  role: string;
  email?: string | null;
  mobile?: string | null;
  reason: string;
  addedByUserId: number;
}

/**
 * Section 11's explicit manual-entry fallback: permission is implicit in
 * the caller already having write access to the thread (enforced at the
 * route layer), but name, role, destination, and reason are all mandatory
 * here, and the addition is fully audited — never a silent free-text send.
 */
export async function addManualParticipant(input: AddManualParticipantInput): Promise<CommunicationParticipant> {
  if (!input.reason.trim()) {
    throw new Error("A reason is required when adding a recipient manually (not linked to an existing party).");
  }
  if (!input.email && !input.mobile) {
    throw new Error("A manually-added recipient needs at least an email or a mobile number.");
  }

  const [thread] = await db.select().from(communicationThreads).where(eq(communicationThreads.id, input.threadId));
  if (!thread || thread.brokerageId !== input.brokerageId) throw new CommunicationTenancyError();

  const [row] = await db
    .insert(communicationParticipants)
    .values({
      threadId: input.threadId,
      partyId: null,
      role: input.role,
      displayName: input.displayName,
      email: input.email ?? null,
      mobile: input.mobile ?? null,
      isManualEntry: true,
      manualEntryReason: input.reason,
      addedByUserId: input.addedByUserId,
    })
    .returning();

  await logAudit({
    userId: input.addedByUserId,
    action: "communication_participant_added_manually",
    recordType: "communication_thread",
    recordId: String(input.threadId),
    propertyId: thread.propertyId,
    updatedValue: `${row.displayName} (${row.role}) — ${input.reason}`,
  });

  return row;
}
