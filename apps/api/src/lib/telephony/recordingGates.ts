import type { GrowCallSession } from "@aee/db";
import type { ConsentTransaction } from "../consentControlsPersistence.js";
import { resolveEntitlements } from "../entitlements/resolver.js";
import { evaluateOutboundCallEligibility, evaluateOutboundCallEligibilityInTransaction } from "./eligibility.js";
import { resolveRecordingPermission } from "./consent.js";
import type { TelephonyProviderCapabilities } from "./provider.js";

type OutboundDecision = Awaited<ReturnType<typeof evaluateOutboundCallEligibility>>;
export const LIVE_RECORDING_APPROVAL_ENV = "LIVE_RECORDING_APPROVED" as const;

export interface RecordingGateEvidence {
  evaluatedAt: string;
  requested: boolean;
  allPassed: boolean;
  gates: {
    entitlement: { passed: boolean; entitlementKey: "grow.calling.recording"; reason: string };
    legalPolicy: { passed: boolean; jurisdiction: string | null; policyVersion: string | null; reason: string };
    legacyConsentAndDisclosure: {
      passed: boolean;
      consentId: number | null;
      consentJurisdiction: string | null;
      disclosedInCall: boolean;
      confirmedInCall: boolean;
      reason: string;
    };
    adapterCapability: { passed: boolean; provider: string; reason: string };
    operationalApproval: { passed: boolean; flag: string; reason: string };
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

/**
 * Evaluate exactly the five F2 recording gates.  `recordingRequested` is an
 * input to the operation, not a sixth permission gate.  This function is
 * called at the enable action (after in-call disclosure and confirmation),
 * never at READY/pre-call time.
 */
export async function evaluateRecordingGates(input: {
  session: GrowCallSession;
  actor: { id: number; role: string; brokerageId: number };
  providerName: string;
  providerCapabilities: TelephonyProviderCapabilities;
  tx?: ConsentTransaction;
}): Promise<RecordingGateEvaluation> {
  const session = input.session;
  const evaluatedAt = new Date().toISOString();
  const requested = session.recordingRequested === true;
  const disclosedInCall = session.recordingStatus === "DISCLOSED" || session.recordingStatus === "CONFIRMED" || session.recordingStatus === "PERMITTED_NOT_CAPTURED";
  const confirmedInCall = session.recordingStatus === "CONFIRMED" || session.recordingStatus === "PERMITTED_NOT_CAPTURED";

  let outboundDecision: OutboundDecision | null = null;
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
      if (recorded.evaluation.decision === "ELIGIBLE") outboundDecision = recorded;
    } else {
      outboundDecision = await evaluateOutboundCallEligibility({
        brokerageId: session.brokerageId,
        partyId: session.partyId,
        decidedByUserId: input.actor.id,
        jurisdiction: session.destinationCountry === "AU" || session.destinationCountry === "NZ" ? session.destinationCountry : null,
      });
    }
  } catch {
    // The recording operation is fail-closed and must not make the base call
    // fail.  The failed decision itself is already audited by the authority
    // whenever evidence could be resolved.
  }

  const entitlementKeys = await resolveEntitlements(input.actor).catch(() => new Set<string>());
  const entitlementPassed = entitlementKeys.has("grow.calling.recording");

  const decisionEvidence = outboundDecision?.decision.evidence;
  const evidenceRecord = asRecord(decisionEvidence);
  const policySnapshot = evidenceRecord?.policySnapshot;
  const jurisdiction = outboundDecision?.evaluation.jurisdiction ?? session.destinationCountry ?? null;
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
      },
      legalPolicy: {
        passed: policyResult.passed,
        jurisdiction,
        policyVersion: outboundDecision?.evaluation.policyVersion ?? null,
        reason: policyResult.reason,
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
      },
      adapterCapability: {
        passed: capabilityPassed,
        provider: input.providerName,
        reason: capabilityPassed ? "ADAPTER_RECORDING_CAPABLE" : "ADAPTER_RECORDING_UNAVAILABLE",
      },
      operationalApproval: {
        passed: operationalPassed,
        flag: LIVE_RECORDING_APPROVAL_ENV,
        reason: operationalPassed ? "OPERATIONAL_RECORDING_APPROVED" : "OPERATIONAL_RECORDING_NOT_APPROVED",
      },
    },
    outboundDecisionId: outboundDecision?.decision.id ?? null,
    outboundReasonCode: outboundDecision?.evaluation.reasonCode ?? null,
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
