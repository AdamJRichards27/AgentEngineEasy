import type { GrowCallSession } from "@aee/db";
import type { ConsentTransaction } from "../consentControlsPersistence.js";
import { resolveEntitlements } from "../entitlements/resolver.js";
import {
  evaluateOutboundCallEligibility,
  evaluateOutboundCallEligibilityInTransaction,
  evaluateOutboundCallEligibilityReadOnly,
} from "./eligibility.js";
import { resolveRecordingPermission } from "./consent.js";
import type { TelephonyProviderCapabilities } from "./provider.js";

type OutboundDecision =
  | Awaited<ReturnType<typeof evaluateOutboundCallEligibility>>
  | Awaited<ReturnType<typeof evaluateOutboundCallEligibilityReadOnly>>;
export const LIVE_RECORDING_APPROVAL_ENV = "LIVE_RECORDING_APPROVED" as const;

export interface RecordingGateEvidence {
  evaluatedAt: string;
  requested: boolean;
  allPassed: boolean;
  gates: {
    entitlement: { passed: boolean; entitlementKey: "grow.calling.recording"; reason: string; humanReason: string };
    legalPolicy: {
      passed: boolean;
      jurisdiction: string | null;
      policyVersion: string | null;
      reason: string;
      humanReason: string;
    };
    legacyConsentAndDisclosure: {
      passed: boolean;
      consentId: number | null;
      consentJurisdiction: string | null;
      disclosedInCall: boolean;
      confirmedInCall: boolean;
      reason: string;
      humanReason: string;
    };
    adapterCapability: { passed: boolean; provider: string; reason: string; humanReason: string };
    operationalApproval: { passed: boolean; flag: string; reason: string; humanReason: string };
  };
  outboundDecisionId: number | null;
  outboundReasonCode: string | null;
}

export interface RecordingGateEvaluation {
  permitted: boolean;
  evidence: RecordingGateEvidence;
  outboundDecision: OutboundDecision | null;
}

/**
 * Keep the five-gate conjunction explicit and independently testable.  The
 * caller supplies only gate results here; recordingRequested and outbound
 * call eligibility are deliberately not accepted as a sixth gate.
 */
export function allRecordingGatesPassed(gates: Record<string, { passed: boolean }>): boolean {
  return Object.values(gates).every((gate) => gate.passed);
}

