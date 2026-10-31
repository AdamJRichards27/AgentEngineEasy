// Owner t223u (31 Oct 2026) — proposal acceptance.
// * Acceptance is recorded against a WON proposal (Grow appraisal) by the owner or an authorised
//   representative, with evidence and the time it was accepted (timezone-aware). It is append-only.
// * Acceptance NEVER creates an agency agreement, a document package or Pit Crew work.
// * Pit Crew activation (the launch plan auto-proposed from a fully signed agency agreement) needs
//   BOTH an ACTIVE acceptance on a WON proposal for the property AND a fully signed agreement
//   (AGENCY_AGREEMENT_SIGNED). Whichever arrives second triggers activation; neither alone does.
import { and, eq } from "drizzle-orm";
import {
  db, appraisals, proposalAcceptances, propertyParties, domainEvents,
  PROPOSAL_ACCEPTOR_CAPACITIES, PROPOSAL_ACCEPTANCE_EVIDENCE_TYPES, type ProposalAcceptance,
} from "@aee/db";
import { logger } from "@aee/events";
import { logAudit } from "./audit.js";
import { assertAppraisalInBrokerage } from "./growAppraisals.js";
import { getOrCreateLaunchPlan } from "./launch/model.js";

export class ProposalAcceptanceError extends Error {
  constructor(message: string, readonly code: string, readonly status = 409) { super(message); }
}

export interface RecordAcceptanceInput {
  appraisalId: number;
  brokerageId: number;
  userId: number;
  acceptorCapacity: (typeof PROPOSAL_ACCEPTOR_CAPACITIES)[number];
  acceptorPartyId?: number | null;
  acceptorName: string;
  authorityBasis?: string | null;
  evidenceType: (typeof PROPOSAL_ACCEPTANCE_EVIDENCE_TYPES)[number];
  evidenceReference: string;
  evidenceDocumentId?: number | null;
  acceptedAt: Date;
}

const OWNER_PARTY_ROLES = new Set(["Seller", "Owner", "Vendor", "Landlord"]);

export async function recordProposalAcceptance(input: RecordAcceptanceInput): Promise<{ acceptance: ProposalAcceptance; activation: "LAUNCH_PLAN_PROPOSED" | "AWAITING_SIGNED_AGREEMENT" }> {
  const appraisal = await assertAppraisalInBrokerage(input.appraisalId, input.brokerageId);
  if (appraisal.outcome !== "WON") {
    throw new ProposalAcceptanceError("Record the proposal outcome as WON before recording the owner's acceptance.", "PROPOSAL_NOT_WON");
  }
  if (input.acceptedAt.getTime() > Date.now() + 5 * 60_000) {
    throw new ProposalAcceptanceError("Acceptance time cannot be in the future.", "ACCEPTED_AT_IN_FUTURE", 400);
  }
  if (input.acceptorCapacity === "AUTHORISED_REPRESENTATIVE" && !input.authorityBasis?.trim()) {
    throw new ProposalAcceptanceError("An authorised representative needs the basis of their authority (e.g. power of attorney, company director).", "AUTHORITY_BASIS_REQUIRED", 400);
  }
  if (input.acceptorCapacity === "OWNER") {
    if (input.acceptorPartyId == null) {
      throw new ProposalAcceptanceError("Owner acceptance must identify the owner party on the property.", "OWNER_PARTY_REQUIRED", 400);
    }
    const [link] = await db.select({ role: propertyParties.role }).from(propertyParties)
      .where(and(eq(propertyParties.propertyId, appraisal.propertyId), eq(propertyParties.partyId, input.acceptorPartyId)));
    if (!link || !OWNER_PARTY_ROLES.has(link.role)) {
      throw new ProposalAcceptanceError("The acceptor is not recorded as an owner of this property.", "ACCEPTOR_NOT_OWNER", 400);
    }
  } else if (input.acceptorPartyId != null) {
    const [link] = await db.select({ id: propertyParties.id }).from(propertyParties)
      .where(and(eq(propertyParties.propertyId, appraisal.propertyId), eq(propertyParties.partyId, input.acceptorPartyId)));
    if (!link) throw new ProposalAcceptanceError("The representative party is not linked to this property.", "ACCEPTOR_NOT_ON_PROPERTY", 400);
  }

  let acceptance: ProposalAcceptance;
  try {
    [acceptance] = (await db.insert(proposalAcceptances).values({
      brokerageId: input.brokerageId, appraisalId: appraisal.id, propertyId: appraisal.propertyId,
      acceptorCapacity: input.acceptorCapacity, acceptorPartyId: input.acceptorPartyId ?? null, acceptorName: input.acceptorName.trim(),
      authorityBasis: input.authorityBasis?.trim() || null, evidenceType: input.evidenceType, evidenceReference: input.evidenceReference.trim(),
      evidenceDocumentId: input.evidenceDocumentId ?? null, acceptedAt: input.acceptedAt, recordedByUserId: input.userId,
    }).returning()) as [ProposalAcceptance];
  } catch (err) {
    if ((err as { code?: string; cause?: { code?: string } }).code === "23505" || (err as { cause?: { code?: string } }).cause?.code === "23505") {
      throw new ProposalAcceptanceError("This proposal already has a recorded acceptance.", "ACCEPTANCE_ALREADY_RECORDED");
    }
    throw err;
  }
  await logAudit({ userId: input.userId, action: "proposal_acceptance_recorded", recordType: "appraisal", recordId: String(appraisal.id), propertyId: appraisal.propertyId });

  // Activation if the agreement was already fully signed (acceptance arrived second).
  const activation = (await agencyAgreementFullySigned(appraisal.propertyId, input.brokerageId))
    ? (await getOrCreateLaunchPlan(appraisal.propertyId, input.brokerageId, null), "LAUNCH_PLAN_PROPOSED" as const)
    : ("AWAITING_SIGNED_AGREEMENT" as const);
  return { acceptance, activation };
}

