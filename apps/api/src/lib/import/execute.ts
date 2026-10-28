// Stage B.16-B.19 -- Import execution.
//
// Runs only after the full pipeline (parse -> normalise -> validate ->
// dedup -> resolve relationships -> preview -> user-confirmed Duplicate
// Review) and only once the job's status is READY_TO_IMPORT (that status
// guard belongs to the route layer -- B.23/B.24 -- and is what makes a
// double-submit a no-op rather than a double-import).
//
// How this file satisfies the spec's execution constraints:
//  - No single giant transaction: work is processed in
//    IMPORT_EXECUTION_CHUNK_SIZE chunks, each its own drizzle transaction,
//    so one bad chunk doesn't roll back everything already committed and a
//    large import doesn't hold one long-lived lock.
//  - Inside a chunk, groups are written with set-based statements (one
//    lookup, one insert, one audit update) instead of a savepoint +
//    statement per group. A bulk write that fails is rolled back to a
//    savepoint and that chunk is retried one group at a time, so one bad
//    row is still recorded and skipped without losing the rest of the chunk.
//  - No full file in memory beyond what earlier stages already held --
//    this module only receives the already-resolved plan (contacts /
//    properties / relationships), never the raw file.
//  - Idempotent / resumable: every write is guarded by the importRecords
//    row's current state. A source row already carrying a resultPartyId /
//    resultPropertyId is skipped -- re-running execute() after a crash or
//    a retried request continues from where it left off instead of
//    double-creating.
//  - Observable: importJobs' running counters are updated after every
//    chunk, so a client polling the job sees live progress.
//  - Auditable: every contact/property/relationship this job creates OR
//    matches is recorded on its source importRecords row(s)
//    (resultPartyId/resultPropertyId/resultRelationshipId,
//    partyWasCreated/propertyWasCreated/relationshipWasCreated,
//    contactResolution/propertyResolution). This is the only traceability
//    mechanism rollback (below) relies on.
//
// Rollback (B.19) -- documented limitation: once an agent has used an
// imported record (added a note, linked an activity, edited a field), an
// automated delete could destroy real work, not just import noise. So
// rollbackImportJob only ever removes rows THIS job created
// (partyWasCreated/propertyWasCreated/relationshipWasCreated = true) AND
// that are still exactly as this job left them (updatedAt === createdAt,
// no dependent growActivities/growOpportunities/growRelationships
// reference the party or property). Anything touched since import is left
// in place and reported as "not rolled back -- has since been used",
// never silently deleted. Matched (not created) existing records are
// NEVER touched by rollback.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  db,
  growActivities,
  growOpportunities,
  growRelationships,
  importJobs,
  importRecords,
  parties,
  properties,
  type GrowRelationshipType,
  type ImportResolution,
} from "@aee/db";

/**
 * Groups per transaction.
 *
 * 100 keeps each transaction to a handful of set-based statements (a lookup,
 * an insert, an audit update) so the lock window stays short, while a 20k-row
 * import still commits 200 times per phase: a crash replays at most 100
 * groups, and a client polling the job still sees progress throughout.
 * 100 groups is also far under Postgres's 65535-parameter limit. The audit
 * update is split again at IMPORT_MARK_ROWS_PER_STATEMENT so one group that
 * collapses thousands of duplicate source rows cannot blow that limit on its
 * own.
 */
export const IMPORT_EXECUTION_CHUNK_SIZE = 100;

/** Source-row tuples per import_records UPDATE. See IMPORT_EXECUTION_CHUNK_SIZE. */
const IMPORT_MARK_ROWS_PER_STATEMENT = 200;

type DbClient = typeof db | Parameters<Parameters<(typeof db)["transaction"]>[0]>[0];

/* ------------------------------------------------------------------ */
/* Plan types -- assembled by the caller from dedup.ts/relationships.ts */
/* output plus the user's confirmed Duplicate Review decisions.        */
/* sourceRowNumbers are ImportRecord.sourceRowNumber values (NOT array  */
/* indices) -- the caller maps NormalisedImportRecord.meta.sourceRow-   */
/* Number for every row in a group before building these plan items.   */
/* ------------------------------------------------------------------ */

export interface ContactExecutionPlanItem {
  groupKey: string;
  resolution: ImportResolution;
  candidatePartyId?: number;
  sourceRowNumbers: number[];
  person: {
    firstName?: string;
    middleName?: string;
    lastName?: string;
    organisationName?: string;
    email?: string;
    mobile?: string;
    residentialAddress?: string;
  };
}

export interface PropertyExecutionPlanItem {
  groupKey: string;
  resolution: ImportResolution;
  candidatePropertyId?: number;
  sourceRowNumbers: number[];
  formattedAddress?: string;
  suburb?: string;
  state?: string;
  postcode?: string;
  isManualAddress: boolean;
}

export interface RelationshipExecutionPlanItem {
  contactGroupKey: string;
  propertyGroupKey: string;
  relationshipType: GrowRelationshipType;
  rawType?: string;
  sourceRowNumbers: number[];
  needsPendingReview: boolean;
  /**
   * AE GROW "Brokerage-wide Signal Sweep" stage 2 -- the observed ownership
   * start date to record on growRelationships.ownershipStartDate, when the
   * source file carried one for an ownership-style relationship. Absent means
   * AE genuinely does not know, and the tenure rule then abstains rather than
   * inventing a tenure from the row's creation timestamp.
   */
  ownershipStart?: { dateIso: string; precision: string; raw: string };
}

export interface ExecuteImportBatchInput {
  importJobId: number;
  brokerageId: number;
  agentId: number; // importing user -- assigned as properties.agentId (NOT NULL) per Stage B.1
  contacts: ContactExecutionPlanItem[];
  contactProperties: PropertyExecutionPlanItem[];
  relationships: RelationshipExecutionPlanItem[];
}

export interface ExecuteImportBatchResult {
  contactsCreated: number;
  contactsUpdated: number;
  propertiesCreated: number;
  propertiesUpdated: number;
  relationshipsCreated: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function sameStored(actual: unknown, expected: unknown): boolean {
  return actual === expected || (actual == null && expected == null);
}

/**
 * Idempotency guard: which source rows has this job already resolved to a
 * real party/property/relationship id? Re-derived from importRecords on
 * every call so a resumed execute() never re-creates something it already
 * created.
 *
 * This is one statement for the job, not one per row. An index on
 * import_records(import_job_id) would make the read an index scan; that
 * index belongs to the separate W1-D index migration and is intentionally
 * not added here.
 */
async function loadAlreadyExecuted(importJobId: number): Promise<{
  contactResultByRow: Map<number, number>;
  propertyResultByRow: Map<number, number>;
  relationshipDoneRows: Set<number>;
}> {
  const rows = await db
    .select({
      sourceRowNumber: importRecords.sourceRowNumber,
      resultPartyId: importRecords.resultPartyId,
      resultPropertyId: importRecords.resultPropertyId,
      resultRelationshipId: importRecords.resultRelationshipId,
    })
    .from(importRecords)
    .where(eq(importRecords.importJobId, importJobId));

  const contactResultByRow = new Map<number, number>();
  const propertyResultByRow = new Map<number, number>();
  const relationshipDoneRows = new Set<number>();
  for (const r of rows) {
    if (r.resultPartyId != null) contactResultByRow.set(r.sourceRowNumber, r.resultPartyId);
    if (r.resultPropertyId != null) propertyResultByRow.set(r.sourceRowNumber, r.resultPropertyId);
    if (r.resultRelationshipId != null) relationshipDoneRows.add(r.sourceRowNumber);
  }
  return { contactResultByRow, propertyResultByRow, relationshipDoneRows };
}

async function markRows(
  client: DbClient,
  importJobId: number,
  sourceRowNumbers: number[],
  patch: Partial<typeof importRecords.$inferInsert>,
): Promise<void> {
  if (sourceRowNumbers.length === 0) return;
  await client
    .update(importRecords)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(importRecords.importJobId, importJobId), inArray(importRecords.sourceRowNumber, sourceRowNumbers)));
}

