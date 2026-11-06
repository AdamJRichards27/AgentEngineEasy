// Buyer qualification, standard model (Owner t165u: "Buyer qualification:
// standard model" = Option B of each criterion in the decision package):
//   Q1 verified contact: mobile AND email confirmed, name matches the party;
//   Q2 readiness: timeframe <= 6 months AND has inspected a comparable property
//      or attended an open home;
//   Q3 finance: pre-approval OR proof of funds sighted by the agent (sighted
//      date recorded, no document stored); "arranging" is not qualified;
//   Q4 requirements: budget and core requirements recorded and marked
//      relevant to the listing by the agent.
// Pure and migration-free: recording these facts needs M4 (gated).
// NOT decided and therefore NOT defaulted here: the validity period (30/60/90
// days were options) and the judgement-override rule. The caller must pass
// validForDays explicitly; there is no built-in expiry default.

export type FinancePosition = "PRE_APPROVAL" | "PROOF_OF_FUNDS" | "ARRANGING" | "UNKNOWN";

export interface BuyerQualificationFacts {
  mobileConfirmed: boolean;
  emailConfirmed: boolean;
  nameMatchesParty: boolean;
  timeframeMonths: number | null;
  inspectedComparableOrAttendedOpenHome: boolean;
  financePosition: FinancePosition;
  financeSightedAt: Date | null;
  requirementsRecorded: boolean;
  requirementsRelevantToListing: boolean;
  /** When the qualification facts were last confirmed. */
  assessedAt: Date;
}

export type QualificationFailure =
  | "Q1_CONTACT_NOT_VERIFIED"
  | "Q2_NOT_READY"
  | "Q3_FINANCE_NOT_SIGHTED"
  | "Q4_REQUIREMENTS_NOT_RELEVANT"
  | "EXPIRED";

export interface QualificationResult {
  qualified: boolean;
  failures: QualificationFailure[];
}

export const STANDARD_MODEL_MAX_TIMEFRAME_MONTHS = 6;

export function evaluateBuyerQualification(
  facts: BuyerQualificationFacts,
  opts: { now: Date; validForDays: number },
): QualificationResult {
  if (!Number.isInteger(opts.validForDays) || opts.validForDays < 1) throw new Error("validForDays must be a positive whole number (the validity period is an open Owner decision)");
  const failures: QualificationFailure[] = [];
  if (!(facts.mobileConfirmed && facts.emailConfirmed && facts.nameMatchesParty)) failures.push("Q1_CONTACT_NOT_VERIFIED");
  const ready = facts.timeframeMonths !== null && facts.timeframeMonths >= 0 && facts.timeframeMonths <= STANDARD_MODEL_MAX_TIMEFRAME_MONTHS;
  if (!(ready && facts.inspectedComparableOrAttendedOpenHome)) failures.push("Q2_NOT_READY");
  const financeOk = (facts.financePosition === "PRE_APPROVAL" || facts.financePosition === "PROOF_OF_FUNDS") && facts.financeSightedAt !== null;
  if (!financeOk) failures.push("Q3_FINANCE_NOT_SIGHTED");
  if (!(facts.requirementsRecorded && facts.requirementsRelevantToListing)) failures.push("Q4_REQUIREMENTS_NOT_RELEVANT");
  if (opts.now.getTime() - facts.assessedAt.getTime() > opts.validForDays * 86_400_000) failures.push("EXPIRED");
  return { qualified: failures.length === 0, failures };
}
