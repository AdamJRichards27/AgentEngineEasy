// Stage B.16-B.19 -- Import execution.
//
// Runs only after the full pipeline (parse -> normalise -> validate ->
// dedup -> resolve relationships -> preview -> user-confirmed Duplicate
// Review) and only once the job's status is READY_TO_IMPORT (that status
// guard belongs to the route layer -- B.23/B.24 -- and is what makes a
// double-submit a no-op rather than a double-import).
//
// How this file satisfies the spec's execution constraints:
//  - No single giant transaction: work is processed in small BATCH_SIZE
//    chunks, each its own drizzle transaction, so one bad chunk doesn't
//    roll back everything already committed and a large import doesn't
//    hold one long-lived lock.
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

import { and, eq, inArray } from "drizzle-orm";
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

const BATCH_SIZE = 25; // groups per transaction -- keeps each transaction short-lived even for a large import

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

/**
 * Idempotency guard: which source rows has this job already resolved to a
 * real party/property/relationship id? Re-derived from importRecords on
 * every call so a resumed execute() never re-creates something it already
 * created.
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

/* ------------------------------------------------------------------ */
/* Per-group execution -- `client` is either `db` or a `db.transaction`  */
/* callback's `tx`, so callers control exactly what's atomic together.  */
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
    .select({ id: growRelationships.id })
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
  if (existing) return { relationshipId: existing.id, created: false };

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
      createdBy: agentId,
    })
    .returning({ id: growRelationships.id });
  return { relationshipId: created.id, created: true };
}