export async function getActiveProposalAcceptance(appraisalId: number, brokerageId: number): Promise<ProposalAcceptance | null> {
  await assertAppraisalInBrokerage(appraisalId, brokerageId);
  const [row] = await db.select().from(proposalAcceptances)
    .where(and(eq(proposalAcceptances.appraisalId, appraisalId), eq(proposalAcceptances.brokerageId, brokerageId), eq(proposalAcceptances.status, "ACTIVE")));
  return row ?? null;
}

/** ACTIVE acceptance on a proposal that is still WON, for this property in this brokerage. */
export async function hasAcceptedProposal(propertyId: number, brokerageId: number): Promise<boolean> {
  const [row] = await db.select({ id: proposalAcceptances.id }).from(proposalAcceptances)
    .innerJoin(appraisals, eq(appraisals.id, proposalAcceptances.appraisalId))
    .where(and(
      eq(proposalAcceptances.propertyId, propertyId), eq(proposalAcceptances.brokerageId, brokerageId), eq(proposalAcceptances.status, "ACTIVE"),
      eq(appraisals.brokerageId, brokerageId), eq(appraisals.propertyId, propertyId), eq(appraisals.outcome, "WON"),
    )).limit(1);
  return !!row;
}

export async function agencyAgreementFullySigned(propertyId: number, brokerageId: number): Promise<boolean> {
  const [row] = await db.select({ id: domainEvents.id }).from(domainEvents)
    .where(and(eq(domainEvents.propertyId, propertyId), eq(domainEvents.brokerageId, brokerageId), eq(domainEvents.eventType, "AGENCY_AGREEMENT_SIGNED"))).limit(1);
  return !!row;
}

/** The Pit Crew activation gate, used by the AGENCY_AGREEMENT_SIGNED handler. */
export async function pitCrewActivationAllowed(propertyId: number, brokerageId: number): Promise<boolean> {
  const ok = await hasAcceptedProposal(propertyId, brokerageId);
  if (!ok) logger.info("pit_crew_activation_awaiting_accepted_proposal", { propertyId, brokerageId });
  return ok;
}
