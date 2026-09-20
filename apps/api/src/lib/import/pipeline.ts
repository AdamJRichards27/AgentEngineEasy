// Stage B import pipeline orchestration (B.20-22 groundwork + the glue every
// import route needs). Every pure stage (mapping/normalise/validate/dedup/
// group/relationships/preview/execute) already exists as a standalone module
// under lib/import/*.ts and is never re-implemented here -- this file's only
// job is wiring persisted state (importJobs/importRecords) through those
// stages in the right order.
//
// Nothing about the *computed* plan (contact/property groups, duplicate
// review, relationship links) is itself persisted as a new column -- it is
// always recomputed from what already IS persisted (rawData, mapping, the
// current brokerage-scoped candidate set, and any resolution decisions the
// agent has made). That recomputation is pure and deterministic given stable
// inputs, so calling it again after a resolution (or just to redraw the
// Duplicate Review screen) is always safe and always consistent -- there is
// no separate cache to go stale. Rows are always read in sourceRowNumber
// order so group keys ("contact-0", "property-1", ...) stay stable across
// calls within the same job.

import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  importJobs,
  importRecords,
  parties,
  properties,
  type ImportMatchType,
  type ImportResolution,
} from "@aee/db";
import { getParserForFile } from "./parsers/registry.js";
import { validateUploadedFile, MAX_IMPORT_ROWS, type UploadedFileLike } from "./fileValidation.js";
import { suggestMapping, applyMapping, type ColumnMapping, type ColumnMappingSuggestion } from "./mapping.js";
import { buildNormalisedRecord } from "./normalise.js";
import { validateRecord, type RowValidationResult } from "./validate.js";
import {
  findContactMatches,
  findPropertyMatches,
  type ContactCandidate,
  type ContactMatchResult,
  type PropertyCandidate,
  type PropertyMatchResult,
} from "./dedup.js";
import {
  groupContacts,
  groupProperties,
  resolveRelationshipLinks,
  type ContactGroup,
  type ContactGroupInput,
  type PropertyGroup,
  type PropertyGroupInput,
  type ResolvedRelationshipLink,
} from "./relationships.js";
import {
  buildPreviewSummary,
  buildContactDuplicateReview,
  buildPropertyDuplicateReview,
  type ImportPreviewSummary,
  type ContactDuplicateReviewItem,
  type PropertyDuplicateReviewItem,
} from "./preview.js";
import type { NormalisedImportRecord } from "./neutralFormat.js";
import type {
  ContactExecutionPlanItem,
  PropertyExecutionPlanItem,
  RelationshipExecutionPlanItem,
} from "./execute.js";

/** A user-facing 4xx problem (bad file, unmapped column, unknown group) -- distinct
 *  from an unexpected 500 so routes can respond without a stack trace. */
export class ImportUserError extends Error {}

/* -------------------------------------------------------------------- */
/* B.3/B.4/B.6 -- ingest a file into a new job                          */
/* -------------------------------------------------------------------- */

export async function createImportJobFromFile(
  brokerageId: number,
  userId: number,
  file: UploadedFileLike,
): Promise<{ job: typeof importJobs.$inferSelect; suggestedMapping: ColumnMappingSuggestion[] }> {
  const validation = validateUploadedFile(file);
  if (!validation.ok) throw new ImportUserError(validation.error);

  const parser = getParserForFile(file.originalname);
  const parsed = await parser.parse(file.buffer, { maxRows: MAX_IMPORT_ROWS });
  if (parsed.rows.length === 0) throw new ImportUserError("The file has no data rows to import.");

  const [job] = await db
    .insert(importJobs)
    .values({
      brokerageId,
      initiatedByUserId: userId,
      filename: file.originalname,
      sourceFileType: validation.sourceFileType,
      status: "MAPPING_REQUIRED",
      totalRows: parsed.rows.length,
    })
    .returning();

  // Batched insert -- a 50,000-row file is never held as one INSERT statement.
  const INSERT_BATCH = 500;
  for (let i = 0; i < parsed.rows.length; i += INSERT_BATCH) {
    const slice = parsed.rows.slice(i, i + INSERT_BATCH).map((row, j) => ({
      importJobId: job.id,
      sourceRowNumber: i + j + 1,
      rawData: row,
      status: "pending" as const,
    }));
    await db.insert(importRecords).values(slice);
  }

  return { job, suggestedMapping: suggestMapping(parsed.headers) };
}

