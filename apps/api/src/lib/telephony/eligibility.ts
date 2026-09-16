import {
  evaluateAndRecordConsentDecision,
  evaluateAndRecordConsentDecisionInTransaction,
  type ConsentTransaction,
  type EvaluateAndRecordConsentDecisionInput,
  type RecordedConsentDecision,
} from "../consentControlsPersistence.js";
import type { GrowConsentDecisionStatus } from "@aee/db";

/**
 * Outbound phone calls use one canonical purpose/scope pair.  Keeping these
 * values here (rather than accepting them from a route body) prevents a
 * caller from selecting a less restrictive consent stream.
 */
export const PHONE_CALL_CONSENT_PURPOSE = "PHONE_CALL";
export const PHONE_CALL_CONSENT_SCOPE = "OUTBOUND";
export const PHONE_CALL_CHANNEL = "PHONE_CALL" as const;

// Friendly aliases for callers that use the shorter names in policy fixtures.
export const PHONE_CALL_PURPOSE = PHONE_CALL_CONSENT_PURPOSE;
export const PHONE_CALL_SCOPE = PHONE_CALL_CONSENT_SCOPE;
export const GROW_PHONE_CALL_PURPOSE = PHONE_CALL_CONSENT_PURPOSE;
export const GROW_PHONE_CALL_SCOPE = PHONE_CALL_CONSENT_SCOPE;

export class CallConsentEligibilityError extends Error {
  readonly decisionId: number | null;
  readonly decision: GrowConsentDecisionStatus | null;
  readonly reasonCode: string;

  constructor(
    message: string,
    details: {
      decisionId?: number | null;
      decision?: GrowConsentDecisionStatus | null;
      reasonCode?: string;
    } = {},
  ) {
    super(message);
    this.name = "CallConsentEligibilityError";
    this.decisionId = details.decisionId ?? null;
    this.decision = details.decision ?? null;
    this.reasonCode = details.reasonCode ?? "CONSENT_DECISION_FAILED";
  }
}

/**
 * The outbound call boundary.  This is deliberately the only call-facing
 * wrapper around the audited persistence authority.  The pure evaluator in
 * consentControls.ts remains an internal reusable mechanism, not a second
 * outbound entry point.
 */
export async function evaluateOutboundCallEligibility(input: {
  brokerageId: number;
  partyId: number;
  decidedByUserId: number;
  jurisdiction?: "AU" | "NZ" | null;
}): Promise<RecordedConsentDecision> {
  let recorded: RecordedConsentDecision;
  try {
    recorded = await evaluateAndRecordConsentDecision(outboundDecisionInput(input));
  } catch (err) {
    // No party, unavailable evidence, and persistence failures all fail
    // closed.  In particular, do not manufacture a decision or grant a call
    // when the authoritative evidence could not be read or recorded.
    throw new CallConsentEligibilityError(
      err instanceof Error ? err.message : "Outbound call consent could not be evaluated.",
      { reasonCode: "CONSENT_EVIDENCE_UNAVAILABLE" },
    );
  }

  if (recorded.evaluation.decision !== "ELIGIBLE") {
    throw new CallConsentEligibilityError(
      `Outbound call consent is ${recorded.evaluation.decision.toLowerCase()}: ${recorded.evaluation.reasonCode}.`,
      {
        decisionId: recorded.decision.id,
        decision: recorded.evaluation.decision,
        reasonCode: recorded.evaluation.reasonCode,
      },
    );
  }
  return recorded;
}

function outboundDecisionInput(input: {
  brokerageId: number;
  partyId: number;
  decidedByUserId: number;
  jurisdiction?: "AU" | "NZ" | null;
}): EvaluateAndRecordConsentDecisionInput {
  return {
    brokerageId: input.brokerageId,
    partyId: input.partyId,
    channel: PHONE_CALL_CHANNEL,
    purpose: PHONE_CALL_CONSENT_PURPOSE,
    scope: PHONE_CALL_CONSENT_SCOPE,
    jurisdiction: input.jurisdiction ?? null,
    decidedByUserId: input.decidedByUserId,
  };
}

/**
 * Evaluates against a transaction that already owns the brokerage advisory
 * lock.  Unlike the transport-facing wrapper, this returns BLOCKED decisions
 * to the caller so the caller can commit the authoritative denial evidence
 * before mapping it to a controlled request error.
 */
export async function evaluateOutboundCallEligibilityInTransaction(
  tx: ConsentTransaction,
  input: {
    brokerageId: number;
    partyId: number;
    decidedByUserId: number;
    jurisdiction?: "AU" | "NZ" | null;
  },
): Promise<RecordedConsentDecision> {
  return evaluateAndRecordConsentDecisionInTransaction(tx, outboundDecisionInput(input));
}

