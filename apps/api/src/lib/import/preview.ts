// Stage B.13/B.14/B.15 -- Import preview, duplicate review, field conflicts.
//
// Everything in this file is read-only planning: it turns the pipeline's
// output (validate.ts + dedup.ts + relationships.ts) into the summary and
// decision items the user reviews BEFORE anything is written to the
// database (B.13), the per-candidate USE_EXISTING/CREATE_NEW/MERGE/SKIP
// choices for ambiguous matches (B.14), and the per-field rules applied
// when merging into an existing record (B.15). No import.ts function in
// this file ever calls the database -- it only reasons about data already
// produced by earlier stages.

import type { ImportMatchType, ImportResolution } from "@aee/db";
import type { ContactCandidate, ContactMatchResult, PropertyCandidate, PropertyMatchResult } from "./dedup";
import type { ContactGroup, PropertyGroup, ResolvedRelationshipLink } from "./relationships";
import type { RowValidationResult } from "./validate";

/* ------------------------------------------------------------------ */
/* B.13 -- Preview summary                                            */
/* ------------------------------------------------------------------ */

export interface ImportPreviewSummary {
  totalRows: number;
  validRows: number;
  warningRows: number;
  errorRows: number;

  contactsTotal: number;
  contactsNew: number;
  contactsMatchedExact: number;
  contactsMatchedProbable: number;
  contactsMatchedPossible: number;

  propertiesTotal: number;
  propertiesNew: number;
  propertiesMatchedExact: number;
  propertiesMatchedProbable: number;
  propertiesMatchedPossible: number;

  relationshipsTotal: number;
  relationshipsPendingReview: number;

  // Anything with matchType "probable" or "possible" needs an explicit user
  // decision in Duplicate Review before import can proceed to READY_TO_IMPORT.
  duplicatesRequiringReview: number;
}

export function buildPreviewSummary(input: {
  validation: RowValidationResult[];
  contactGroups: ContactGroup[];
  contactGroupBestMatch: Map<string, ImportMatchType>; // groupKey -> best matchType seen across its rows ("new" if none)
  propertyGroups: PropertyGroup[];
  propertyGroupBestMatch: Map<string, ImportMatchType>;
  relationshipLinks: ResolvedRelationshipLink[];
}): ImportPreviewSummary {
  const { validation, contactGroups, contactGroupBestMatch, propertyGroups, propertyGroupBestMatch, relationshipLinks } = input;

  const validRows = validation.filter((v) => v.severity === "VALID").length;
  const warningRows = validation.filter((v) => v.severity === "WARNING").length;
  const errorRows = validation.filter((v) => v.severity === "ERROR").length;

  const tally = (groups: Array<{ groupKey: string }>, bestMatch: Map<string, ImportMatchType>) => {
    let exact = 0, probable = 0, possible = 0, fresh = 0;
    for (const g of groups) {
      switch (bestMatch.get(g.groupKey) ?? "new") {
        case "exact": exact++; break;
        case "probable": probable++; break;
        case "possible": possible++; break;
        default: fresh++; break;
      }
    }
    return { exact, probable, possible, fresh };
  };

  const contactTally = tally(contactGroups, contactGroupBestMatch);
  const propertyTally = tally(propertyGroups, propertyGroupBestMatch);

  return {
    totalRows: validation.length,
    validRows,
    warningRows,
    errorRows,

    contactsTotal: contactGroups.length,
    contactsNew: contactTally.fresh,
    contactsMatchedExact: contactTally.exact,
    contactsMatchedProbable: contactTally.probable,
    contactsMatchedPossible: contactTally.possible,

    propertiesTotal: propertyGroups.length,
    propertiesNew: propertyTally.fresh,
    propertiesMatchedExact: propertyTally.exact,
    propertiesMatchedProbable: propertyTally.probable,
    propertiesMatchedPossible: propertyTally.possible,

    relationshipsTotal: relationshipLinks.length,
    relationshipsPendingReview: relationshipLinks.filter((l) => l.needsPendingReview).length,

    duplicatesRequiringReview: contactTally.probable + contactTally.possible + propertyTally.probable + propertyTally.possible,
  };
}

/* ------------------------------------------------------------------ */
/* B.14 -- Duplicate review                                            */
/* ------------------------------------------------------------------ */

export interface ContactDuplicateReviewItem {
  kind: "contact";
  groupKey: string;
  matches: ContactMatchResult[];
  suggestedResolution: ImportResolution;
  requiresDecision: boolean;
}