async function loadCandidates(
  brokerageId: number,
): Promise<{ contacts: ContactCandidate[]; properties: PropertyCandidate[] }> {
  const [contactRows, propertyRows] = await Promise.all([
    db
      .select({
        id: parties.id,
        firstName: parties.firstName,
        middleName: parties.middleName,
        lastName: parties.lastName,
        organisationName: parties.organisationName,
        mobile: parties.mobile,
        email: parties.email,
        residentialAddress: parties.residentialAddress,
      })
      .from(parties)
      .where(eq(parties.brokerageId, brokerageId)),
    db
      .select({
        id: properties.id,
        formattedAddress: properties.formattedAddress,
        placeId: properties.placeId,
        suburb: properties.suburb,
        state: properties.state,
        postcode: properties.postcode,
      })
      .from(properties)
      .where(eq(properties.brokerageId, brokerageId)),
  ]);
  return { contacts: contactRows, properties: propertyRows };
}

function bestMatchType(matches: Array<{ matchType: ImportMatchType }>): ImportMatchType {
  if (matches.some((m) => m.matchType === "exact")) return "exact";
  if (matches.some((m) => m.matchType === "probable")) return "probable";
  if (matches.some((m) => m.matchType === "possible")) return "possible";
  return "new";
}

function aggregateByGroup<M extends { candidateId: number; score: number }>(
  groups: Array<{ groupKey: string; rowIndexes: number[] }>,
  perRowMatches: M[][],
): Map<string, M[]> {
  const out = new Map<string, M[]>();
  for (const g of groups) {
    const byCandidateId = new Map<number, M>();
    for (const rowIndex of g.rowIndexes) {
      for (const m of perRowMatches[rowIndex] ?? []) {
        const existing = byCandidateId.get(m.candidateId);
        if (!existing || m.score > existing.score) byCandidateId.set(m.candidateId, m);
      }
    }
    out.set(
      g.groupKey,
      [...byCandidateId.values()].sort((a, b) => b.score - a.score),
    );
  }
  return out;
}

/* -------------------------------------------------------------------- */
/* B.7/B.8 -- mapping + normalisation + validation, wired to storage    */
/* -------------------------------------------------------------------- */

/**
 * Applies a confirmed column mapping to every raw row, normalises, and
 * validates -- writing normalizedData/status/warnings/errors back onto each
 * importRecords row. Always re-derives from rawData, so it is safe to call
 * again if the agent changes the mapping and re-submits (B.6's "no
 * irreversible decisions before Preview" guarantee).
 */
