// AE GROW Priority 6 Stage F2 step 1 — jurisdiction-separated policy
// templates. These are configuration data only: they are not legal defaults,
// are not seeded, and do not perform any database writes.

export interface GrowConsentPolicyTemplate {
  readonly jurisdiction: "AU" | "NZ";
  readonly version: string;
  readonly allowInferredConsent: false;
  readonly allowNotRequiredConsent: false;
  readonly dncrRequired: true;
  readonly suppressionEnabled: true;
  /**
   * Deliberately unset until a reviewed, jurisdiction-specific operating
   * timezone and contact-hours window is approved. The policy evaluator fails
   * closed with POLICY_INVALID_WINDOW while these remain unset.
   */
  readonly timeZone: null;
  readonly allowedHoursStart: null;
  readonly allowedHoursEnd: null;
  readonly quietHoursStart: null;
  readonly quietHoursEnd: null;
  readonly policyData: {
    readonly templateId: string;
    readonly approvalStatus: "REVIEW_REQUIRED";
    readonly timeZoneStatus: "NOT_APPROVED";
    readonly allowedHoursStatus: "NOT_APPROVED";
    readonly timezoneConsiderations: readonly string[];
    readonly note: string;
  };
}

/**
 * Conservative AU configuration placeholder. Australia has multiple civil
 * timezones and daylight-saving regimes, so this template intentionally does
 * not choose a default timezone or hours window.
 *
 * A caller can persist it through recordConsentPolicy by spreading the
 * template and supplying brokerageId, effectiveAt, and recordedByUserId.
 * Persistence is explicit and opt-in; this module performs no live writes.
 */
export const GROW_AU_CONSENT_POLICY_TEMPLATE: GrowConsentPolicyTemplate = {
  jurisdiction: "AU",
  version: "au-conservative-review-required-v1",
  allowInferredConsent: false,
  allowNotRequiredConsent: false,
  dncrRequired: true,
  suppressionEnabled: true,
  timeZone: null,
  allowedHoursStart: null,
  allowedHoursEnd: null,
  quietHoursStart: null,
  quietHoursEnd: null,
  policyData: {
    templateId: "grow-consent-au-conservative-review-required-v1",
    approvalStatus: "REVIEW_REQUIRED",
    timeZoneStatus: "NOT_APPROVED",
    allowedHoursStatus: "NOT_APPROVED",
    timezoneConsiderations: [
      "Australia has multiple civil timezones.",
      "Australian daylight-saving observance varies by jurisdiction.",
      "Select and review the applicable timezone before enabling outbound eligibility.",
    ],
    note: "No AU timezone or contact-hours legal default is supplied by this template.",
  },
};

/**
 * Conservative NZ configuration placeholder. New Zealand also has more than
 * one civil timezone and daylight-saving considerations, so this template
 * intentionally leaves timezone and hours unset pending review.
 */
export const GROW_NZ_CONSENT_POLICY_TEMPLATE: GrowConsentPolicyTemplate = {
  jurisdiction: "NZ",
  version: "nz-conservative-review-required-v1",
  allowInferredConsent: false,
  allowNotRequiredConsent: false,
  dncrRequired: true,
  suppressionEnabled: true,
  timeZone: null,
  allowedHoursStart: null,
  allowedHoursEnd: null,
  quietHoursStart: null,
  quietHoursEnd: null,
  policyData: {
    templateId: "grow-consent-nz-conservative-review-required-v1",
    approvalStatus: "REVIEW_REQUIRED",
    timeZoneStatus: "NOT_APPROVED",
    allowedHoursStatus: "NOT_APPROVED",
    timezoneConsiderations: [
      "New Zealand has multiple civil timezones, including the Chatham Islands.",
      "New Zealand daylight-saving observance must be handled by the selected IANA timezone.",
      "Select and review the applicable timezone before enabling outbound eligibility.",
    ],
    note: "No NZ timezone or contact-hours legal default is supplied by this template.",
  },
};

export const GROW_CONSENT_POLICY_TEMPLATES = {
  AU: GROW_AU_CONSENT_POLICY_TEMPLATE,
  NZ: GROW_NZ_CONSENT_POLICY_TEMPLATE,
} as const;
