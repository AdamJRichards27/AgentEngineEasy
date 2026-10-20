// Contact 360 call-panel payload types (eligibility, five-gate result, call session). Pure type module (moved verbatim from pages/Grow.tsx).

export type CallEligibilityStatus =
  | "Ready to call"
  | "Consent needs review"
  | "Do Not Call check required"
  | "Calling unavailable at this time";

export interface GrowCallFiveGateResult {
  evaluatedAt: string;
  permitted: boolean;
  allPassed: boolean;
  gates: {
    entitlement: { passed: boolean; entitlementKey: string; reason: string; humanReason: string };
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

export interface GrowCallEligibility {
  eligible: boolean;
  status: CallEligibilityStatus;
  eligibilityStatus?: CallEligibilityStatus;
  reason: string;
  displayNumber: string | null;
  requiresCountryConfirmation: boolean;
  consentDecisionId?: number | null;
  recording: {
    available: boolean;
    permitted: boolean;
    status: "Recording not permitted" | "Recording available";
    statusCode: string;
    reason: string;
    provider: string;
    fiveGateResult: GrowCallFiveGateResult;
  };
}

export interface GrowCallSession {
  id: number;
  partyId: number;
  destinationRaw: string;
  destinationNormalized: string;
  destinationCountry: string;
  provider: string;
  providerCallId: string | null;
  status: string;
  recordingRequested: boolean;
  recordingPermitted: boolean;
  recordingStatus: string;
  confirmedAt: string | null;
  startedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  failureReason: string | null;
  cancelledReason: string | null;
}

export interface GrowCallSessionRead {
  callSession: GrowCallSession;
  recording: {
    available: boolean;
    permitted: boolean;
    status: "Recording not permitted" | "Recording available";
    statusCode: string;
    provider: string;
    fiveGateResult: GrowCallFiveGateResult;
  };
}