export async function runMappingAndValidation(
  importJobId: number,
  brokerageId: number,
  mapping: ColumnMapping,
): Promise<{ validRows: number; warningRows: number; rejectedRows: number }> {
  const [job] = await db
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.id, importJobId), eq(importJobs.brokerageId, brokerageId)))
    .limit(1);
  if (!job) throw new ImportUserError(`Import job ${importJobId} not found in this brokerage`);

  await db
    .update(importJobs)
    .set({ mapping, status: "VALIDATING", updatedAt: new Date() })
    .where(eq(importJobs.id, importJobId));

  const rows = await db
    .select({ sourceRowNumber: importRecords.sourceRowNumber, rawData: importRecords.rawData })
    .from(importRecords)
    .where(eq(importRecords.importJobId, importJobId))
    .orderBy(asc(importRecords.sourceRowNumber));

  let validRows = 0;
  let warningRows = 0;
  let rejectedRows = 0;

  for (const row of rows) {
    const rawData = row.rawData as Record<string, string>;
    const mapped = applyMapping(rawData, mapping);
    const normalised = buildNormalisedRecord(mapped, {
      sourceRowNumber: row.sourceRowNumber,
      originalValues: rawData,
      mappingConfidence: "manual",
      warnings: [],
    });
    const validation = validateRecord(normalised);
    const status = validation.severity === "ERROR" ? "error" : validation.severity === "WARNING" ? "warning" : "valid";
    if (status === "valid") validRows += 1;
    else if (status === "warning") warningRows += 1;
    else rejectedRows += 1;

    await db
      .update(importRecords)
      .set({
        normalizedData: normalised,
        status,
        warnings: validation.issues.filter((i) => i.severity === "WARNING"),
        errors: validation.issues.filter((i) => i.severity === "ERROR"),
        updatedAt: new Date(),
      })
      .where(and(eq(importRecords.importJobId, importJobId), eq(importRecords.sourceRowNumber, row.sourceRowNumber)));
  }

  await db
    .update(importJobs)
    .set({
      totalRows: rows.length,
      processedRows: rows.length,
      validRows,
      warningRows,
      rejectedRows,
      status: "REVIEW_REQUIRED",
      updatedAt: new Date(),
    })
    .where(eq(importJobs.id, importJobId));

  return { validRows, warningRows, rejectedRows };
}

/* -------------------------------------------------------------------- */
/* B.9-B.15 -- dedup, grouping, relationship resolution (recomputed)    */
/* -------------------------------------------------------------------- */

interface ComputedPlan {
  /** Every mapped+validated row, in source order -- used for accurate preview totals. */
  allValidation: RowValidationResult[];
  /** VALID/WARNING rows only -- ERROR rows are surfaced to the user (and exportable,
   *  B.22) but never grouped, linked, or executed (validate.ts's "fail safely" rule). */
  records: NormalisedImportRecord[];
  rowNumbers: number[];
  contactGroups: ContactGroup[];
  contactRowToGroupKey: Map<number, string>;
  contactMatchesByGroup: Map<string, ContactMatchResult[]>;
  contactGroupBestMatch: Map<string, ImportMatchType>;
  propertyGroups: PropertyGroup[];
  propertyRowToGroupKey: Map<number, string>;
  propertyMatchesByGroup: Map<string, PropertyMatchResult[]>;
  propertyGroupBestMatch: Map<string, ImportMatchType>;
  relationshipLinks: ResolvedRelationshipLink[];
}