/**
 * B.16-19 orchestrator. Processes contacts, then properties, then relationships
 * (in that order -- relationships need both sides' real ids first), each in
 * BATCH_SIZE chunks, each chunk its own db.transaction(). Within a chunk, each
 * row additionally runs in its own nested transaction (a Postgres SAVEPOINT via
 * Drizzle) so one bad row is recorded as an error and skipped without rolling
 * back the other rows already committed in the same chunk. importJobs' running
 * counters are persisted after every chunk so a client polling the job sees
 * live progress, and every resolved/errored row is written back to importRecords
 * immediately -- this is both the audit trail and the resumability checkpoint
 * loadAlreadyExecuted() reads on a re-run.
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
  for (const batch of chunk(contacts, BATCH_SIZE)) {
    await db.transaction(async (tx) => {
      for (const item of batch) {
        try {
          const { partyId, created } = await tx.transaction((tx2) =>
            executeContactGroup(tx2, item, brokerageId, already.contactResultByRow),
          );
          if (partyId !== undefined) {
            contactPartyIdByGroup.set(item.groupKey, partyId);
            if (created) result.contactsCreated += 1;
            else if (item.resolution === "merge") result.contactsUpdated += 1;
            await markRows(tx, importJobId, item.sourceRowNumbers, {
              resultPartyId: partyId,
              partyWasCreated: created,
              status: "imported",
            });
          }
        } catch (err) {
          await markRows(tx, importJobId, item.sourceRowNumbers, {
            status: "error",
            errors: [err instanceof Error ? err.message : String(err)],
          });
        }
      }
    });
    await db
      .update(importJobs)
      .set({ contactsCreated: result.contactsCreated, contactsUpdated: result.contactsUpdated, updatedAt: new Date() })
      .where(eq(importJobs.id, importJobId));
  }

  // --- Properties ---
  for (const batch of chunk(contactProperties, BATCH_SIZE)) {
    await db.transaction(async (tx) => {
      for (const item of batch) {
        try {
          const { propertyId, created } = await tx.transaction((tx2) =>
            executePropertyGroup(tx2, item, brokerageId, agentId, already.propertyResultByRow),
          );
          if (propertyId !== undefined) {
            propertyIdByGroup.set(item.groupKey, propertyId);
            if (created) result.propertiesCreated += 1;
            else if (item.resolution === "merge") result.propertiesUpdated += 1;
            await markRows(tx, importJobId, item.sourceRowNumbers, {
              resultPropertyId: propertyId,
              propertyWasCreated: created,
              status: "imported",
            });
          }
        } catch (err) {
          await markRows(tx, importJobId, item.sourceRowNumbers, {
            status: "error",
            errors: [err instanceof Error ? err.message : String(err)],
          });
        }
      }
    });
    await db
      .update(importJobs)
      .set({ propertiesCreated: result.propertiesCreated, propertiesUpdated: result.propertiesUpdated, updatedAt: new Date() })
      .where(eq(importJobs.id, importJobId));
  }

  // --- Relationships (needs both sides resolved above) ---
  for (const batch of chunk(relationships, BATCH_SIZE)) {
    await db.transaction(async (tx) => {
      for (const item of batch) {
        const partyId = contactPartyIdByGroup.get(item.contactGroupKey);
        const propertyId = propertyIdByGroup.get(item.propertyGroupKey);
        if (partyId === undefined || propertyId === undefined) {
          await markRows(tx, importJobId, item.sourceRowNumbers, {
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
          const { relationshipId, created } = await tx.transaction((tx2) =>
            executeRelationshipLink(tx2, item, partyId, propertyId, brokerageId, agentId, importJobId, already.relationshipDoneRows),
          );
          if (relationshipId !== undefined) {
            if (created) result.relationshipsCreated += 1;
            await markRows(tx, importJobId, item.sourceRowNumbers, {
              resultRelationshipId: relationshipId,
              relationshipWasCreated: created,
              status: "imported",
            });
          }
        } catch (err) {
          await markRows(tx, importJobId, item.sourceRowNumbers, {
            status: "error",
            errors: [err instanceof Error ? err.message : String(err)],
          });
        }
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

/**
 * B.19 rollback -- see the header comment at the top of this file for the full
 * safety rule. Order matters: relationships this job created are removed first
 * (unconditionally -- nothing else can depend on a grow_relationships row), then
 * properties, then parties, each gated on "untouched since import" AND "nothing
 * still references it". Every row this job touched is reported, never silently
 * skipped -- a false "rolled back" would be worse than an honest "not rolled
 * back, has since been used".
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
  for (const idBatch of chunk(relationshipIds, BATCH_SIZE)) {
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
  for (const id of propertyIds) {
    const [prop] = await db
      .select()
      .from(properties)
      .where(and(eq(properties.id, id), eq(properties.brokerageId, brokerageId)))
      .limit(1);
    if (!prop) {
      entries.push({ kind: "property", id, rolledBack: false, reason: "not found in this brokerage" });
      continue;
    }
    if (prop.updatedAt.getTime() !== prop.createdAt.getTime()) {
      entries.push({ kind: "property", id, rolledBack: false, reason: "modified since import -- not rolled back" });
      continue;
    }
    const [rel] = await db.select({ id: growRelationships.id }).from(growRelationships).where(eq(growRelationships.propertyId, id)).limit(1);
    const [act] = await db.select({ id: growActivities.id }).from(growActivities).where(eq(growActivities.propertyId, id)).limit(1);
    const [opp] = await db.select({ id: growOpportunities.id }).from(growOpportunities).where(eq(growOpportunities.propertyId, id)).limit(1);
    if (rel || act || opp) {
      entries.push({ kind: "property", id, rolledBack: false, reason: "has since been used -- referenced by other Grow records" });
      continue;
    }
    // Same FK-before-delete ordering as relationships above.
    await db
      .update(importRecords)
      .set({ resultPropertyId: null })
      .where(and(eq(importRecords.importJobId, importJobId), eq(importRecords.resultPropertyId, id)));
    await db.delete(properties).where(eq(properties.id, id));
    entries.push({ kind: "property", id, rolledBack: true });
  }

  const partyIds = [
    ...new Set(rows.filter((r) => r.partyWasCreated && r.resultPartyId != null).map((r) => r.resultPartyId as number)),
  ];
  for (const id of partyIds) {
    const [party] = await db
      .select()
      .from(parties)
      .where(and(eq(parties.id, id), eq(parties.brokerageId, brokerageId)))
      .limit(1);
    if (!party) {
      entries.push({ kind: "party", id, rolledBack: false, reason: "not found in this brokerage" });
      continue;
    }
    if (party.updatedAt.getTime() !== party.createdAt.getTime()) {
      entries.push({ kind: "party", id, rolledBack: false, reason: "modified since import -- not rolled back" });
      continue;
    }
    const [rel] = await db.select({ id: growRelationships.id }).from(growRelationships).where(eq(growRelationships.partyId, id)).limit(1);
    const [act] = await db.select({ id: growActivities.id }).from(growActivities).where(eq(growActivities.partyId, id)).limit(1);
    const [opp] = await db.select({ id: growOpportunities.id }).from(growOpportunities).where(eq(growOpportunities.partyId, id)).limit(1);
    if (rel || act || opp) {
      entries.push({ kind: "party", id, rolledBack: false, reason: "has since been used -- referenced by other Grow records" });
      continue;
    }
    // Same FK-before-delete ordering as relationships/properties above.
    await db
      .update(importRecords)
      .set({ resultPartyId: null })
      .where(and(eq(importRecords.importJobId, importJobId), eq(importRecords.resultPartyId, id)));
    await db.delete(parties).where(eq(parties.id, id));
    entries.push({ kind: "party", id, rolledBack: true });
  }

  await db.update(importJobs).set({ status: "ROLLED_BACK", updatedAt: new Date() }).where(eq(importJobs.id, importJobId));

  return { importJobId, entries };
}
