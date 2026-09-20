// Stage B.8 -- Row-level validation.
//
// Classifies every NormalisedImportRecord as VALID / WARNING / ERROR.
// ERROR rows are excluded from import (surfaced to the user with a reason,
// exportable per B.22) but never abort the batch -- one bad row must never
// fail the whole import (Stage B "fail safely" principle).
//
// Deliberately row-scoped: cross-row concerns (duplicate detection,
// multi-row relationship reconstruction) live in dedup.ts / relationships.ts
// and see the whole batch. This file only knows what one row, in isolation,
// can tell us.

import type { NormalisedImportRecord } from "./neutralFormat";
import { normaliseEmail, normalisePhoneAUNZ } from "./normalise";

export type ValidationSeverity = "VALID" | "WARNING" | "ERROR";

export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
  severity: "WARNING" | "ERROR";
}

export interface RowValidationResult {
  severity: ValidationSeverity;
  issues: ValidationIssue[];
}

/**
 * Validates one normalised row in isolation. Returns every issue found;
 * severity is the worst of all issues (ERROR beats WARNING beats VALID).
 */
export function validateRecord(record: NormalisedImportRecord): RowValidationResult {
  const issues: ValidationIssue[] = [];
  const { person, contactAddress, property, relationship } = record;

  // A row must have SOME way to identify a contact -- name, email, or
  // phone. Without one of these it can't be deduplicated or matched
  // against anything and would create an unusable "ghost" contact.
  const hasName = Boolean(person.firstName || person.lastName || person.company || person.preferredName);
  const hasEmail = Boolean(person.email);
  const hasPhone = Boolean(person.mobile || person.alternatePhone);
  if (!hasName && !hasEmail && !hasPhone) {
    issues.push({
      field: "person",
      code: "CONTACT_UNIDENTIFIABLE",
      message: "Row has no name, email, or phone -- there's nothing to identify a contact by.",
      severity: "ERROR",
    });
  }

  for (const [field, value] of [
    ["person.email", person.email],
    ["person.alternateEmail", person.alternateEmail],
  ] as const) {
    if (value && !normaliseEmail(value).isValid) {
      issues.push({
        field,
        code: "EMAIL_INVALID_FORMAT",
        message: `"${value}" doesn't look like a valid email address. It is kept as entered -- review and correct if needed.`,
        severity: "WARNING",
      });
    }
  }

  for (const [field, value] of [
    ["person.mobile", person.mobile],
    ["person.alternatePhone", person.alternatePhone],
  ] as const) {
    if (!value) continue;
    const result = normalisePhoneAUNZ(value);
    if (!result.isValid) {
      issues.push({
        field,
        code: "PHONE_UNRECOGNISED_FORMAT",
        message: `"${value}" doesn't look like a phone number. It is kept as entered -- review and correct if needed.`,
        severity: "WARNING",
      });
    } else if (result.region === "UNKNOWN") {
      issues.push({
        field,
        code: "PHONE_REGION_UNKNOWN",
        message: `"${value}" wasn't recognised as an AU or NZ number and is kept exactly as entered.`,
        severity: "WARNING",
      });
    }
  }

  if (relationship && !property) {
    issues.push({
      field: "relationship",
      code: "RELATIONSHIP_WITHOUT_PROPERTY",
      message: "A relationship type was provided but no property address was found on this row -- it can't be linked to anything.",
      severity: "ERROR",
    });
  }

  if (property && !property.address?.formatted) {
    issues.push({
      field: "property.address",
      code: "PROPERTY_ADDRESS_MISSING",
      message: "A property was referenced on this row but no usable address was found.",
      severity: "ERROR",
    });
  }

  if ((property || relationship) && !hasName && !hasEmail && !hasPhone) {
    issues.push({
      field: "relationship",
      code: "RELATIONSHIP_WITHOUT_CONTACT",
      message: "A property/relationship was found on this row but there's no identifiable contact to link it to.",
      severity: "ERROR",
    });
  }

  // Not a hard error -- Stage A's growRelationships.status already has a
  // PendingReview state for exactly this case (uncertain relationships land
  // in PendingReview rather than being guessed).
  if (relationship?.resolvedType === "unknown_pending_review") {
    issues.push({
      field: "relationship.type",
      code: "RELATIONSHIP_TYPE_UNRECOGNISED",
      message: relationship.rawType
        ? `"${relationship.rawType}" didn't match a known relationship type -- it will be imported as Pending Review.`
        : "No relationship type was provided -- it will be imported as Pending Review.",
      severity: "WARNING",
    });
  }

  // AE GROW "Brokerage-wide Signal Sweep" stage 2. An ownership start date
  // AE could not read is a WARNING, never an ERROR: the row imports fine and
  // is fully usable, it simply cannot support the long_ownership_tenure rule.
  // Warning rather than silently dropping matters because the realistic
  // failure is a WHOLE COLUMN in an unrecognised format — one visible warning
  // per row lets the user reformat and re-import, where a silent drop would
  // leave them wondering why tenure signals never appear.
  if (property?.ownershipStartRejected) {
    issues.push({
      field: "property.ownershipStartDate",
      code: "OWNERSHIP_START_DATE_UNRECOGNISED",
      message: `"${property.ownershipStartRejected.raw}" was not imported as an ownership start date. ${property.ownershipStartRejected.reason} The rest of the row imports normally.`,
      severity: "WARNING",
    });
  }

  if (contactAddress && !contactAddress.formatted) {
    issues.push({
      field: "contactAddress",
      code: "CONTACT_ADDRESS_INCOMPLETE",
      message: "A contact address was partially provided but doesn't resolve to a usable formatted address.",
      severity: "WARNING",
    });
  }

  const severity: ValidationSeverity = issues.some((i) => i.severity === "ERROR")
    ? "ERROR"
    : issues.some((i) => i.severity === "WARNING")
      ? "WARNING"
      : "VALID";

  return { severity, issues };
}

export interface BatchValidationSummary {
  total: number;
  valid: number;
  warning: number;
  error: number;
}

/**
 * Validates every record in a batch independently -- one row's ERROR never
 * affects any other row. A batch that is 100% ERROR still returns a normal
 * summary (0 valid) rather than throwing; the import job simply has nothing
 * importable, which is surfaced to the user, not a pipeline failure.
 */
export function validateBatch(records: NormalisedImportRecord[]): {
  results: RowValidationResult[];
  summary: BatchValidationSummary;
} {
  const results = records.map(validateRecord);
  const summary = results.reduce<BatchValidationSummary>(
    (acc, r) => {
      acc.total += 1;
      if (r.severity === "VALID") acc.valid += 1;
      else if (r.severity === "WARNING") acc.warning += 1;
      else acc.error += 1;
      return acc;
    },
    { total: 0, valid: 0, warning: 0, error: 0 },
  );
  return { results, summary };
}