async function computePlan(importJobId: number, brokerageId: number): Promise<ComputedPlan> {
  const [job] = await db
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.id, importJobId), eq(importJobs.brokerageId, brokerageId)))
    .limit(1);
  if (!job) throw new ImportUserError(`Import job ${importJobId} not found in this brokerage`);

  const stored = await db
    .select({ sourceRowNumber: importRecords.sourceRowNumber, normalizedData: importRecords.normalizedData })
    .from(importRecords)
    .where(eq(importRecords.importJobId, importJobId))
    .orderBy(asc(importRecords.sourceRowNumber));

  const usable = stored.filter((r) => r.normalizedData != null);
  const allRecords = usable.map((r) => r.normalizedData as NormalisedImportRecord);
  const allRowNumbers = usable.map((r) => r.sourceRowNumber);
  const allValidation = allRecords.map((r) => validateRecord(r));

  const importableIdx = allValidation.map((v, i) => (v.severity !== "ERROR" ? i : -1)).filter((i) => i !== -1);
  const records = importableIdx.map((i) => allRecords[i]);
  const rowNumbers = importableIdx.map((i) => allRowNumbers[i]);

  const candidates = await loadCandidates(brokerageId);
  const contactMatches = records.map((r) => findContactMatches(r, candidates.contacts).matches);
  const propertyMatches = records.map((r) => findPropertyMatches(r, candidates.properties).matches);

  const contactInputs: ContactGroupInput[] = records.map((r, i) => ({
    record: r,
    existingMatch: contactMatches[i][0]?.matchType === "exact" ? { matchType: "exact", partyId: contactMatches[i][0].candidateId } : undefined,
  }));
  const { groups: contactGroups, rowToGroupKey: contactRowToGroupKey } = groupContacts(contactInputs);

  const propertyInputs: PropertyGroupInput[] = records.map((r, i) => ({
    record: r,
    existingMatch:
      propertyMatches[i][0]?.matchType === "exact" ? { matchType: "exact", propertyId: propertyMatches[i][0].candidateId } : undefined,
  }));
  const { groups: propertyGroups, rowToGroupKey: propertyRowToGroupKey } = groupProperties(propertyInputs);

  const contactMatchesByGroup = aggregateByGroup(contactGroups, contactMatches);
  const propertyMatchesByGroup = aggregateByGroup(propertyGroups, propertyMatches);

  const contactGroupBestMatch = new Map<string, ImportMatchType>();
  for (const g of contactGroups) contactGroupBestMatch.set(g.groupKey, bestMatchType(contactMatchesByGroup.get(g.groupKey) ?? []));
  const propertyGroupBestMatch = new Map<string, ImportMatchType>();
  for (const g of propertyGroups) propertyGroupBestMatch.set(g.groupKey, bestMatchType(propertyMatchesByGroup.get(g.groupKey) ?? []));

  const relationshipLinks = resolveRelationshipLinks(records, contactRowToGroupKey, propertyRowToGroupKey);

  return {
    allValidation,
    records,
    rowNumbers,
    contactGroups,
    contactRowToGroupKey,
    contactMatchesByGroup,
    contactGroupBestMatch,
    propertyGroups,
    propertyRowToGroupKey,
    propertyMatchesByGroup,
    propertyGroupBestMatch,
    relationshipLinks,
  };
}

/**
 * B.13/B.14 -- builds the Preview + Duplicate Review screens' data, and as a
 * side effect persists each importable row's computed match type/candidate/
 * score onto importRecords -- this is what makes Duplicate Review resumable
 * across requests and is the audit trail dedup decisions are read back from.
 */