interface RecordingPolicyConfig {
  allowed?: unknown;
  allow?: unknown;
  allowRecording?: unknown;
  legalAllowed?: unknown;
  recordingAllowed?: unknown;
  enabled?: unknown;
  jurisdiction?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * F2 policy configuration is intentionally separate from the general
 * outbound-consent policy.  A call policy being eligible is not a legal
 * recording approval.  The policy row is selected by the authoritative
 * PHONE_CALL decision and only an explicit recordingPolicy object can pass
 * this gate.
 */
function extractRecordingPolicy(policySnapshot: unknown): RecordingPolicyConfig | null {
  const policy = asRecord(policySnapshot);
  const policyData = asRecord(policy?.policyData);
  if (!policyData) return null;
  const configured =
    asRecord(policyData.recordingPolicy) ??
    asRecord(policyData.legalRecordingPolicy) ??
    asRecord(policyData.recording);
  return configured;
}

function legalRecordingPolicyAllows(policySnapshot: unknown, jurisdiction: string | null): {
  passed: boolean;
  reason: string;
} {
  const policy = asRecord(policySnapshot);
  const config = extractRecordingPolicy(policySnapshot);
  if (!policy || !config) return { passed: false, reason: "RECORDING_POLICY_NOT_CONFIGURED" };
  if (config.jurisdiction !== undefined && config.jurisdiction !== jurisdiction) {
    return { passed: false, reason: "RECORDING_POLICY_JURISDICTION_MISMATCH" };
  }
  const explicitAllow =
    config.allowed === true ||
    config.allow === true ||
    config.allowRecording === true ||
    config.legalAllowed === true ||
    config.recordingAllowed === true ||
    config.enabled === true;
  return explicitAllow
    ? { passed: true, reason: "RECORDING_POLICY_ALLOWED" }
    : { passed: false, reason: "RECORDING_POLICY_NOT_ALLOWED" };
}

function capabilityAllows(capabilities: TelephonyProviderCapabilities | null | undefined): boolean {
  return capabilities?.recording === true;
}

function recordingGateHumanReason(reason: string, providerName?: string): string {
  const labels: Record<string, string> = {
    ENTITLEMENT_ACTIVE: "Recording entitlement is active.",
    ENTITLEMENT_MISSING: "Recording entitlement is not active.",
    RECORDING_POLICY_ALLOWED: "The current recording policy allows this jurisdiction.",
    RECORDING_POLICY_NOT_CONFIGURED: "No recording policy is configured for this jurisdiction.",
    RECORDING_POLICY_JURISDICTION_MISMATCH: "The recording policy does not cover this jurisdiction.",
    RECORDING_POLICY_NOT_ALLOWED: "The current recording policy does not allow recording.",
    LEGACY_RECORDING_CONSENT_INVALID: "No active recording consent covers this call.",
    IN_CALL_DISCLOSURE_REQUIRED: "In-call disclosure is required before recording can be considered.",
    IN_CALL_CONFIRMATION_REQUIRED: "In-call confirmation is required before recording can be considered.",
    LEGACY_CONSENT_AND_DISCLOSURE_CONFIRMED: "Consent and in-call disclosure and confirmation are present.",
    ADAPTER_RECORDING_CAPABLE: "The active telephony adapter can record.",
    ADAPTER_RECORDING_UNAVAILABLE: `The ${providerName ?? "active"} telephony adapter cannot record.`,
    OPERATIONAL_RECORDING_APPROVED: "Operational recording approval is enabled.",
    OPERATIONAL_RECORDING_NOT_APPROVED: "Operational recording approval is not enabled.",
  };
  return labels[reason] ?? reason.replaceAll("_", " ").toLowerCase();
}

/**
 * Evaluate exactly the five F2 recording gates. `recordingRequested` is an
 * input to the operation, not a sixth permission gate. Mutating callers use
 * the canonical audited evaluator at enable time; presentation callers may
 * set readOnly=true, which uses the same current state and pure evaluator
 * without inserting a consent decision. Pre-call presentation deliberately
 * supplies missing disclosure/confirmation as false.
 */
export async function evaluateRecordingGates(input: {
  session: Pick<
    GrowCallSession,
    "brokerageId" | "partyId" | "recordingRequested" | "recordingStatus" | "recordingConsentId" | "destinationCountry"
  >;
  actor: { id: number; role: string; brokerageId: number };
  providerName: string;
  providerCapabilities: TelephonyProviderCapabilities;
  tx?: ConsentTransaction;
  readOnly?: boolean;
}): Promise<RecordingGateEvaluation> {
  const session = input.session;
  const evaluatedAt = new Date().toISOString();
  const requested = session.recordingRequested === true;
  const disclosedInCall = session.recordingStatus === "DISCLOSED" || session.recordingStatus === "CONFIRMED" || session.recordingStatus === "PERMITTED_NOT_CAPTURED";
  const confirmedInCall = session.recordingStatus === "CONFIRMED" || session.recordingStatus === "PERMITTED_NOT_CAPTURED";

  let outboundDecision: OutboundDecision | null = null;
  // AE GROW W3-B (D-4): the recorded decision, retained for EVIDENCE only and
  // regardless of its outcome. Kept separate from `outboundDecision` above on
  // purpose — see the comment at its assignment below.
  let recordedDecisionForEvidence: OutboundDecision | null = null;
  try {
    // Re-evaluate the canonical call decision now, so withdrawal/expiry and
    // policy retirement between creation and recording enable are observed.
    if (input.tx) {
      const recorded = await evaluateOutboundCallEligibilityInTransaction(input.tx, {
        brokerageId: session.brokerageId,
        partyId: session.partyId,
        decidedByUserId: input.actor.id,
        jurisdiction: session.destinationCountry === "AU" || session.destinationCountry === "NZ" ? session.destinationCountry : null,
      });
      // AE GROW W3-B (D-4). `recorded` is a decision this call just WROTE:
      // evaluateOutboundCallEligibilityInTransaction persists a
      // growConsentDecisions row whatever the outcome. Only the ELIGIBLE case
      // used to be kept, so outboundDecisionId/outboundReasonCode at the
      // bottom of this function were persisted as null precisely when the
      // call was blocked — discarding the pointer to the row that records WHY
      // it was blocked, at the one moment that evidence is worth having. The
      // read-only branch immediately below never had that asymmetry (it
      // passes throwIfIneligible: false and keeps whatever it gets), which is
      // what marks this as an oversight rather than a deliberate policy.
      recordedDecisionForEvidence = recorded;

      // The eligibility-conditional assignment stays exactly as it was, and
      // must. `outboundDecision` is not only evidence: it also supplies the
      // policy snapshot, jurisdiction and policyVersion that feed the
      // legalPolicy gate below, and it is this function's return value.
      // Widening it to ineligible decisions would let a blocked call's policy
      // snapshot satisfy the legalPolicy gate — a change to the five-gate
      // conjunction itself, which is both out of scope here and the wrong
      // direction. Retaining the decision for evidence while leaving gate
      // inputs untouched fixes the lost reason code and nothing else.
      if (recorded.evaluation.decision === "ELIGIBLE") outboundDecision = recorded;
    } else if (input.readOnly) {
      outboundDecision = await evaluateOutboundCallEligibilityReadOnly({
        brokerageId: session.brokerageId,
        partyId: session.partyId,
        decidedByUserId: input.actor.id,
        jurisdiction: session.destinationCountry === "AU" || session.destinationCountry === "NZ" ? session.destinationCountry : null,
        throwIfIneligible: false,
      });
      // Already outcome-independent: this branch keeps whatever it resolved.
      recordedDecisionForEvidence = outboundDecision;
    } else {
      outboundDecision = await evaluateOutboundCallEligibility({
        brokerageId: session.brokerageId,
        partyId: session.partyId,
        decidedByUserId: input.actor.id,
        jurisdiction: session.destinationCountry === "AU" || session.destinationCountry === "NZ" ? session.destinationCountry : null,
      });
      // This evaluator THROWS on an ineligible decision, so an ineligible
      // outcome lands in the catch below with no object to retain — a
      // different shape of gap from the transaction branch's, and one that
      // cannot be closed from inside this function. Left as-is deliberately.
      recordedDecisionForEvidence = outboundDecision;
    }
  } catch {
    // The recording operation is fail-closed and must not make the base call
    // fail.  The failed decision itself is already audited by the authority
    // whenever evidence could be resolved.
  }

  const entitlementKeys = await resolveEntitlements(input.actor).catch(() => new Set<string>());
  const entitlementPassed = entitlementKeys.has("grow.calling.recording");

  const decisionEvidence = outboundDecision
    ? "evidence" in outboundDecision
      ? outboundDecision.evidence
      : outboundDecision.decision.evidence
    : undefined;
  const evidenceRecord = asRecord(decisionEvidence);
  const policySnapshot = evidenceRecord?.policySnapshot;
  const sessionJurisdiction = session.destinationCountry === "AU" || session.destinationCountry === "NZ" ? session.destinationCountry : null;
  const jurisdiction = outboundDecision?.evaluation.jurisdiction ?? sessionJurisdiction;
  const policyResult = legalRecordingPolicyAllows(policySnapshot, jurisdiction);

  const legacyConsent = await resolveRecordingPermission({
    brokerageId: session.brokerageId,
    partyId: session.partyId,
    recordingRequested: requested,
    existingRecordingConsentId: session.recordingConsentId,
    expectedJurisdiction: jurisdiction,
    tx: input.tx,
  }).catch(() => ({
    permitted: false,
    recordingStatus: "DENIED" as const,
    recordingConsentId: null,
    recordingConsentJurisdiction: null,
  }));

  const legacyAndDisclosurePassed = legacyConsent.permitted && disclosedInCall && confirmedInCall;
  const capabilityPassed = capabilityAllows(input.providerCapabilities);
  const operationalPassed = process.env[LIVE_RECORDING_APPROVAL_ENV] === "true";

  const evidence: RecordingGateEvidence = {
    evaluatedAt,
    requested,
    allPassed: false,
    gates: {
      entitlement: {
        passed: entitlementPassed,
        entitlementKey: "grow.calling.recording",
        reason: entitlementPassed ? "ENTITLEMENT_ACTIVE" : "ENTITLEMENT_MISSING",
        humanReason: recordingGateHumanReason(entitlementPassed ? "ENTITLEMENT_ACTIVE" : "ENTITLEMENT_MISSING"),
      },
      legalPolicy: {
        passed: policyResult.passed,
        jurisdiction,
        policyVersion: outboundDecision?.evaluation.policyVersion ?? null,
        reason: policyResult.reason,
        humanReason: recordingGateHumanReason(policyResult.reason),
      },
      legacyConsentAndDisclosure: {
        passed: legacyAndDisclosurePassed,
        consentId: legacyConsent.recordingConsentId,
        consentJurisdiction: legacyConsent.recordingConsentJurisdiction,
        disclosedInCall,
        confirmedInCall,
        reason: !legacyConsent.permitted
          ? "LEGACY_RECORDING_CONSENT_INVALID"
          : !disclosedInCall
            ? "IN_CALL_DISCLOSURE_REQUIRED"
            : !confirmedInCall
              ? "IN_CALL_CONFIRMATION_REQUIRED"
              : "LEGACY_CONSENT_AND_DISCLOSURE_CONFIRMED",
        humanReason: recordingGateHumanReason(
          !legacyConsent.permitted
            ? "LEGACY_RECORDING_CONSENT_INVALID"
            : !disclosedInCall
              ? "IN_CALL_DISCLOSURE_REQUIRED"
              : !confirmedInCall
                ? "IN_CALL_CONFIRMATION_REQUIRED"
                : "LEGACY_CONSENT_AND_DISCLOSURE_CONFIRMED",
        ),
      },
      adapterCapability: {
        passed: capabilityPassed,
        provider: input.providerName,
        reason: capabilityPassed ? "ADAPTER_RECORDING_CAPABLE" : "ADAPTER_RECORDING_UNAVAILABLE",
        humanReason: recordingGateHumanReason(
          capabilityPassed ? "ADAPTER_RECORDING_CAPABLE" : "ADAPTER_RECORDING_UNAVAILABLE",
          input.providerName,
        ),
      },
      operationalApproval: {
        passed: operationalPassed,
        flag: LIVE_RECORDING_APPROVAL_ENV,
        reason: operationalPassed ? "OPERATIONAL_RECORDING_APPROVED" : "OPERATIONAL_RECORDING_NOT_APPROVED",
        humanReason: recordingGateHumanReason(
          operationalPassed ? "OPERATIONAL_RECORDING_APPROVED" : "OPERATIONAL_RECORDING_NOT_APPROVED",
        ),
      },
    },
    // AE GROW W3-B (D-4): sourced from the retained decision, not from the
    // gate-feeding `outboundDecision`, so a blocked in-transaction evaluation
    // still carries the id and reason code of the decision it just recorded.
    outboundDecisionId: recordedDecisionForEvidence?.decision?.id ?? null,
    outboundReasonCode: recordedDecisionForEvidence?.evaluation.reasonCode ?? null,
  };
  // Exactly five recording gates are represented above.  `requested` is the
  // operation being attempted, not a sixth permission; the outbound decision
  // is recorded for the call-control audit but is not conflated with the five
  // recording gates.
  evidence.allPassed = allRecordingGatesPassed(evidence.gates);

  return { permitted: evidence.allPassed, evidence, outboundDecision };
}

export function recordingEvidenceSummary(evaluation: RecordingGateEvaluation): string {
  return JSON.stringify(evaluation.evidence);
}

/**
 * A Contact 360 eligibility read has no persisted call session yet. Evaluate
 * the same five gates against an explicit pre-call shape so the UI can show
 * every current gate without treating standing consent as a recording grant.
 * Disclosure and confirmation are intentionally false until the connected
 * call actions capture them; this function is read-only and never creates a
 * session or a consent decision.
 */
export async function evaluatePreCallRecordingGates(input: {
  brokerageId: number;
  partyId: number;
  actor: { id: number; role: string; brokerageId: number };
  jurisdiction: "AU" | "NZ" | null;
  providerName: string;
  providerCapabilities: TelephonyProviderCapabilities;
}): Promise<RecordingGateEvaluation> {
  return evaluateRecordingGates({
    session: {
      brokerageId: input.brokerageId,
      partyId: input.partyId,
      destinationCountry: input.jurisdiction ?? "UNKNOWN",
      recordingRequested: true,
      recordingConsentId: null,
      recordingStatus: "UNRECORDED",
    },
    actor: input.actor,
    providerName: input.providerName,
    providerCapabilities: input.providerCapabilities,
    readOnly: true,
  });
}