export interface PropertyDuplicateReviewItem {
  kind: "property";
  groupKey: string;
  matches: PropertyMatchResult[];
  suggestedResolution: ImportResolution;
  requiresDecision: boolean;
}

/**
 * A single "exact" match gets a suggested resolution of use_existing (the
 * agent can still override it); everything else -- multiple exact matches,
 * any probable/possible match, or no match -- defaults to create_new as
 * the safe choice. Nothing here is ever silently applied: it only pre-
 * fills the Duplicate Review screen. READY_TO_IMPORT is reached only once
 * the user has confirmed or changed every item (B.14: "no auto-merge on
 * ambiguous matches").
 */
function suggestResolution(matches: Array<{ matchType: ImportMatchType }>): ImportResolution {
  const exactMatches = matches.filter((m) => m.matchType === "exact");
  if (exactMatches.length === 1) return "use_existing";
  return "create_new";
}

export function buildContactDuplicateReview(
  groups: ContactGroup[],
  matchesByGroup: Map<string, ContactMatchResult[]>,
): ContactDuplicateReviewItem[] {
  return groups
    .map((g) => {
      const matches = matchesByGroup.get(g.groupKey) ?? [];
      return {
        kind: "contact" as const,
        groupKey: g.groupKey,
        matches,
        suggestedResolution: suggestResolution(matches),
        requiresDecision: matches.length > 0,
      };
    })
    .filter((item) => item.requiresDecision);
}

export function buildPropertyDuplicateReview(
  groups: PropertyGroup[],
  matchesByGroup: Map<string, PropertyMatchResult[]>,
): PropertyDuplicateReviewItem[] {
  return groups
    .map((g) => {
      const matches = matchesByGroup.get(g.groupKey) ?? [];
      return {
        kind: "property" as const,
        groupKey: g.groupKey,
        matches,
        suggestedResolution: suggestResolution(matches),
        requiresDecision: matches.length > 0,
      };
    })
    .filter((item) => item.requiresDecision);
}

/* ------------------------------------------------------------------ */
/* B.15 -- Field conflict resolution                                   */
/* ------------------------------------------------------------------ */

export type FieldConflictRule = "retain_existing" | "use_imported" | "add_as_alternate" | "flag_for_review";

export interface FieldConflict {
  field: string;
  existingValue: string | null;
  importedValue: string;
  rule: FieldConflictRule;
  reason: string;
}

/**
 * Default per-field conflict rules applied when a row resolves to
 * use_existing or merge against an existing contact. The existing value is
 * always the record of truth unless it's simply empty (filling a gap is
 * always safe); a differing primary contact detail (email/mobile/address)
 * is never silently overwritten -- it's added as an alternate with the
 * import as its source, so nothing the agent already has is destroyed.
 * Identity fields (name) that genuinely conflict are flagged for a human
 * decision rather than guessed. The user can still override any individual
 * rule in Duplicate Review.
 */
export function resolveFieldConflicts(
  existing: ContactCandidate,
  incoming: {
    firstName?: string;
    middleName?: string;
    lastName?: string;
    email?: string;
    mobile?: string;
    residentialAddress?: string;
  },
): FieldConflict[] {
  const conflicts: FieldConflict[] = [];

  const check = (field: string, existingValue: string | null, importedValue: string | undefined, kind: "identity" | "contactDetail") => {
    if (!importedValue) return;
    if (!existingValue || existingValue.trim() === "") {
      conflicts.push({ field, existingValue, importedValue, rule: "use_imported", reason: "Existing record has no value for this field." });
      return;
    }
    if (existingValue.trim().toLowerCase() === importedValue.trim().toLowerCase()) return;

    if (kind === "contactDetail") {
      conflicts.push({
        field,
        existingValue,
        importedValue,
        rule: "add_as_alternate",
        reason: "Existing value is kept; the imported value is added as an alternate rather than overwriting it.",
      });
    } else {
      conflicts.push({
        field,
        existingValue,
        importedValue,
        rule: "flag_for_review",
        reason: "Existing and imported values differ -- needs a human decision rather than a default rule.",
      });
    }
  };

  check("firstName", existing.firstName, incoming.firstName, "identity");
  check("middleName", existing.middleName, incoming.middleName, "identity");
  check("lastName", existing.lastName, incoming.lastName, "identity");
  check("email", existing.email, incoming.email, "contactDetail");
  check("mobile", existing.mobile, incoming.mobile, "contactDetail");
  check("residentialAddress", existing.residentialAddress, incoming.residentialAddress, "contactDetail");

  return conflicts;
}