export async function buildImportPreview(
  importJobId: number,
  brokerageId: number,
): Promise<{
  summary: ImportPreviewSummary;
  contactDuplicates: ContactDuplicateReviewItem[];
  propertyDuplicates: PropertyDuplicateReviewItem[];
  contactGroupInfo: Record<string, { sourceRowNumbers: number[]; displayName: string }>;
  propertyGroupInfo: Record<string, { sourceRowNumbers: number[]; displayName: string }>;
}> {
  const plan = await computePlan(importJobId, brokerageId);

  const summary = buildPreviewSummary({
    validation: plan.allValidation,
    contactGroups: plan.contactGroups,
    contactGroupBestMatch: plan.contactGroupBestMatch,
    propertyGroups: plan.propertyGroups,
    propertyGroupBestMatch: plan.propertyGroupBestMatch,
    relationshipLinks: plan.relationshipLinks,
  });
  const contactDuplicates = buildContactDuplicateReview(plan.contactGroups, plan.contactMatchesByGroup);
  const propertyDuplicates = buildPropertyDuplicateReview(plan.propertyGroups, plan.propertyMatchesByGroup);

  for (let i = 0; i < plan.records.length; i++) {
    const rowNumber = plan.rowNumbers[i];
    const contactGroupKey = plan.contactRowToGroupKey.get(i);
    const contactBest = contactGroupKey ? plan.contactMatchesByGroup.get(contactGroupKey)?.[0] : undefined;
    const propertyGroupKey = plan.propertyRowToGroupKey.get(i);
    const propertyBest = propertyGroupKey ? plan.propertyMatchesByGroup.get(propertyGroupKey)?.[0] : undefined;

    await db
      .update(importRecords)
      .set({
        contactMatchType: contactGroupKey ? plan.contactGroupBestMatch.get(contactGroupKey) ?? "new" : "new",
        contactMatchCandidateId: contactBest?.candidateId ?? null,
        contactMatchScore: contactBest ? String(contactBest.score) : null,
        propertyMatchType: propertyGroupKey ? plan.propertyGroupBestMatch.get(propertyGroupKey) ?? "new" : "new",
        propertyMatchCandidateId: propertyBest?.candidateId ?? null,
        propertyMatchScore: propertyBest ? String(propertyBest.score) : null,
        updatedAt: new Date(),
      })
      .where(and(eq(importRecords.importJobId, importJobId), eq(importRecords.sourceRowNumber, rowNumber)));
  }

  await db
    .update(importJobs)
    .set({
      duplicateCandidates: contactDuplicates.length + propertyDuplicates.length,
      status: "REVIEW_REQUIRED",
      updatedAt: new Date(),
    })
    .where(eq(importJobs.id, importJobId));

  // B.27 frontend support: a duplicate-review groupKey ("contact-3") means
  // nothing to a human reviewer on its own. These maps give the wizard a
  // real name/address plus the source row(s) it came from to show alongside
  // each match -- computed here, not persisted, same as everything else in
  // this file.
  const contactGroupInfo: Record<string, { sourceRowNumbers: number[]; displayName: string }> = {};
  for (const g of plan.contactGroups) {
    const rep = plan.records[g.rowIndexes[0]];
    const displayName =
      [rep.person.firstName, rep.person.lastName].filter(Boolean).join(" ") ||
      rep.person.company ||
      rep.person.email ||
      rep.person.mobile ||
      "(unnamed contact)";
    contactGroupInfo[g.groupKey] = { sourceRowNumbers: g.rowIndexes.map((i) => plan.rowNumbers[i]), displayName };
  }
  const propertyGroupInfo: Record<string, { sourceRowNumbers: number[]; displayName: string }> = {};
  for (const g of plan.propertyGroups) {
    const rep = plan.records[g.rowIndexes[0]];
    const displayName = rep.property?.address.formatted ?? "(unspecified address)";
    propertyGroupInfo[g.groupKey] = { sourceRowNumbers: g.rowIndexes.map((i) => plan.rowNumbers[i]), displayName };
  }

  return { summary, contactDuplicates, propertyDuplicates, contactGroupInfo, propertyGroupInfo };
}

/**
 * B.14 -- applies one Duplicate Review decision to every row in a group.
 * Resolution is stored per-row (importRecords has no groupKey column, since
 * group membership is deterministically recomputed, not persisted) but a
 * decision is always made and applied at the group level -- never per-row --
 * so every source row that contributed to the same real-world contact or
 * property shares one outcome.
 */
export async function resolveDuplicateGroup(
  importJobId: number,
  brokerageId: number,
  kind: "contact" | "property",
  groupKey: string,
  resolution: ImportResolution,
  candidateId?: number,
): Promise<{ rowsAffected: number }> {
  const plan = await computePlan(importJobId, brokerageId);
  const rowToGroupKey = kind === "contact" ? plan.contactRowToGroupKey : plan.propertyRowToGroupKey;
  const groups: Array<{ groupKey: string; existingId?: number }> =
    kind === "contact"
      ? plan.contactGroups.map((g) => ({ groupKey: g.groupKey, existingId: g.existingPartyId }))
      : plan.propertyGroups.map((g) => ({ groupKey: g.groupKey, existingId: g.existingPropertyId }));
  const group = groups.find((g) => g.groupKey === groupKey);
  if (!group) throw new ImportUserError(`Group "${groupKey}" was not found for this job (has the mapping changed?)`);

  let resolvedCandidateId: number | undefined;
  if (resolution === "use_existing" || resolution === "merge") {
    resolvedCandidateId = candidateId ?? group.existingId;
    if (resolvedCandidateId === undefined) {
      throw new ImportUserError(
        `Resolution "${resolution}" for group "${groupKey}" requires a candidateId -- more than one existing match, so it can't be picked automatically.`,
      );
    }
  }

  const rowNumbers: number[] = [];
  for (const [rowIndex, key] of rowToGroupKey) if (key === groupKey) rowNumbers.push(plan.rowNumbers[rowIndex]);
  if (rowNumbers.length === 0) return { rowsAffected: 0 };

  await db
    .update(importRecords)
    .set(
      kind === "contact"
        ? { contactResolution: resolution, contactMatchCandidateId: resolvedCandidateId ?? null, updatedAt: new Date() }
        : { propertyResolution: resolution, propertyMatchCandidateId: resolvedCandidateId ?? null, updatedAt: new Date() },
    )
    .where(and(eq(importRecords.importJobId, importJobId), inArray(importRecords.sourceRowNumber, rowNumbers)));

  return { rowsAffected: rowNumbers.length };
}

