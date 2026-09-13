// AE GROW Priority 6 Stage D — AI-Proposed, Human-Approved Follow-Up
// Actions.
//
// Ordinary domain function backing the CREATE_GROW_COMMITMENT AI action
// (apps/api/src/lib/ai/actions/registry.ts). Follows this codebase's
// existing convention (propertyNotes.ts, workflowProposals.ts,
// automation/tasks.ts): the registry's execute() calls a plain,
// non-AI-specific function; nothing AI-related lives in this file, and it
// never touches the AI action-request tables itself.
//
// This function is reached only through the AI Action Execution Gateway
// (lib/ai/executionGateway.ts) — never directly from a route — so by the
// time it runs, the Policy Engine has already re-confirmed entitlement,
// role, and tamper-freedom for this exact request. It still independently
// re-validates every referenced record's brokerage ownership itself, for
// the same reason routes/contacts.ts's manual commitment endpoint does:
// an id that was legitimate when the AI proposed this (sourced from
// already-tenant-scoped Grow Today data — see orchestrator.ts) is not
// automatically still legitimate by execution time, since an approval can
// sit in the queue for up to 24 hours (actionRequests.ts's
// DEFAULT_EXPIRY_MS) — long enough for a record to be reassigned, and
// this function must never trust that nothing changed in the meantime.
//
// Deliberately does NOT modify routes/contacts.ts's existing manual
// handler — this is a second, additive caller of the same growCommitments
// table and the same validation shape, not a refactor of the existing
// route.

import { and, eq } from "drizzle-orm";
import { db, growCommitments, growOpportunities, parties, properties, type GrowCommitment } from "@aee/db";

export class GrowCommitmentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrowCommitmentValidationError";
  }
}

export interface CreateApprovedGrowCommitmentInput {
  brokerageId: number;
  createdBy: number;
  partyId: number;
  description: string;
  // ISO-8601 string — already passed the action's zod schema
  // (isValidIsoDate) before this runs, but re-parsed and re-checked here
  // too rather than trusted, since this function has no other caller to
  // guarantee that.
  dueAt: string;
  propertyId?: number | null;
  opportunityId?: number | null;
}

// Re-resolves and re-validates every referenced record against the
// ACTING request's own brokerageId — never assumes an id is legitimate
// just because it already passed zod's shape check. This is the
// "re-resolve all referenced records server-side ... confirm brokerage
// ownership of every record" requirement from the Stage D specification.
export async function createApprovedGrowCommitment(input: CreateApprovedGrowCommitmentInput): Promise<GrowCommitment> {
  const dueAt = new Date(input.dueAt);
  if (Number.isNaN(dueAt.getTime())) {
    throw new GrowCommitmentValidationError("dueAt must be a valid date.");
  }

  const description = input.description.trim();
  if (description.length === 0) {
    throw new GrowCommitmentValidationError("description must not be empty.");
  }

  const [party] = await db
    .select()
    .from(parties)
    .where(and(eq(parties.id, input.partyId), eq(parties.brokerageId, input.brokerageId)))
    .limit(1);
  if (!party) {
    throw new GrowCommitmentValidationError("Contact not found in this brokerage.");
  }

  let propertyId: number | null = null;
  if (input.propertyId !== null && input.propertyId !== undefined) {
    const [property] = await db
      .select()
      .from(properties)
      .where(and(eq(properties.id, input.propertyId), eq(properties.brokerageId, input.brokerageId)))
      .limit(1);
    if (!property) {
      throw new GrowCommitmentValidationError("Property not found in this brokerage.");
    }
    propertyId = property.id;
  }

  let opportunityId: number | null = null;
  if (input.opportunityId !== null && input.opportunityId !== undefined) {
    const [opportunity] = await db
      .select()
      .from(growOpportunities)
      .where(and(eq(growOpportunities.id, input.opportunityId), eq(growOpportunities.brokerageId, input.brokerageId)))
      .limit(1);
    if (!opportunity) {
      throw new GrowCommitmentValidationError("Opportunity not found in this brokerage.");
    }
    // Logical-relatedness check (Stage D specification: "confirm ...
    // opportunity references accessible and logically related"): an
    // opportunity belonging to a different contact in the SAME brokerage
    // would still pass the brokerage-ownership check above, so it is
    // checked separately here. growOpportunities.partyId is a required
    // column (packages/db/src/schema/grow.ts), so this is always a real
    // comparison, never a null-skip.
    if (opportunity.partyId !== input.partyId) {
      throw new GrowCommitmentValidationError("Opportunity does not belong to this contact.");
    }
    opportunityId = opportunity.id;
  }

  const [inserted] = await db
    .insert(growCommitments)
    .values({
      brokerageId: input.brokerageId,
      partyId: input.partyId,
      propertyId,
      opportunityId,
      description,
      dueAt,
      status: "Open",
      createdBy: input.createdBy,
    })
    .returning();

  return inserted;
}