type ErrorMark = { sourceRowNumbers: number[]; message: string };

/** Last write for a source row wins, matching the previous per-group updates. */
function expandSourceRows<T extends { sourceRowNumbers: number[] }>(
  marks: T[],
): Array<Omit<T, "sourceRowNumbers"> & { sourceRowNumber: number }> {
  const byRow = new Map<number, Omit<T, "sourceRowNumbers"> & { sourceRowNumber: number }>();
  for (const mark of marks) {
    const { sourceRowNumbers, ...rest } = mark;
    for (const sourceRowNumber of sourceRowNumbers) {
      byRow.set(sourceRowNumber, { ...rest, sourceRowNumber });
    }
  }
  return [...byRow.values()];
}

async function flushErrorMarks(client: DbClient, importJobId: number, marks: ErrorMark[]): Promise<void> {
  const rows = expandSourceRows(marks);
  if (rows.length === 0) return;
  const now = new Date();
  for (const slice of chunk(rows, IMPORT_MARK_ROWS_PER_STATEMENT)) {
    const values = sql.join(
      slice.map((row) => sql`(${row.sourceRowNumber}::int, ${JSON.stringify([row.message])}::jsonb)`),
      sql`, `,
    );
    await client.execute(sql`
      UPDATE import_records AS r
      SET status = 'error',
          errors = v.errors,
          updated_at = ${now}
      FROM (VALUES ${values}) AS v(source_row_number, errors)
      WHERE r.import_job_id = ${importJobId}
        AND r.source_row_number = v.source_row_number
    `);
  }
}

async function flushPartyMarks(
  client: DbClient,
  importJobId: number,
  marks: { sourceRowNumbers: number[]; partyId: number; created: boolean }[],
): Promise<void> {
  const rows = expandSourceRows(marks);
  if (rows.length === 0) return;
  const now = new Date();
  for (const slice of chunk(rows, IMPORT_MARK_ROWS_PER_STATEMENT)) {
    const values = sql.join(
      slice.map((row) => sql`(${row.sourceRowNumber}::int, ${row.partyId}::int, ${row.created}::boolean)`),
      sql`, `,
    );
    await client.execute(sql`
      UPDATE import_records AS r
      SET result_party_id = v.party_id,
          party_was_created = v.was_created,
          status = 'imported',
          updated_at = ${now}
      FROM (VALUES ${values}) AS v(source_row_number, party_id, was_created)
      WHERE r.import_job_id = ${importJobId}
        AND r.source_row_number = v.source_row_number
    `);
  }
}

async function flushPropertyMarks(
  client: DbClient,
  importJobId: number,
  marks: { sourceRowNumbers: number[]; propertyId: number; created: boolean }[],
): Promise<void> {
  const rows = expandSourceRows(marks);
  if (rows.length === 0) return;
  const now = new Date();
  for (const slice of chunk(rows, IMPORT_MARK_ROWS_PER_STATEMENT)) {
    const values = sql.join(
      slice.map((row) => sql`(${row.sourceRowNumber}::int, ${row.propertyId}::int, ${row.created}::boolean)`),
      sql`, `,
    );
    await client.execute(sql`
      UPDATE import_records AS r
      SET result_property_id = v.property_id,
          property_was_created = v.was_created,
          status = 'imported',
          updated_at = ${now}
      FROM (VALUES ${values}) AS v(source_row_number, property_id, was_created)
      WHERE r.import_job_id = ${importJobId}
        AND r.source_row_number = v.source_row_number
    `);
  }
}

async function flushRelationshipMarks(
  client: DbClient,
  importJobId: number,
  marks: { sourceRowNumbers: number[]; relationshipId: number; created: boolean }[],
): Promise<void> {
  const rows = expandSourceRows(marks);
  if (rows.length === 0) return;
  const now = new Date();
  for (const slice of chunk(rows, IMPORT_MARK_ROWS_PER_STATEMENT)) {
    const values = sql.join(
      slice.map((row) => sql`(${row.sourceRowNumber}::int, ${row.relationshipId}::int, ${row.created}::boolean)`),
      sql`, `,
    );
    await client.execute(sql`
      UPDATE import_records AS r
      SET result_relationship_id = v.relationship_id,
          relationship_was_created = v.was_created,
          status = 'imported',
          updated_at = ${now}
      FROM (VALUES ${values}) AS v(source_row_number, relationship_id, was_created)
      WHERE r.import_job_id = ${importJobId}
        AND r.source_row_number = v.source_row_number
    `);
  }
}

/* ------------------------------------------------------------------ */
/* Per-group execution -- kept as the fallback when a bulk write fails. */
/* `client` is either `db` or a `db.transaction` callback's `tx`.       */
/* ------------------------------------------------------------------ */

async function executeContactGroup(
  client: DbClient,
  item: ContactExecutionPlanItem,
  brokerageId: number,
  alreadyDone: Map<number, number>,
): Promise<{ partyId?: number; created: boolean }> {
  const doneRow = item.sourceRowNumbers.find((r) => alreadyDone.has(r));
  if (doneRow !== undefined) return { partyId: alreadyDone.get(doneRow), created: false };

  if (item.resolution === "skip") return { created: false };

  if (item.resolution === "use_existing" || item.resolution === "merge") {
    if (!item.candidatePartyId) {
      throw new Error(`Contact group ${item.groupKey}: resolution "${item.resolution}" requires candidatePartyId`);
    }
    const [existing] = await client
      .select()
      .from(parties)
      .where(and(eq(parties.id, item.candidatePartyId), eq(parties.brokerageId, brokerageId)))
      .limit(1);
    if (!existing) {
      throw new Error(`Contact group ${item.groupKey}: candidate party ${item.candidatePartyId} not found in this brokerage`);
    }

    if (item.resolution === "merge") {
      // Fill-gap-only per B.15: an existing non-empty value is never
      // overwritten here. A genuine overwrite is a Duplicate Review
      // decision, not something this engine does on its own.
      const patch: Partial<typeof parties.$inferInsert> = {};
      if (!existing.firstName && item.person.firstName) patch.firstName = item.person.firstName;
      if (!existing.lastName && item.person.lastName) patch.lastName = item.person.lastName;
      if (!existing.email && item.person.email) patch.email = item.person.email;
      if (!existing.mobile && item.person.mobile) patch.mobile = item.person.mobile;
      if (!existing.residentialAddress && item.person.residentialAddress) patch.residentialAddress = item.person.residentialAddress;
      if (Object.keys(patch).length > 0) {
        await client.update(parties).set({ ...patch, updatedAt: new Date() }).where(eq(parties.id, existing.id));
      }
    }
    return { partyId: existing.id, created: false };
  }

  const [created] = await client
    .insert(parties)
    .values({
      brokerageId,
      partyType: item.person.organisationName ? "Organisation" : "Person",
      firstName: item.person.firstName ?? null,
      middleName: item.person.middleName ?? null,
      lastName: item.person.lastName ?? null,
      organisationName: item.person.organisationName ?? null,
      mobile: item.person.mobile ?? null,
      email: item.person.email ?? null,
      residentialAddress: item.person.residentialAddress ?? null,
    })
    .returning({ id: parties.id });
  return { partyId: created.id, created: true };
}