function defaultResolutionForGroup(existingId: number | undefined, conflict: boolean): ImportResolution {
  return existingId !== undefined && !conflict ? "use_existing" : "create_new";
}

/**
 * B.16 input builder -- turns the recomputed groups + whatever resolution
 * decisions are on file into the exact plan shape execute.ts's
 * executeImportBatch() expects. A group nobody explicitly resolved still
 * gets a safe default (single exact match -> use_existing, everything else
 * -> create_new) so an import isn't blocked on review of the unambiguous
 * majority of rows -- it only genuinely needs a decision when there's
 * something to decide.
 */
export async function buildExecutionPlan(
  importJobId: number,
  brokerageId: number,
): Promise<{
  contacts: ContactExecutionPlanItem[];
  contactProperties: PropertyExecutionPlanItem[];
  relationships: RelationshipExecutionPlanItem[];
}> {
  const plan = await computePlan(importJobId, brokerageId);

  const resolutionRows = await db
    .select({
      sourceRowNumber: importRecords.sourceRowNumber,
      contactResolution: importRecords.contactResolution,
      contactMatchCandidateId: importRecords.contactMatchCandidateId,
      propertyResolution: importRecords.propertyResolution,
      propertyMatchCandidateId: importRecords.propertyMatchCandidateId,
    })
    .from(importRecords)
    .where(eq(importRecords.importJobId, importJobId));
  const byRowNumber = new Map(resolutionRows.map((r) => [r.sourceRowNumber, r]));

  const contacts: ContactExecutionPlanItem[] = plan.contactGroups.map((g) => {
    const repRowNumber = plan.rowNumbers[g.rowIndexes[0]];
    const repRecord = plan.records[g.rowIndexes[0]];
    const stored = byRowNumber.get(repRowNumber);
    const resolution = (stored?.contactResolution as ImportResolution | null) ?? defaultResolutionForGroup(g.existingPartyId, g.conflict);
    const candidatePartyId = stored?.contactMatchCandidateId ?? g.existingPartyId;
    return {
      groupKey: g.groupKey,
      resolution,
      candidatePartyId: candidatePartyId ?? undefined,
      sourceRowNumbers: g.rowIndexes.map((i) => plan.rowNumbers[i]),
      person: {
        firstName: repRecord.person.firstName,
        middleName: repRecord.person.middleName,
        lastName: repRecord.person.lastName,
        organisationName: repRecord.person.company,
        email: repRecord.person.email,
        mobile: repRecord.person.mobile,
        residentialAddress: repRecord.contactAddress?.formatted,
      },
    };
  });

  const contactProperties: PropertyExecutionPlanItem[] = plan.propertyGroups.map((g) => {
    const repRowNumber = plan.rowNumbers[g.rowIndexes[0]];
    const repRecord = plan.records[g.rowIndexes[0]];
    const stored = byRowNumber.get(repRowNumber);
    const resolution = (stored?.propertyResolution as ImportResolution | null) ?? defaultResolutionForGroup(g.existingPropertyId, g.conflict);
    const candidatePropertyId = stored?.propertyMatchCandidateId ?? g.existingPropertyId;
    return {
      groupKey: g.groupKey,
      resolution,
      candidatePropertyId: candidatePropertyId ?? undefined,
      sourceRowNumbers: g.rowIndexes.map((i) => plan.rowNumbers[i]),
      formattedAddress: repRecord.property?.address.formatted,
      suburb: repRecord.property?.address.suburb,
      state: repRecord.property?.address.state,
      postcode: repRecord.property?.address.postcode,
      isManualAddress: true,
    };
  });

  const relationships: RelationshipExecutionPlanItem[] = plan.relationshipLinks.map((l) => ({
    contactGroupKey: l.contactGroupKey,
    propertyGroupKey: l.propertyGroupKey,
    relationshipType: l.relationshipType,
    rawType: l.rawType,
    sourceRowNumbers: l.rowIndexes.map((i) => plan.rowNumbers[i]),
    needsPendingReview: l.needsPendingReview,
    // AE GROW "Brokerage-wide Signal Sweep" stage 2 — the observed ownership
    // start, already resolved per link by relationships.ts.
    ownershipStart: l.ownershipStart,
  }));

  return { contacts, contactProperties, relationships };
}

