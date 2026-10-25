// Owner t181u(A): versioned AE agreement and payment-mandate terms for the
// Pit Crew service fee. The fee is collected IMMEDIATELY on final statement
// issue only when the signed agreement AND the payment mandate the authority
// was executed under BOTH expressly permit it (term flag
// immediateOnStatementIssue). Every other case, including pre-versioned
// authorities (null versions) and any unknown version string, fails closed to
// the contractual notice period (pc_fee_authorities.notice_required_days).
// Existing obligations are never silently overridden: a terms change is a new
// authority version, drafted and independently activated by Brokerage
// Administrators. Only NEW versions carry the flag.
export interface PcFeeTermsVersion {
  immediateOnStatementIssue: boolean;
  description: string;
}

export const PC_FEE_AGREEMENT_TERMS: Readonly<Record<string, PcFeeTermsVersion>> = Object.freeze({
  // Pre-t181u signed AE agreements: fee payable after the notice period.
  "AE-PCF-AGREEMENT-2025.1": { immediateOnStatementIssue: false, description: "Fee payable after the agreed notice period" },
  // New AE agreements (t181u): fee due and debitable on issue of the final settlement statement after confirmed settlement.
  "AE-PCF-AGREEMENT-2026.11": { immediateOnStatementIssue: true, description: "Fee due and debitable on issue of the final settlement statement" },
});

export const PC_FEE_MANDATE_TERMS: Readonly<Record<string, PcFeeTermsVersion>> = Object.freeze({
  "AE-PCF-MANDATE-2025.1": { immediateOnStatementIssue: false, description: "Debit after the agreed notice period" },
  "AE-PCF-MANDATE-2026.11": { immediateOnStatementIssue: true, description: "Debit permitted on issue of the final settlement statement" },
});

export type CollectionTimingRule = "IMMEDIATE_ON_STATEMENT_ISSUE" | "NOTICE_PERIOD";

export interface CollectionTiming {
  rule: CollectionTimingRule;
  agreementTermsVersion: string | null;
  mandateTermsVersion: string | null;
  /** Why the notice period applies (absent for IMMEDIATE). */
  noticeReason?: "AGREEMENT_TERMS_UNVERSIONED" | "AGREEMENT_TERMS_REQUIRE_NOTICE" | "MANDATE_TERMS_UNVERSIONED" | "MANDATE_TERMS_REQUIRE_NOTICE";
}

export function isKnownAgreementTerms(v: string): boolean {
  return Object.prototype.hasOwnProperty.call(PC_FEE_AGREEMENT_TERMS, v);
}
export function isKnownMandateTerms(v: string): boolean {
  return Object.prototype.hasOwnProperty.call(PC_FEE_MANDATE_TERMS, v);
}

/** Fail closed: IMMEDIATE only when both signed terms versions are known and both expressly permit it. */
export function collectionTimingFor(authority: { agreementTermsVersion: string | null; mandateTermsVersion: string | null }): CollectionTiming {
  const a = authority.agreementTermsVersion ?? null;
  const m = authority.mandateTermsVersion ?? null;
  const base = { agreementTermsVersion: a, mandateTermsVersion: m };
  if (!a || !isKnownAgreementTerms(a)) return { rule: "NOTICE_PERIOD", ...base, noticeReason: "AGREEMENT_TERMS_UNVERSIONED" };
  if (!PC_FEE_AGREEMENT_TERMS[a]!.immediateOnStatementIssue) return { rule: "NOTICE_PERIOD", ...base, noticeReason: "AGREEMENT_TERMS_REQUIRE_NOTICE" };
  if (!m || !isKnownMandateTerms(m)) return { rule: "NOTICE_PERIOD", ...base, noticeReason: "MANDATE_TERMS_UNVERSIONED" };
  if (!PC_FEE_MANDATE_TERMS[m]!.immediateOnStatementIssue) return { rule: "NOTICE_PERIOD", ...base, noticeReason: "MANDATE_TERMS_REQUIRE_NOTICE" };
  return { rule: "IMMEDIATE_ON_STATEMENT_ISSUE", ...base };
}