async function executePropertyGroup(
  client: DbClient,
  item: PropertyExecutionPlanItem,
  brokerageId: number,
  agentId: number,
  alreadyDone: Map<number, number>,
): Promise<{ propertyId?: number; created: boolean }> {
  const doneRow = item.sourceRowNumbers.find((r) => alreadyDone.has(r));
  if (doneRow !== undefined) return { propertyId: alreadyDone.get(doneRow), created: false };

  if (item.resolution === "skip") return { created: false };

  if (item.resolution === "use_existing" || item.resolution === "merge") {
    if (!item.candidatePropertyId) {
      throw new Error(`Property group ${item.groupKey}: resolution "${item.resolution}" requires candidatePropertyId`);
    }
    const [existing] = await client
      .select()
      .from(properties)
      .where(and(eq(properties.id, item.candidatePropertyId), eq(properties.brokerageId, brokerageId)))
      .limit(1);
    if (!existing) {
      throw new Error(`Property group ${item.groupKey}: candidate property ${item.candidatePropertyId} not found in this brokerage`);
    }

    if (item.resolution === "merge") {
      const patch: Partial<typeof properties.$inferInsert> = {};
      if (!existing.suburb && item.suburb) patch.suburb = item.suburb;
      if (!existing.state && item.state) patch.state = item.state;
      if (!existing.postcode && item.postcode) patch.postcode = item.postcode;
      if (Object.keys(patch).length > 0) {
        await client.update(properties).set({ ...patch, updatedAt: new Date() }).where(eq(properties.id, existing.id));
      }
    }
    return { propertyId: existing.id, created: false };
  }

  if (!item.formattedAddress) {
    throw new Error(`Property group ${item.groupKey}: create_new requires a formattedAddress`);
  }
  const [created] = await client
    .insert(properties)
    .values({
      brokerageId,
      agentId,
      formattedAddress: item.formattedAddress,
      suburb: item.suburb ?? null,
      state: item.state ?? null,
      postcode: item.postcode ?? null,
      isManualAddress: item.isManualAddress,
    })
    .returning({ id: properties.id });
  return { propertyId: created.id, created: true };
}

async function executeRelationshipLink(
  client: DbClient,
  item: RelationshipExecutionPlanItem,
  partyId: number,
  propertyId: number,
  brokerageId: number,
  agentId: number,
  importJobId: number,
  alreadyDone: Set<number>,
): Promise<{ relationshipId?: number; created: boolean }> {
  const doneRow = item.sourceRowNumbers.find((r) => alreadyDone.has(r));
  if (doneRow !== undefined) return { created: false };

  // Defensive de-dup: an Active relationship already linking this exact
  // (party, property, type) -- whether created by this job or pre-existing --
  // is reused rather than duplicated. Protects against double-submission and
  // against the same real-world relationship appearing twice in the source file.
  const [existing] = await client
    .select({ id: growRelationships.id, ownershipStartDate: growRelationships.ownershipStartDate })
    .from(growRelationships)
    .where(
      and(
        eq(growRelationships.brokerageId, brokerageId),
        eq(growRelationships.partyId, partyId),
        eq(growRelationships.propertyId, propertyId),
        eq(growRelationships.relationshipType, item.relationshipType),
        eq(growRelationships.status, "Active"),
      ),
    )
    .limit(1);
  if (existing) {
    // AE GROW "Brokerage-wide Signal Sweep" stage 2 -- BACK-FILL ONLY.
    // Re-importing a file that now carries a "date acquired" column fills the
    // gap on relationships AE already had, which is the realistic way a
    // brokerage switches the tenure rule on for its existing data. It is
    // strictly a NULL -> value transition: an import can never silently
    // rewrite an ownership start that is already recorded, so nothing an
    // agent is currently looking at changes underneath them.
    if (item.ownershipStart && existing.ownershipStartDate === null) {
      await client
        .update(growRelationships)
        .set({
          ownershipStartDate: new Date(item.ownershipStart.dateIso),
          ownershipStartSource: "import",
          ownershipStartPrecision: item.ownershipStart.precision,
          updatedAt: new Date(),
        })
        .where(and(eq(growRelationships.id, existing.id), eq(growRelationships.brokerageId, brokerageId), isNull(growRelationships.ownershipStartDate)));
    }
    return { relationshipId: existing.id, created: false };
  }

  const [created] = await client
    .insert(growRelationships)
    .values({
      brokerageId,
      partyId,
      propertyId,
      relationshipType: item.relationshipType,
      status: item.needsPendingReview ? "PendingReview" : "Active",
      sourceType: "import",
      sourceId: `${importJobId}:${item.sourceRowNumbers.join(",")}`,
      sourceEvidence: item.rawType ?? null,
      // NOTE: validFrom is deliberately left to its defaultNow(). It means
      // "since when has AE known about this relationship" and that IS import
      // time. The real-world acquisition date is a separate column, set only
      // when the source actually supplied one.
      ownershipStartDate: item.ownershipStart ? new Date(item.ownershipStart.dateIso) : null,
      ownershipStartSource: item.ownershipStart ? "import" : null,
      ownershipStartPrecision: item.ownershipStart ? item.ownershipStart.precision : null,
      createdBy: agentId,
    })
    .returning({ id: growRelationships.id });
  return { relationshipId: created.id, created: true };
}

type PartyGap = {
  id: number;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  mobile: string | null;
  residentialAddress: string | null;
};

function fillPartyGaps(existing: PartyGap, person: ContactExecutionPlanItem["person"]): boolean {
  let changed = false;
  if (!existing.firstName && person.firstName) {
    existing.firstName = person.firstName;
    changed = true;
  }
  if (!existing.lastName && person.lastName) {
    existing.lastName = person.lastName;
    changed = true;
  }
  if (!existing.email && person.email) {
    existing.email = person.email;
    changed = true;
  }
  if (!existing.mobile && person.mobile) {
    existing.mobile = person.mobile;
    changed = true;
  }
  if (!existing.residentialAddress && person.residentialAddress) {
    existing.residentialAddress = person.residentialAddress;
    changed = true;
  }
  return changed;
}

type PropertyGap = {
  id: number;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
};

function fillPropertyGaps(existing: PropertyGap, item: PropertyExecutionPlanItem): boolean {
  let changed = false;
  if (!existing.suburb && item.suburb) {
    existing.suburb = item.suburb;
    changed = true;
  }
  if (!existing.state && item.state) {
    existing.state = item.state;
    changed = true;
  }
  if (!existing.postcode && item.postcode) {
    existing.postcode = item.postcode;
    changed = true;
  }
  return changed;
}

interface ContactChunkDelta {
  created: number;
  updated: number;
  links: { groupKey: string; partyId: number }[];
}