/* -------------------------------------------------------------------- */
/* B.21/B.22 -- history + rejected-row export                           */
/* -------------------------------------------------------------------- */

export async function listImportJobs(brokerageId: number) {
  return db
    .select()
    .from(importJobs)
    .where(eq(importJobs.brokerageId, brokerageId))
    .orderBy(asc(importJobs.uploadedAt));
}

/** B.22 -- every rejected (ERROR-severity) row, in a plain CSV an agent can
 *  fix in a spreadsheet and re-upload as a fresh job. Original column values
 *  are preserved verbatim; only a trailing "Import Errors" column is added. */
export async function exportRejectedRecordsCsv(importJobId: number, brokerageId: number): Promise<string> {
  const [job] = await db
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.id, importJobId), eq(importJobs.brokerageId, brokerageId)))
    .limit(1);
  if (!job) throw new ImportUserError(`Import job ${importJobId} not found in this brokerage`);

  const rows = await db
    .select({ sourceRowNumber: importRecords.sourceRowNumber, rawData: importRecords.rawData, errors: importRecords.errors })
    .from(importRecords)
    .where(and(eq(importRecords.importJobId, importJobId), eq(importRecords.status, "error")))
    .orderBy(asc(importRecords.sourceRowNumber));

  // AE Step 2 closure — Part E (static analysis). A CSV cell whose value
  // starts with =, +, -, @, a tab, or a carriage return is interpreted as
  // a formula by Excel/Sheets/LibreOffice when this file is opened, not
  // as plain text — the classic "CSV/formula injection" class. `headers`
  // (arbitrary user-supplied import column names) and every `raw[h]` cell
  // value both originate from an uploaded import file this route lets an
  // agent re-download, so both need the same OWASP-recommended mitigation:
  // prefix a leading `'` on any value starting with one of those
  // characters, which every mainstream spreadsheet application renders as
  // a literal leading quote / forces text interpretation, before this
  // function's own pre-existing comma/quote/newline quoting is applied.
  const FORMULA_INJECTION_PREFIX_PATTERN = /^[=+\-@\t\r]/;
  const neutralizeFormulaInjection = (value: string): string =>
    FORMULA_INJECTION_PREFIX_PATTERN.test(value) ? `'${value}` : value;
  const csvEscape = (value: string): string => {
    const neutralized = neutralizeFormulaInjection(value);
    return /[",\n]/.test(neutralized) ? `"${neutralized.replace(/"/g, '""')}"` : neutralized;
  };

  const headerSet = new Set<string>();
  for (const r of rows) Object.keys((r.rawData as Record<string, string>) ?? {}).forEach((h) => headerSet.add(h));
  const headers = [...headerSet];

  const lines = [
    [...headers, "Import Errors"].map(csvEscape).join(","),
    ...rows.map((r) => {
      const raw = (r.rawData as Record<string, string>) ?? {};
      const errorMessages = ((r.errors as Array<{ message: string }> | null) ?? []).map((e) => e.message).join("; ");
      return [...headers.map((h) => csvEscape(raw[h] ?? "")), csvEscape(errorMessages)].join(",");
    }),
  ];
  return lines.join("\n");
}