async function flushPartyGapUpdates(client: DbClient, brokerageId: number, rows: PartyGap[]): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date();
  const values = sql.join(
    rows.map(
      (row) =>
        sql`(${row.id}::int, ${row.firstName}::text, ${row.lastName}::text, ${row.email}::text, ${row.mobile}::text, ${row.residentialAddress}::text)`,
    ),
    sql`, `,
  );
  await client.execute(sql`
    UPDATE parties AS p
    SET first_name = v.first_name,
        last_name = v.last_name,
        email = v.email,
        mobile = v.mobile,
        residential_address = v.residential_address,
        updated_at = ${now}
    FROM (VALUES ${values}) AS v(id, first_name, last_name, email, mobile, residential_address)
    WHERE p.id = v.id
      AND p.brokerage_id = ${brokerageId}
  `);
}

async function executeContactChunkBatched(
  client: DbClient,
  batch: ContactExecutionPlanItem[],
  brokerageId: number,
  importJobId: number,
  alreadyDone: Map<number, number>,
): Promise<ContactChunkDelta> {
  const delta: ContactChunkDelta = { created: 0, updated: 0, links: [] };
  const errors: ErrorMark[] = [];
  const partyMarks: { sourceRowNumbers: number[]; partyId: number; created: boolean }[] = [];
  const creates: ContactExecutionPlanItem[] = [];
  const matches: ContactExecutionPlanItem[] = [];

  for (const item of batch) {
    const doneRow = item.sourceRowNumbers.find((row) => alreadyDone.has(row));
    if (doneRow !== undefined) {
      const partyId = alreadyDone.get(doneRow) as number;
      if (item.resolution === "merge") delta.updated += 1;
      delta.links.push({ groupKey: item.groupKey, partyId });
      partyMarks.push({ sourceRowNumbers: item.sourceRowNumbers, partyId, created: false });
      continue;
    }
    if (item.resolution === "skip") continue;
    if (item.resolution === "use_existing" || item.resolution === "merge") {
      if (!item.candidatePartyId) {
        errors.push({
          sourceRowNumbers: item.sourceRowNumbers,
          message: `Contact group ${item.groupKey}: resolution "${item.resolution}" requires candidatePartyId`,
        });
        continue;
      }
      matches.push(item);
      continue;
    }
    creates.push(item);
  }

  if (matches.length > 0) {
    const ids = [...new Set(matches.map((item) => item.candidatePartyId as number))];
    const rows = await client
      .select({
        id: parties.id,
        firstName: parties.firstName,
        lastName: parties.lastName,
        email: parties.email,
        mobile: parties.mobile,
        residentialAddress: parties.residentialAddress,
      })
      .from(parties)
      .where(and(eq(parties.brokerageId, brokerageId), inArray(parties.id, ids)));
    const working = new Map<number, PartyGap>();
    for (const row of rows) working.set(row.id, { ...row });
    const dirty = new Map<number, PartyGap>();

    for (const item of matches) {
      const partyId = item.candidatePartyId as number;
      const existing = working.get(partyId);
      if (!existing) {
        errors.push({
          sourceRowNumbers: item.sourceRowNumbers,
          message: `Contact group ${item.groupKey}: candidate party ${partyId} not found in this brokerage`,
        });
        continue;
      }
      if (item.resolution === "merge") {
        if (fillPartyGaps(existing, item.person)) dirty.set(partyId, existing);
        delta.updated += 1;
      }
      delta.links.push({ groupKey: item.groupKey, partyId });
      partyMarks.push({ sourceRowNumbers: item.sourceRowNumbers, partyId, created: false });
    }
    await flushPartyGapUpdates(client, brokerageId, [...dirty.values()]);
  }

  if (creates.length > 0) {
    const values = creates.map((item) => ({
      brokerageId,
      partyType: (item.person.organisationName ? "Organisation" : "Person") as "Organisation" | "Person",
      firstName: item.person.firstName ?? null,
      middleName: item.person.middleName ?? null,
      lastName: item.person.lastName ?? null,
      organisationName: item.person.organisationName ?? null,
      mobile: item.person.mobile ?? null,
      email: item.person.email ?? null,
      residentialAddress: item.person.residentialAddress ?? null,
    }));
    const inserted = await client.insert(parties).values(values).returning({
      id: parties.id,
      partyType: parties.partyType,
      firstName: parties.firstName,
      middleName: parties.middleName,
      lastName: parties.lastName,
      organisationName: parties.organisationName,
      mobile: parties.mobile,
      email: parties.email,
      residentialAddress: parties.residentialAddress,
    });
    if (inserted.length !== values.length) {
      throw new Error(`Contact insert returned ${inserted.length} rows for ${values.length} groups`);
    }
    for (let i = 0; i < values.length; i++) {
      const row = inserted[i];
      const expected = values[i];
      if (
        !row ||
        !expected ||
        !sameStored(row.partyType, expected.partyType) ||
        !sameStored(row.firstName, expected.firstName) ||
        !sameStored(row.middleName, expected.middleName) ||
        !sameStored(row.lastName, expected.lastName) ||
        !sameStored(row.organisationName, expected.organisationName) ||
        !sameStored(row.mobile, expected.mobile) ||
        !sameStored(row.email, expected.email) ||
        !sameStored(row.residentialAddress, expected.residentialAddress)
      ) {
        throw new Error("Contact insert returning order did not match the batch");
      }
    }
    for (let i = 0; i < creates.length; i++) {
      const item = creates[i];
      const partyId = inserted[i]?.id;
      if (!item || partyId === undefined) throw new Error("Contact insert returned no id");
      delta.created += 1;
      delta.links.push({ groupKey: item.groupKey, partyId });
      partyMarks.push({ sourceRowNumbers: item.sourceRowNumbers, partyId, created: true });
    }
  }

  await flushPartyMarks(client, importJobId, partyMarks);
  await flushErrorMarks(client, importJobId, errors);
  return delta;
}

async function executeContactChunkPerRow(
  client: DbClient,
  batch: ContactExecutionPlanItem[],
  brokerageId: number,
  importJobId: number,
  alreadyDone: Map<number, number>,
  result: ExecuteImportBatchResult,
  contactPartyIdByGroup: Map<string, number>,
): Promise<void> {
  for (const item of batch) {
    try {
      const { partyId, created } = await client.transaction((tx2) =>
        executeContactGroup(tx2, item, brokerageId, alreadyDone),
      );
      if (partyId !== undefined) {
        contactPartyIdByGroup.set(item.groupKey, partyId);
        if (created) result.contactsCreated += 1;
        else if (item.resolution === "merge") result.contactsUpdated += 1;
        await markRows(client, importJobId, item.sourceRowNumbers, {
          resultPartyId: partyId,
          partyWasCreated: created,
          status: "imported",
        });
      }
    } catch (err) {
      await markRows(client, importJobId, item.sourceRowNumbers, {
        status: "error",
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }
}

interface PropertyChunkDelta {
  created: number;
  updated: number;
  links: { groupKey: string; propertyId: number }[];
}

async function flushPropertyGapUpdates(client: DbClient, brokerageId: number, rows: PropertyGap[]): Promise<void> {
  if (rows.length === 0) return;
  const now = new Date();
  const values = sql.join(
    rows.map((row) => sql`(${row.id}::int, ${row.suburb}::text, ${row.state}::text, ${row.postcode}::text)`),
    sql`, `,
  );
  await client.execute(sql`
    UPDATE properties AS p
    SET suburb = v.suburb,
        state = v.state,
        postcode = v.postcode,
        updated_at = ${now}
    FROM (VALUES ${values}) AS v(id, suburb, state, postcode)
    WHERE p.id = v.id
      AND p.brokerage_id = ${brokerageId}
  `);
}

async function executePropertyChunkBatched(
  client: DbClient,
  batch: PropertyExecutionPlanItem[],
  brokerageId: number,
  agentId: number,
  importJobId: number,
  alreadyDone: Map<number, number>,
): Promise<PropertyChunkDelta> {
  const delta: PropertyChunkDelta = { created: 0, updated: 0, links: [] };
  const errors: ErrorMark[] = [];
  const propertyMarks: { sourceRowNumbers: number[]; propertyId: number; created: boolean }[] = [];
  const creates: PropertyExecutionPlanItem[] = [];
  const matches: PropertyExecutionPlanItem[] = [];

  for (const item of batch) {
    const doneRow = item.sourceRowNumbers.find((row) => alreadyDone.has(row));
    if (doneRow !== undefined) {
      const propertyId = alreadyDone.get(doneRow) as number;
      if (item.resolution === "merge") delta.updated += 1;
      delta.links.push({ groupKey: item.groupKey, propertyId });
      propertyMarks.push({ sourceRowNumbers: item.sourceRowNumbers, propertyId, created: false });
      continue;
    }
    if (item.resolution === "skip") continue;
    if (item.resolution === "use_existing" || item.resolution === "merge") {
      if (!item.candidatePropertyId) {
        errors.push({
          sourceRowNumbers: item.sourceRowNumbers,
          message: `Property group ${item.groupKey}: resolution "${item.resolution}" requires candidatePropertyId`,
        });
        continue;
      }
      matches.push(item);
      continue;
    }
    if (!item.formattedAddress) {
      errors.push({
        sourceRowNumbers: item.sourceRowNumbers,
        message: `Property group ${item.groupKey}: create_new requires a formattedAddress`,
      });
      continue;
    }
    creates.push(item);
  }

  if (matches.length > 0) {
    const ids = [...new Set(matches.map((item) => item.candidatePropertyId as number))];
    const rows = await client
      .select({
        id: properties.id,
        suburb: properties.suburb,
        state: properties.state,
        postcode: properties.postcode,
      })
      .from(properties)
      .where(and(eq(properties.brokerageId, brokerageId), inArray(properties.id, ids)));
    const working = new Map<number, PropertyGap>();
    for (const row of rows) working.set(row.id, { ...row });
    const dirty = new Map<number, PropertyGap>();

    for (const item of matches) {
      const propertyId = item.candidatePropertyId as number;
      const existing = working.get(propertyId);
      if (!existing) {
        errors.push({
          sourceRowNumbers: item.sourceRowNumbers,
          message: `Property group ${item.groupKey}: candidate property ${propertyId} not found in this brokerage`,
        });
        continue;
      }
      if (item.resolution === "merge") {
        if (fillPropertyGaps(existing, item)) dirty.set(propertyId, existing);
        delta.updated += 1;
      }
      delta.links.push({ groupKey: item.groupKey, propertyId });
      propertyMarks.push({ sourceRowNumbers: item.sourceRowNumbers, propertyId, created: false });
    }
    await flushPropertyGapUpdates(client, brokerageId, [...dirty.values()]);
  }

  if (creates.length > 0) {
    const values = creates.map((item) => ({
      brokerageId,
      agentId,
      formattedAddress: item.formattedAddress as string,
      suburb: item.suburb ?? null,
      state: item.state ?? null,
      postcode: item.postcode ?? null,
      isManualAddress: item.isManualAddress,
    }));
    const inserted = await client.insert(properties).values(values).returning({
      id: properties.id,
      formattedAddress: properties.formattedAddress,
      suburb: properties.suburb,
      state: properties.state,
      postcode: properties.postcode,
      isManualAddress: properties.isManualAddress,
      agentId: properties.agentId,
    });
    if (inserted.length !== values.length) {
      throw new Error(`Property insert returned ${inserted.length} rows for ${values.length} groups`);
    }
    for (let i = 0; i < values.length; i++) {
      const row = inserted[i];
      const expected = values[i];
      if (
        !row ||
        !expected ||
        !sameStored(row.formattedAddress, expected.formattedAddress) ||
        !sameStored(row.suburb, expected.suburb) ||
        !sameStored(row.state, expected.state) ||
        !sameStored(row.postcode, expected.postcode) ||
        row.isManualAddress !== expected.isManualAddress ||
        row.agentId !== expected.agentId
      ) {
        throw new Error("Property insert returning order did not match the batch");
      }
    }
    for (let i = 0; i < creates.length; i++) {
      const item = creates[i];
      const propertyId = inserted[i]?.id;
      if (!item || propertyId === undefined) throw new Error("Property insert returned no id");
      delta.created += 1;
      delta.links.push({ groupKey: item.groupKey, propertyId });
      propertyMarks.push({ sourceRowNumbers: item.sourceRowNumbers, propertyId, created: true });
    }
  }

  await flushPropertyMarks(client, importJobId, propertyMarks);
  await flushErrorMarks(client, importJobId, errors);
  return delta;
}

async function executePropertyChunkPerRow(
  client: DbClient,
  batch: PropertyExecutionPlanItem[],
  brokerageId: number,
  agentId: number,
  importJobId: number,
  alreadyDone: Map<number, number>,
  result: ExecuteImportBatchResult,
  propertyIdByGroup: Map<string, number>,
): Promise<void> {
  for (const item of batch) {
    try {
      const { propertyId, created } = await client.transaction((tx2) =>
        executePropertyGroup(tx2, item, brokerageId, agentId, alreadyDone),
      );
      if (propertyId !== undefined) {
        propertyIdByGroup.set(item.groupKey, propertyId);
        if (created) result.propertiesCreated += 1;
        else if (item.resolution === "merge") result.propertiesUpdated += 1;
        await markRows(client, importJobId, item.sourceRowNumbers, {
          resultPropertyId: propertyId,
          propertyWasCreated: created,
          status: "imported",
        });
      }
    } catch (err) {
      await markRows(client, importJobId, item.sourceRowNumbers, {
        status: "error",
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }
}

function relationshipKey(partyId: number, propertyId: number, relationshipType: string): string {
  return `${partyId}\0${propertyId}\0${relationshipType}`;
}

interface ActiveSlot {
  id: number | null;
  pendingIndex: number | null;
  ownershipStartDate: Date | null;
}

async function flushOwnershipBackfills(
  client: DbClient,
  brokerageId: number,
  rows: { id: number; dateIso: string; precision: string }[],
): Promise<void> {
  const byId = new Map<number, { id: number; dateIso: string; precision: string }>();
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
  const unique = [...byId.values()];
  if (unique.length === 0) return;
  // grow_relationships.ownership_start_date and updated_at are `timestamp`
  // (without time zone) holding UTC wall-clock, the convention Drizzle's own
  // column mapping uses (Date -> toISOString()). A JS Date bound into raw SQL
  // is serialised by node-postgres in the PROCESS-LOCAL zone with an offset,
  // and a ::timestamp cast (or the implicit assignment cast) silently drops
  // that offset, so a non-UTC server would store local wall-clock. Bind the
  // instant as an ISO-8601 UTC string, read it as timestamptz (offset kept),
  // and convert to UTC wall-clock explicitly; independent of both the Node
  // process TZ and the database session TimeZone.
  const nowIso = new Date().toISOString();
  const values = sql.join(
    unique.map(
      (row) =>
        sql`(${row.id}::int, (${new Date(row.dateIso).toISOString()}::timestamptz AT TIME ZONE 'UTC'), ${row.precision}::text)`,
    ),
    sql`, `,
  );
  await client.execute(sql`
    UPDATE grow_relationships AS g
    SET ownership_start_date = v.ownership_start_date,
        ownership_start_source = 'import',
        ownership_start_precision = v.start_precision,
        updated_at = (${nowIso}::timestamptz AT TIME ZONE 'UTC')
    FROM (VALUES ${values}) AS v(id, ownership_start_date, start_precision)
    WHERE g.id = v.id
      AND g.brokerage_id = ${brokerageId}
      AND g.ownership_start_date IS NULL
  `);
}

async function executeRelationshipChunkBatched(
  client: DbClient,
  batch: RelationshipExecutionPlanItem[],
  brokerageId: number,
  agentId: number,
  importJobId: number,
  alreadyDone: Set<number>,
  contactPartyIdByGroup: Map<string, number>,
  propertyIdByGroup: Map<string, number>,
): Promise<{ created: number }> {
  const errors: ErrorMark[] = [];
  const work: { item: RelationshipExecutionPlanItem; partyId: number; propertyId: number }[] = [];

  for (const item of batch) {
    const partyId = contactPartyIdByGroup.get(item.contactGroupKey);
    const propertyId = propertyIdByGroup.get(item.propertyGroupKey);
    if (partyId === undefined || propertyId === undefined) {
      errors.push({
        sourceRowNumbers: item.sourceRowNumbers,
        message: `Relationship could not resolve its ${partyId === undefined ? "contact" : "property"} group (${
          partyId === undefined ? item.contactGroupKey : item.propertyGroupKey
        })`,
      });
      continue;
    }
    const doneRow = item.sourceRowNumbers.find((row) => alreadyDone.has(row));
    if (doneRow !== undefined) continue;
    work.push({ item, partyId, propertyId });
  }

  const activeByKey = new Map<string, ActiveSlot>();
  if (work.length > 0) {
    const partyIds = [...new Set(work.map((row) => row.partyId))];
    const propertyIds = [...new Set(work.map((row) => row.propertyId))];
    const types = [...new Set(work.map((row) => row.item.relationshipType))];
    const existing = await client
      .select({
        id: growRelationships.id,
        partyId: growRelationships.partyId,
        propertyId: growRelationships.propertyId,
        relationshipType: growRelationships.relationshipType,
        ownershipStartDate: growRelationships.ownershipStartDate,
      })
      .from(growRelationships)
      .where(
        and(
          eq(growRelationships.brokerageId, brokerageId),
          eq(growRelationships.status, "Active"),
          inArray(growRelationships.partyId, partyIds),
          inArray(growRelationships.propertyId, propertyIds),
          inArray(growRelationships.relationshipType, types),
        ),
      );
    for (const row of existing) {
      if (row.propertyId == null) continue;
      const key = relationshipKey(row.partyId, row.propertyId, row.relationshipType);
      if (!activeByKey.has(key)) {
        activeByKey.set(key, { id: row.id, pendingIndex: null, ownershipStartDate: row.ownershipStartDate });
      }
    }
  }

  const inserts: { item: RelationshipExecutionPlanItem; partyId: number; propertyId: number }[] = [];
  const backfills: { id?: number; pendingIndex?: number; dateIso: string; precision: string }[] = [];
  const links: {
    item: RelationshipExecutionPlanItem;
    relationshipId: number | null;
    pendingIndex: number | null;
    created: boolean;
  }[] = [];

  for (const row of work) {
    const key = relationshipKey(row.partyId, row.propertyId, row.item.relationshipType);
    const slot = activeByKey.get(key);
    if (slot) {
      if (row.item.ownershipStart && slot.ownershipStartDate === null) {
        backfills.push({
          id: slot.id ?? undefined,
          pendingIndex: slot.pendingIndex ?? undefined,
          dateIso: row.item.ownershipStart.dateIso,
          precision: row.item.ownershipStart.precision,
        });
        slot.ownershipStartDate = new Date(row.item.ownershipStart.dateIso);
      }
      links.push({
        item: row.item,
        relationshipId: slot.id,
        pendingIndex: slot.pendingIndex,
        created: false,
      });
      continue;
    }

    const pendingIndex = inserts.length;
    inserts.push(row);
    if (!row.item.needsPendingReview) {
      activeByKey.set(key, {
        id: null,
        pendingIndex,
        ownershipStartDate: row.item.ownershipStart ? new Date(row.item.ownershipStart.dateIso) : null,
      });
    }
    links.push({ item: row.item, relationshipId: null, pendingIndex, created: true });
  }

  const pendingIds: number[] = [];
  if (inserts.length > 0) {
    const values = inserts.map((row) => ({
      brokerageId,
      partyId: row.partyId,
      propertyId: row.propertyId,
      relationshipType: row.item.relationshipType,
      status: row.item.needsPendingReview ? "PendingReview" : "Active",
      sourceType: "import" as const,
      sourceId: `${importJobId}:${row.item.sourceRowNumbers.join(",")}`,
      sourceEvidence: row.item.rawType ?? null,
      ownershipStartDate: row.item.ownershipStart ? new Date(row.item.ownershipStart.dateIso) : null,
      ownershipStartSource: row.item.ownershipStart ? "import" : null,
      ownershipStartPrecision: row.item.ownershipStart ? row.item.ownershipStart.precision : null,
      createdBy: agentId,
    }));
    const inserted = await client.insert(growRelationships).values(values).returning({
      id: growRelationships.id,
      partyId: growRelationships.partyId,
      propertyId: growRelationships.propertyId,
      relationshipType: growRelationships.relationshipType,
      status: growRelationships.status,
      sourceId: growRelationships.sourceId,
    });
    if (inserted.length !== values.length) {
      throw new Error(`Relationship insert returned ${inserted.length} rows for ${values.length} groups`);
    }
    for (let i = 0; i < values.length; i++) {
      const actual = inserted[i];
      const expected = values[i];
      if (
        !actual ||
        !expected ||
        actual.partyId !== expected.partyId ||
        actual.propertyId !== expected.propertyId ||
        actual.relationshipType !== expected.relationshipType ||
        actual.status !== expected.status ||
        actual.sourceId !== expected.sourceId
      ) {
        throw new Error("Relationship insert returning order did not match the batch");
      }
      pendingIds.push(actual.id);
    }
  }

  const resolvedBackfills: { id: number; dateIso: string; precision: string }[] = [];
  for (const backfill of backfills) {
    const id = backfill.id ?? (backfill.pendingIndex != null ? pendingIds[backfill.pendingIndex] : undefined);
    if (id === undefined) throw new Error("Ownership backfill could not resolve a relationship id");
    resolvedBackfills.push({ id, dateIso: backfill.dateIso, precision: backfill.precision });
  }
  await flushOwnershipBackfills(client, brokerageId, resolvedBackfills);

  const relationshipMarks: { sourceRowNumbers: number[]; relationshipId: number; created: boolean }[] = [];
  let created = 0;
  for (const link of links) {
    const relationshipId = link.relationshipId ?? (link.pendingIndex != null ? pendingIds[link.pendingIndex] : undefined);
    if (relationshipId === undefined) throw new Error("Relationship link could not resolve an id");
    if (link.created) created += 1;
    relationshipMarks.push({
      sourceRowNumbers: link.item.sourceRowNumbers,
      relationshipId,
      created: link.created,
    });
  }

  await flushRelationshipMarks(client, importJobId, relationshipMarks);
  await flushErrorMarks(client, importJobId, errors);
  return { created };
}

async function executeRelationshipChunkPerRow(
  client: DbClient,
  batch: RelationshipExecutionPlanItem[],
  brokerageId: number,
  agentId: number,
  importJobId: number,
  alreadyDone: Set<number>,
  contactPartyIdByGroup: Map<string, number>,
  propertyIdByGroup: Map<string, number>,
  result: ExecuteImportBatchResult,
): Promise<void> {
  for (const item of batch) {
    const partyId = contactPartyIdByGroup.get(item.contactGroupKey);
    const propertyId = propertyIdByGroup.get(item.propertyGroupKey);
    if (partyId === undefined || propertyId === undefined) {
      await markRows(client, importJobId, item.sourceRowNumbers, {
        status: "error",
        errors: [
          `Relationship could not resolve its ${partyId === undefined ? "contact" : "property"} group (${
            partyId === undefined ? item.contactGroupKey : item.propertyGroupKey
          })`,
        ],
      });
      continue;
    }
    try {
      const { relationshipId, created } = await client.transaction((tx2) =>
        executeRelationshipLink(tx2, item, partyId, propertyId, brokerageId, agentId, importJobId, alreadyDone),
      );
      if (relationshipId !== undefined) {
        if (created) result.relationshipsCreated += 1;
        await markRows(client, importJobId, item.sourceRowNumbers, {
          resultRelationshipId: relationshipId,
          relationshipWasCreated: created,
          status: "imported",
        });
      }
    } catch (err) {
      await markRows(client, importJobId, item.sourceRowNumbers, {
        status: "error",
        errors: [err instanceof Error ? err.message : String(err)],
      });
    }
  }
}

/**
 * B.16-19 orchestrator. Processes contacts, then properties, then relationships
 * (in that order -- relationships need both sides' real ids first), each in
 * IMPORT_EXECUTION_CHUNK_SIZE chunks, each chunk its own db.transaction().
 * importJobs' running counters are persisted after every chunk so a client
 * polling the job sees live progress, and every resolved/errored row is
 * written back to importRecords immediately -- this is both the audit trail
 * and the resumability checkpoint loadAlreadyExecuted() reads on a re-run.
 */
export async function executeImportBatch(input: ExecuteImportBatchInput): Promise<ExecuteImportBatchResult> {
  const { importJobId, brokerageId, agentId, contacts, contactProperties, relationships } = input;

  const [job] = await db
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.id, importJobId), eq(importJobs.brokerageId, brokerageId)))
    .limit(1);
  if (!job) throw new Error(`Import job ${importJobId} not found in this brokerage`);

  const already = await loadAlreadyExecuted(importJobId);
  const contactPartyIdByGroup = new Map<string, number>();
  const propertyIdByGroup = new Map<string, number>();

  const result: ExecuteImportBatchResult = {
    contactsCreated: 0,
    contactsUpdated: 0,
    propertiesCreated: 0,
    propertiesUpdated: 0,
    relationshipsCreated: 0,
  };

  await db
    .update(importJobs)
    .set({ status: "IMPORTING", startedAt: job.startedAt ?? new Date(), updatedAt: new Date() })
    .where(eq(importJobs.id, importJobId));

  // Resuming a previously-interrupted run: re-seed the group -> id maps from what
  // importRecords already shows as resolved, so a chunk that is NOT re-executed
  // (because every row in it was already marked imported) still leaves its group
  // key resolvable for the property/relationship passes below.
  for (const item of contacts) {
    const doneRow = item.sourceRowNumbers.find((r) => already.contactResultByRow.has(r));
    if (doneRow !== undefined) {
      contactPartyIdByGroup.set(item.groupKey, already.contactResultByRow.get(doneRow) as number);
    }
  }
  for (const item of contactProperties) {
    const doneRow = item.sourceRowNumbers.find((r) => already.propertyResultByRow.has(r));
    if (doneRow !== undefined) {
      propertyIdByGroup.set(item.groupKey, already.propertyResultByRow.get(doneRow) as number);
    }
  }

  // --- Contacts ---
  for (const batch of chunk(contacts, IMPORT_EXECUTION_CHUNK_SIZE)) {
    await db.transaction(async (tx) => {
      try {
        const delta = await tx.transaction((tx2) =>
          executeContactChunkBatched(tx2, batch, brokerageId, importJobId, already.contactResultByRow),
        );
        result.contactsCreated += delta.created;
        result.contactsUpdated += delta.updated;
        for (const link of delta.links) contactPartyIdByGroup.set(link.groupKey, link.partyId);
      } catch {
        // Bulk write failed, or the inserted rows could not be lined up with
        // the plan. The savepoint rolled those writes back; repeat the chunk
        // one group at a time so one bad row is recorded and the others commit.
        await executeContactChunkPerRow(
          tx,
          batch,
          brokerageId,
          importJobId,
          already.contactResultByRow,
          result,
          contactPartyIdByGroup,
        );
      }
    });
    await db
      .update(importJobs)
      .set({ contactsCreated: result.contactsCreated, contactsUpdated: result.contactsUpdated, updatedAt: new Date() })
      .where(eq(importJobs.id, importJobId));
  }

  // --- Properties ---
  for (const batch of chunk(contactProperties, IMPORT_EXECUTION_CHUNK_SIZE)) {
    await db.transaction(async (tx) => {
      try {
        const delta = await tx.transaction((tx2) =>
          executePropertyChunkBatched(tx2, batch, brokerageId, agentId, importJobId, already.propertyResultByRow),
        );
        result.propertiesCreated += delta.created;
        result.propertiesUpdated += delta.updated;
        for (const link of delta.links) propertyIdByGroup.set(link.groupKey, link.propertyId);
      } catch {
        // See the contact chunk: savepoint already rolled the bulk write back.
        await executePropertyChunkPerRow(
          tx,
          batch,
          brokerageId,
          agentId,
          importJobId,
          already.propertyResultByRow,
          result,
          propertyIdByGroup,
        );
      }
    });
    await db
      .update(importJobs)
      .set({ propertiesCreated: result.propertiesCreated, propertiesUpdated: result.propertiesUpdated, updatedAt: new Date() })
      .where(eq(importJobs.id, importJobId));
  }

  // --- Relationships (needs both sides resolved above) ---
  for (const batch of chunk(relationships, IMPORT_EXECUTION_CHUNK_SIZE)) {
    await db.transaction(async (tx) => {
      try {
        const delta = await tx.transaction((tx2) =>
          executeRelationshipChunkBatched(
            tx2,
            batch,
            brokerageId,
            agentId,
            importJobId,
            already.relationshipDoneRows,
            contactPartyIdByGroup,
            propertyIdByGroup,
          ),
        );
        result.relationshipsCreated += delta.created;
      } catch {
        // See the contact chunk: savepoint already rolled the bulk write back.
        await executeRelationshipChunkPerRow(
          tx,
          batch,
          brokerageId,
          agentId,
          importJobId,
          already.relationshipDoneRows,
          contactPartyIdByGroup,
          propertyIdByGroup,
          result,
        );
      }
    });
    await db
      .update(importJobs)
      .set({ relationshipsCreated: result.relationshipsCreated, updatedAt: new Date() })
      .where(eq(importJobs.id, importJobId));
  }

  await db
    .update(importJobs)
    .set({ status: "COMPLETED", completedAt: new Date(), updatedAt: new Date() })
    .where(eq(importJobs.id, importJobId));

  return result;
}

export interface RollbackReportEntry {
  kind: "party" | "property" | "relationship";
  id: number;
  rolledBack: boolean;
  reason?: string;
}

export interface RollbackResult {
  importJobId: number;
  entries: RollbackReportEntry[];
}

function addReferencedIds(target: Set<number>, ids: Array<number | null>): void {
  for (const id of ids) if (id != null) target.add(id);
}

/**
 * B.19 rollback -- see the header comment at the top of this file for the full
 * safety rule. Order matters: relationships this job created are removed first
 * (unconditionally -- nothing else can depend on a grow_relationships row), then
 * properties, then parties, each gated on "untouched since import" AND "nothing
 * still references it". Every row this job touched is reported, never silently
 * skipped -- a false "rolled back" would be worse than an honest "not rolled
 * back, has since been used".
 *
 * Property and party decisions are still one report entry per id, in the same
 * order, with the same reasons. The existence and "still referenced" checks
 * are read once per chunk instead of once per id.
 */
export async function rollbackImportJob(importJobId: number, brokerageId: number): Promise<RollbackResult> {
  const [job] = await db
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.id, importJobId), eq(importJobs.brokerageId, brokerageId)))
    .limit(1);
  if (!job) throw new Error(`Import job ${importJobId} not found in this brokerage`);

  const rows = await db.select().from(importRecords).where(eq(importRecords.importJobId, importJobId));
  const entries: RollbackReportEntry[] = [];

  const relationshipIds = [
    ...new Set(
      rows.filter((r) => r.relationshipWasCreated && r.resultRelationshipId != null).map((r) => r.resultRelationshipId as number),
    ),
  ];
  for (const idBatch of chunk(relationshipIds, IMPORT_EXECUTION_CHUNK_SIZE)) {
    if (idBatch.length === 0) continue;
    // importRecords.resultRelationshipId FKs to growRelationships.id with no
    // cascade -- clear the audit link before deleting the row it points to,
    // or the delete below fails a foreign-key constraint.
    await db
      .update(importRecords)
      .set({ resultRelationshipId: null })
      .where(and(eq(importRecords.importJobId, importJobId), inArray(importRecords.resultRelationshipId, idBatch)));
    await db
      .delete(growRelationships)
      .where(and(inArray(growRelationships.id, idBatch), eq(growRelationships.brokerageId, brokerageId)));
  }
  for (const id of relationshipIds) entries.push({ kind: "relationship", id, rolledBack: true });

  const propertyIds = [
    ...new Set(rows.filter((r) => r.propertyWasCreated && r.resultPropertyId != null).map((r) => r.resultPropertyId as number)),
  ];
  for (const idBatch of chunk(propertyIds, IMPORT_EXECUTION_CHUNK_SIZE)) {
    const found = await db
      .select()
      .from(properties)
      .where(and(inArray(properties.id, idBatch), eq(properties.brokerageId, brokerageId)));
    const byId = new Map(found.map((row) => [row.id, row]));
    const referenced = new Set<number>();
    const [rels, acts, opps] = await Promise.all([
      db.select({ id: growRelationships.propertyId }).from(growRelationships).where(inArray(growRelationships.propertyId, idBatch)),
      db.select({ id: growActivities.propertyId }).from(growActivities).where(inArray(growActivities.propertyId, idBatch)),
      db.select({ id: growOpportunities.propertyId }).from(growOpportunities).where(inArray(growOpportunities.propertyId, idBatch)),
    ]);
    addReferencedIds(referenced, rels.map((row) => row.id));
    addReferencedIds(referenced, acts.map((row) => row.id));
    addReferencedIds(referenced, opps.map((row) => row.id));

    const deletable: number[] = [];
    for (const id of idBatch) {
      const prop = byId.get(id);
      if (!prop) {
        entries.push({ kind: "property", id, rolledBack: false, reason: "not found in this brokerage" });
        continue;
      }
      if (prop.updatedAt.getTime() !== prop.createdAt.getTime()) {
        entries.push({ kind: "property", id, rolledBack: false, reason: "modified since import -- not rolled back" });
        continue;
      }
      if (referenced.has(id)) {
        entries.push({ kind: "property", id, rolledBack: false, reason: "has since been used -- referenced by other Grow records" });
        continue;
      }
      deletable.push(id);
      entries.push({ kind: "property", id, rolledBack: true });
    }
    if (deletable.length > 0) {
      // Same FK-before-delete ordering as relationships above.
      await db
        .update(importRecords)
        .set({ resultPropertyId: null })
        .where(and(eq(importRecords.importJobId, importJobId), inArray(importRecords.resultPropertyId, deletable)));
      await db.delete(properties).where(inArray(properties.id, deletable));
    }
  }

  const partyIds = [
    ...new Set(rows.filter((r) => r.partyWasCreated && r.resultPartyId != null).map((r) => r.resultPartyId as number)),
  ];
  for (const idBatch of chunk(partyIds, IMPORT_EXECUTION_CHUNK_SIZE)) {
    const found = await db
      .select()
      .from(parties)
      .where(and(inArray(parties.id, idBatch), eq(parties.brokerageId, brokerageId)));
    const byId = new Map(found.map((row) => [row.id, row]));
    const referenced = new Set<number>();
    const [rels, acts, opps] = await Promise.all([
      db.select({ id: growRelationships.partyId }).from(growRelationships).where(inArray(growRelationships.partyId, idBatch)),
      db.select({ id: growActivities.partyId }).from(growActivities).where(inArray(growActivities.partyId, idBatch)),
      db.select({ id: growOpportunities.partyId }).from(growOpportunities).where(inArray(growOpportunities.partyId, idBatch)),
    ]);
    addReferencedIds(referenced, rels.map((row) => row.id));
    addReferencedIds(referenced, acts.map((row) => row.id));
    addReferencedIds(referenced, opps.map((row) => row.id));

    const deletable: number[] = [];
    for (const id of idBatch) {
      const party = byId.get(id);
      if (!party) {
        entries.push({ kind: "party", id, rolledBack: false, reason: "not found in this brokerage" });
        continue;
      }
      if (party.updatedAt.getTime() !== party.createdAt.getTime()) {
        entries.push({ kind: "party", id, rolledBack: false, reason: "modified since import -- not rolled back" });
        continue;
      }
      if (referenced.has(id)) {
        entries.push({ kind: "party", id, rolledBack: false, reason: "has since been used -- referenced by other Grow records" });
        continue;
      }
      deletable.push(id);
      entries.push({ kind: "party", id, rolledBack: true });
    }
    if (deletable.length > 0) {
      // Same FK-before-delete ordering as relationships/properties above.
      await db
        .update(importRecords)
        .set({ resultPartyId: null })
        .where(and(eq(importRecords.importJobId, importJobId), inArray(importRecords.resultPartyId, deletable)));
      await db.delete(parties).where(inArray(parties.id, deletable));
    }
  }

  await db.update(importJobs).set({ status: "ROLLED_BACK", updatedAt: new Date() }).where(eq(importJobs.id, importJobId));

  return { importJobId, entries };
}
