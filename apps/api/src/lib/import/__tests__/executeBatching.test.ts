// I-13 — import execution writes a chunk with a handful of statements instead
// of one savepoint and one write per group. Outcomes (created / updated /
// skipped, dedupe, per-row errors, audit columns, rollback) stay the same.
//
// The import_records(import_job_id) index is not part of this slice. It
// belongs to the separate W1-D index migration.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  brokerages,
  users,
  parties,
  properties,
  growActivities,
  growRelationships,
  importJobs,
  importRecords,
  setDbQueryObserver,
} from "@aee/db";
import {
  IMPORT_EXECUTION_CHUNK_SIZE,
  executeImportBatch,
  rollbackImportJob,
  type ContactExecutionPlanItem,
  type ExecuteImportBatchResult,
  type PropertyExecutionPlanItem,
  type RelationshipExecutionPlanItem,
} from "../execute.js";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

describe("I-13 import execution batching", { concurrency: false }, () => {
  test("partial-failure rows are recorded and do not block the rest of the chunk", async () => {
    const brokerage = await makeBrokerage("I-13 partial failure");
    const other = await makeBrokerage("I-13 other brokerage");
    const user = await makeUser(brokerage.id, "partial");
    try {
      const [foreignParty] = await db
        .insert(parties)
        .values({
          brokerageId: other.id,
          partyType: "Person",
          firstName: "Other",
          lastName: "Tenant",
          email: "other.tenant@i13-test.local",
        })
        .returning();

      const job = await seedJob(brokerage.id, user.id, 7);
      const result = await executeImportBatch({
        importJobId: job.id,
        brokerageId: brokerage.id,
        agentId: user.id,
        contacts: [
          contact("c-good-1", "create_new", [1], { firstName: "Ada", lastName: "Lovelace", email: "ada@i13-test.local" }),
          contact("c-missing", "use_existing", [2], { firstName: "Ghost" }, foreignParty.id),
          contact("c-skip", "skip", [3], { firstName: "Skipped", lastName: "Row" }),
          contact("c-no-candidate", "merge", [4], { firstName: "No", lastName: "Candidate" }),
          contact("c-good-2", "create_new", [5], {
            firstName: "Grace",
            lastName: "Hopper",
            email: "grace@i13-test.local",
            organisationName: "Navy",
          }),
        ],
        contactProperties: [
          property("p-good", "create_new", [1], "1 Computation Lane, Sydney NSW 2000"),
          property("p-grace", "create_new", [5], "2 Computation Lane, Sydney NSW 2000"),
          property("p-no-address", "create_new", [6]),
        ],
        relationships: [
          relationship("c-good-1", "p-good", [1]),
          relationship("c-good-2", "p-grace", [5]),
          relationship("c-skip", "p-good", [7]),
        ],
      });

      assert.equal(result.contactsCreated, 2);
      assert.equal(result.contactsUpdated, 0);
      assert.equal(result.propertiesCreated, 2);
      assert.equal(result.propertiesUpdated, 0);
      assert.equal(result.relationshipsCreated, 2);

      const partyRows = await db.select().from(parties).where(eq(parties.brokerageId, brokerage.id));
      assert.equal(partyRows.length, 2);
      const ada = partyRows.find((row) => row.email === "ada@i13-test.local");
      const grace = partyRows.find((row) => row.email === "grace@i13-test.local");
      assert.equal(ada?.partyType, "Person");
      assert.equal(grace?.partyType, "Organisation");
      assert.equal(grace?.organisationName, "Navy");

      const propertyRows = await db.select().from(properties).where(eq(properties.brokerageId, brokerage.id));
      assert.equal(propertyRows.length, 2);
      const adaProperty = propertyRows.find((row) => row.formattedAddress.startsWith("1 "));
      assert.equal(adaProperty?.agentId, user.id);

      const relRows = await db.select().from(growRelationships).where(eq(growRelationships.brokerageId, brokerage.id));
      assert.equal(relRows.length, 2);
      const adaRel = relRows.find((row) => row.partyId === ada?.id);
      assert.equal(adaRel?.propertyId, adaProperty?.id);
      assert.equal(adaRel?.relationshipType, "owner");
      assert.equal(adaRel?.status, "Active");
      assert.equal(relRows.find((row) => row.partyId === grace?.id)?.status, "Active");

      const records = await loadRecords(job.id);
      const byRow = new Map(records.map((row) => [row.sourceRowNumber, row]));
      assert.equal(byRow.get(1)?.status, "imported");
      assert.equal(byRow.get(1)?.resultPartyId, ada?.id);
      assert.equal(byRow.get(1)?.partyWasCreated, true);
      assert.equal(byRow.get(1)?.propertyWasCreated, true);
      assert.equal(byRow.get(1)?.relationshipWasCreated, true);
      assert.equal(byRow.get(2)?.status, "error");
      assert.deepEqual(byRow.get(2)?.errors, [
        `Contact group c-missing: candidate party ${foreignParty.id} not found in this brokerage`,
      ]);
      assert.equal(byRow.get(2)?.resultPartyId, null);
      assert.equal(byRow.get(3)?.status, "valid", "a skip leaves the source row untouched");
      assert.equal(byRow.get(4)?.status, "error");
      assert.deepEqual(byRow.get(4)?.errors, [
        'Contact group c-no-candidate: resolution "merge" requires candidatePartyId',
      ]);
      assert.equal(byRow.get(5)?.status, "imported");
      assert.equal(byRow.get(5)?.resultPartyId, grace?.id);
      assert.equal(byRow.get(5)?.partyWasCreated, true);
      assert.equal(byRow.get(5)?.relationshipWasCreated, true);
      assert.equal(byRow.get(6)?.status, "error");
      assert.deepEqual(byRow.get(6)?.errors, ["Property group p-no-address: create_new requires a formattedAddress"]);
      assert.equal(byRow.get(7)?.status, "error");
      assert.deepEqual(byRow.get(7)?.errors, ["Relationship could not resolve its contact group (c-skip)"]);

      const [reloaded] = await db.select().from(importJobs).where(eq(importJobs.id, job.id));
      assert.equal(reloaded?.status, "COMPLETED");
      assert.equal(reloaded?.contactsCreated, 2);
      assert.equal(reloaded?.propertiesCreated, 2);
      assert.equal(reloaded?.relationshipsCreated, 2);
    } finally {
      await cleanupBrokerage(other.id);
      await cleanupBrokerage(brokerage.id);
    }
  });

  test("merge fills gaps in plan order and never overwrites a value already present", async () => {
    const brokerage = await makeBrokerage("I-13 merge");
    const user = await makeUser(brokerage.id, "merge");
    try {
      const [existing] = await db
        .insert(parties)
        .values({
          brokerageId: brokerage.id,
          partyType: "Person",
          firstName: null,
          lastName: "Smith",
          email: null,
          mobile: null,
        })
        .returning();

      const job = await seedJob(brokerage.id, user.id, 2);
      const result = await executeImportBatch({
        importJobId: job.id,
        brokerageId: brokerage.id,
        agentId: user.id,
        contacts: [
          contact("m-a", "merge", [1], { firstName: "John", email: "john@i13-test.local" }, existing.id),
          contact("m-b", "merge", [2], { firstName: "Jonathan", email: "jonathan@i13-test.local", mobile: "0412000111" }, existing.id),
        ],
        contactProperties: [],
        relationships: [],
      });

      assert.deepEqual(result, {
        contactsCreated: 0,
        contactsUpdated: 2,
        propertiesCreated: 0,
        propertiesUpdated: 0,
        relationshipsCreated: 0,
      } satisfies ExecuteImportBatchResult);

      const [party] = await db.select().from(parties).where(eq(parties.id, existing.id));
      assert.equal(party?.firstName, "John", "the first merge fills the gap; the second must not overwrite it");
      assert.equal(party?.lastName, "Smith");
      assert.equal(party?.email, "john@i13-test.local");
      assert.equal(party?.mobile, "0412000111", "a later merge may still fill a field the earlier one left empty");
      assert.ok(party && party.updatedAt.getTime() !== party.createdAt.getTime());

      const partyRows = await db.select().from(parties).where(eq(parties.brokerageId, brokerage.id));
      assert.equal(partyRows.length, 1);

      const records = await loadRecords(job.id);
      assert.ok(records.every((row) => row.status === "imported" && row.resultPartyId === existing.id && row.partyWasCreated === false));
    } finally {
      await cleanupBrokerage(brokerage.id);
    }
  });

  test("duplicate relationships collapse to one row, including a later backfill that does not overwrite", async () => {
    const brokerage = await makeBrokerage("I-13 duplicates");
    const user = await makeUser(brokerage.id, "dup");
    try {
      const [party] = await db
        .insert(parties)
        .values({
          brokerageId: brokerage.id,
          partyType: "Person",
          firstName: "Helen",
          lastName: "Vasquez",
          email: "helen@i13-test.local",
        })
        .returning();
      const [existingProperty] = await db
        .insert(properties)
        .values({
          brokerageId: brokerage.id,
          agentId: user.id,
          formattedAddress: "5 Melaleuca Way, Kenmore QLD 4069",
          isManualAddress: true,
        })
        .returning();
      const [existingRel] = await db
        .insert(growRelationships)
        .values({
          brokerageId: brokerage.id,
          partyId: party.id,
          propertyId: existingProperty.id,
          relationshipType: "owner",
          status: "Active",
          sourceType: "manual",
          createdBy: user.id,
        })
        .returning();

      const backfillJob = await seedJob(brokerage.id, user.id, 2);
      const backfill = await executeImportBatch({
        importJobId: backfillJob.id,
        brokerageId: brokerage.id,
        agentId: user.id,
        contacts: [contact("c", "use_existing", [1], { firstName: "Helen", lastName: "Vasquez" }, party.id)],
        contactProperties: [
          property("p", "use_existing", [1], "5 Melaleuca Way, Kenmore QLD 4069", { candidatePropertyId: existingProperty.id }),
        ],
        relationships: [
          relationship("c", "p", [1], { dateIso: "2012-06-01", precision: "day", raw: "2012-06-01" }),
          relationship("c", "p", [2], { dateIso: "1999-01-01", precision: "day", raw: "1999-01-01" }),
        ],
      });
      assert.equal(backfill.relationshipsCreated, 0);
      assert.equal(backfill.contactsCreated, 0);
      assert.equal(backfill.propertiesCreated, 0);

      const afterBackfill = await db.select().from(growRelationships).where(eq(growRelationships.brokerageId, brokerage.id));
      assert.equal(afterBackfill.length, 1);
      assert.equal(afterBackfill[0]?.id, existingRel.id);
      assert.equal(afterBackfill[0]?.ownershipStartDate?.toISOString(), "2012-06-01T00:00:00.000Z");
      assert.equal(afterBackfill[0]?.ownershipStartSource, "import");
      assert.equal(afterBackfill[0]?.ownershipStartPrecision, "day");

      const backfillRecords = await loadRecords(backfillJob.id);
      assert.equal(backfillRecords.length, 2);
      assert.ok(backfillRecords.every((row) => row.relationshipWasCreated === false && row.resultRelationshipId === existingRel.id));

      const createJob = await seedJob(brokerage.id, user.id, 4, 10);
      const created = await executeImportBatch({
        importJobId: createJob.id,
        brokerageId: brokerage.id,
        agentId: user.id,
        contacts: [
          contact("n1", "create_new", [10], { firstName: "Mia", lastName: "Nguyen", email: "mia@i13-test.local" }),
          contact("n2", "create_new", [11], { firstName: "Omar", lastName: "Hassan", email: "omar@i13-test.local" }),
        ],
        contactProperties: [
          property("q1", "create_new", [10], "3 Hibiscus Way, Cairns QLD 4870"),
          property("q2", "create_new", [12], "9 Banksia Ave, Cairns QLD 4870"),
        ],
        relationships: [
          relationship("n1", "q1", [10, 12]),
          relationship("n1", "q1", [11]),
          relationship("n2", "q2", [13], undefined, true),
        ],
      });
      assert.equal(created.contactsCreated, 2);
      assert.equal(created.propertiesCreated, 2);
      assert.equal(created.relationshipsCreated, 2, "the second owner link reuses the first; the pending-review link is its own row");

      const rels = await db.select().from(growRelationships).where(eq(growRelationships.brokerageId, brokerage.id));
      const createdRels = rels.filter((row) => row.id !== existingRel.id);
      assert.equal(createdRels.length, 2);
      const active = createdRels.find((row) => row.status === "Active");
      const pending = createdRels.find((row) => row.status === "PendingReview");
      assert.ok(active);
      assert.equal(pending?.relationshipType, "owner");
      assert.equal(pending?.sourceEvidence, "Best Friend");

      const records = await loadRecords(createJob.id);
      const byRow = new Map(records.map((row) => [row.sourceRowNumber, row]));
      assert.equal(byRow.get(10)?.relationshipWasCreated, true);
      assert.equal(byRow.get(12)?.relationshipWasCreated, true);
      assert.equal(byRow.get(10)?.resultRelationshipId, active?.id);
      assert.equal(byRow.get(12)?.resultRelationshipId, active?.id);
      assert.equal(byRow.get(11)?.relationshipWasCreated, false);
      assert.equal(byRow.get(11)?.resultRelationshipId, active?.id);
      assert.equal(byRow.get(13)?.relationshipWasCreated, true);
      assert.equal(byRow.get(13)?.resultRelationshipId, pending?.id);
    } finally {
      await cleanupBrokerage(brokerage.id);
    }
  });

  test("rollback removes only untouched rows this job created", async () => {
    const brokerage = await makeBrokerage("I-13 rollback");
    const user = await makeUser(brokerage.id, "rollback");
    try {
      const [keptParty] = await db
        .insert(parties)
        .values({
          brokerageId: brokerage.id,
          partyType: "Person",
          firstName: "Pre",
          lastName: "Existing",
          email: "pre.existing@i13-test.local",
        })
        .returning();

      const job = await seedJob(brokerage.id, user.id, 2);
      await executeImportBatch({
        importJobId: job.id,
        brokerageId: brokerage.id,
        agentId: user.id,
        contacts: [
          contact("new", "create_new", [1], { firstName: "Priya", lastName: "Chandra", email: "priya@i13-test.local" }),
          contact("kept", "use_existing", [2], { firstName: "Pre", lastName: "Existing" }, keptParty.id),
        ],
        contactProperties: [
          property("clean", "create_new", [1], "7 Jacaranda Close, Ballarat VIC 3350"),
          property("touched", "create_new", [2], "8 Jacaranda Close, Ballarat VIC 3350"),
        ],
        relationships: [
          relationship("new", "clean", [1]),
          relationship("kept", "touched", [2]),
        ],
      });

      const importedParties = await db.select().from(parties).where(eq(parties.brokerageId, brokerage.id));
      const createdParty = importedParties.find((row) => row.email === "priya@i13-test.local");
      assert.ok(createdParty);
      const importedProperties = await db.select().from(properties).where(eq(properties.brokerageId, brokerage.id));
      const clean = importedProperties.find((row) => row.formattedAddress.startsWith("7 "));
      const touched = importedProperties.find((row) => row.formattedAddress.startsWith("8 "));
      assert.ok(clean && touched);

      await db.insert(growActivities).values({
        brokerageId: brokerage.id,
        partyId: createdParty.id,
        activityType: "note",
        occurredAt: new Date(),
        summary: "Agent added a note after import",
      });
      await db
        .update(properties)
        .set({ updatedAt: new Date(touched.createdAt.getTime() + 60_000) })
        .where(eq(properties.id, touched.id));

      const { statements: rollbackStatements, result: rollback } = await capture(() => rollbackImportJob(job.id, brokerage.id));
      const propertySelects = rollbackStatements.filter(
        (query) => /from "properties"/i.test(query) && /^\s*select/i.test(query),
      );
      assert.equal(
        propertySelects.length,
        1,
        "both created properties are read in one statement; the previous loop selected once per property",
      );
      const partyEntry = rollback.entries.find((entry) => entry.kind === "party" && entry.id === createdParty.id);
      const keptEntry = rollback.entries.find((entry) => entry.kind === "party" && entry.id === keptParty.id);
      const cleanEntry = rollback.entries.find((entry) => entry.kind === "property" && entry.id === clean.id);
      const touchedEntry = rollback.entries.find((entry) => entry.kind === "property" && entry.id === touched.id);
      assert.equal(keptEntry, undefined, "a matched existing party is never a rollback candidate");
      assert.equal(partyEntry?.rolledBack, false);
      assert.equal(partyEntry?.reason, "has since been used -- referenced by other Grow records");
      assert.equal(cleanEntry?.rolledBack, true);
      assert.equal(touchedEntry?.rolledBack, false);
      assert.equal(touchedEntry?.reason, "modified since import -- not rolled back");
      assert.ok(rollback.entries.filter((entry) => entry.kind === "relationship").every((entry) => entry.rolledBack));

      const partiesLeft = await db.select().from(parties).where(eq(parties.brokerageId, brokerage.id));
      assert.deepEqual(
        partiesLeft.map((row) => row.id).sort(),
        [keptParty.id, createdParty.id].sort(),
      );
      const propertiesLeft = await db.select().from(properties).where(eq(properties.brokerageId, brokerage.id));
      assert.deepEqual(propertiesLeft.map((row) => row.id), [touched.id]);
      const relsLeft = await db.select().from(growRelationships).where(eq(growRelationships.brokerageId, brokerage.id));
      assert.equal(relsLeft.length, 0);

      const [reloaded] = await db.select().from(importJobs).where(eq(importJobs.id, job.id));
      assert.equal(reloaded?.status, "ROLLED_BACK");
    } finally {
      await cleanupBrokerage(brokerage.id);
    }
  });

  test("a resumed execute does not create a second copy of a resolved group", async () => {
    const brokerage = await makeBrokerage("I-13 resume");
    const user = await makeUser(brokerage.id, "resume");
    try {
      const job = await seedJob(brokerage.id, user.id, 2);
      const plan = {
        importJobId: job.id,
        brokerageId: brokerage.id,
        agentId: user.id,
        contacts: [
          contact("a", "create_new", [1], { firstName: "Mia", lastName: "Nguyen", email: "mia.resume@i13-test.local" }),
          contact("b", "create_new", [2], { firstName: "Omar", lastName: "Hassan", email: "omar.resume@i13-test.local" }),
        ],
        contactProperties: [] as PropertyExecutionPlanItem[],
        relationships: [] as RelationshipExecutionPlanItem[],
      };
      const first = await executeImportBatch(plan);
      assert.equal(first.contactsCreated, 2);

      const records = await loadRecords(job.id);
      const firstRow = records.find((row) => row.sourceRowNumber === 1);
      assert.equal(firstRow?.partyWasCreated, true);
      await db
        .update(importRecords)
        .set({ resultPartyId: null, partyWasCreated: false, status: "valid" })
        .where(eq(importRecords.id, records.find((row) => row.sourceRowNumber === 2)!.id));

      const second = await executeImportBatch(plan);
      assert.equal(second.contactsCreated, 1, "only the row whose checkpoint was cleared is created again");
      const partiesAfter = await db.select().from(parties).where(eq(parties.brokerageId, brokerage.id));
      assert.equal(partiesAfter.length, 3);

      const after = await loadRecords(job.id);
      const resumed = after.find((row) => row.sourceRowNumber === 1);
      assert.equal(resumed?.partyWasCreated, false, "resume rewrites the checkpoint with created:false, as the per-row path did");
      assert.equal(resumed?.resultPartyId, firstRow?.resultPartyId);
      assert.equal(after.find((row) => row.sourceRowNumber === 2)?.partyWasCreated, true);
    } finally {
      await cleanupBrokerage(brokerage.id);
    }
  });

  test("statement count stays flat inside a chunk and well under the per-row floor", async () => {
    const brokerage = await makeBrokerage("I-13 round trips");
    const user = await makeUser(brokerage.id, "rounds");
    try {
      const small = await measureCreates(brokerage.id, user.id, 30);
      const doubled = await measureCreates(brokerage.id, user.id, 60);
      assert.equal(
        small.statements.length,
        doubled.statements.length,
        `doubling the rows inside one chunk of ${IMPORT_EXECUTION_CHUNK_SIZE} must not add statements (30=${small.statements.length}, 60=${doubled.statements.length})`,
      );
      assert.equal(insertCount(small.statements, "parties"), 1);
      assert.equal(insertCount(doubled.statements, "parties"), 1);
      assert.ok(
        updateCount(small.statements, "import_records") <= 2,
        `expected one audit update, saw ${updateCount(small.statements, "import_records")}`,
      );

      const mixed = await measureMixed(brokerage.id, user.id, 20);
      const floor = perRowRoundTripFloor(20, 20, 20);
      assert.equal(insertCount(mixed.statements, "parties"), 1);
      assert.equal(insertCount(mixed.statements, "properties"), 1);
      assert.equal(insertCount(mixed.statements, "grow_relationships"), 1);
      assert.equal(
        mixed.statements.filter((query) => /from "grow_relationships"/i.test(query) && /^\s*select/i.test(query)).length,
        1,
        "relationship dedupe is one lookup per chunk, not one select per row",
      );
      assert.ok(
        mixed.statements.length < floor / 4,
        `execute issued ${mixed.statements.length} statements for 20+20+20 groups; the per-row floor is ${floor}`,
      );

      const boundary = await measureCreates(brokerage.id, user.id, IMPORT_EXECUTION_CHUNK_SIZE + 1);
      assert.equal(insertCount(boundary.statements, "parties"), 2, "crossing the chunk boundary adds a chunk, not a statement per row");
      const boundaryFloor = perRowRoundTripFloor(IMPORT_EXECUTION_CHUNK_SIZE + 1, 0, 0);
      assert.ok(
        boundary.statements.length < boundaryFloor / 4,
        `chunk-boundary execute issued ${boundary.statements.length} statements; per-row floor is ${boundaryFloor}`,
      );
    } finally {
      await cleanupBrokerage(brokerage.id);
    }
  });
});

/**
 * Minimum serial business round trips the previous per-group loop could not
 * go under: each contact or property group inserted and then updated its
 * import_records row, and each relationship group also selected the existing
 * active link. Savepoints, commits, and job-counter updates made the real
 * count higher. For a 20k-row file that is one contact, one property, and one
 * relationship per row, the contact phase alone was the ~80,000 figure
 * (4 round trips × 20,000, counting the savepoint and its release).
 */
function perRowRoundTripFloor(contacts: number, properties: number, relationships: number): number {
  return contacts * 2 + properties * 2 + relationships * 3;
}

function insertCount(statements: string[], table: string): number {
  return statements.filter((query) => new RegExp(`insert into "${table}"`, "i").test(query)).length;
}

function updateCount(statements: string[], table: string): number {
  return statements.filter((query) => new RegExp(`update "${table}"`, "i").test(query)).length;
}

async function measureCreates(brokerageId: number, agentId: number, count: number): Promise<{ statements: string[] }> {
  const job = await seedJob(brokerageId, agentId, count);
  const contacts = Array.from({ length: count }, (_, index) =>
    contact(`c-${index}`, "create_new", [index + 1], {
      firstName: "Row",
      lastName: String(index),
      email: `row${index}-${job.id}@i13-test.local`,
    }),
  );
  return capture(() =>
    executeImportBatch({
      importJobId: job.id,
      brokerageId,
      agentId,
      contacts,
      contactProperties: [],
      relationships: [],
    }),
  );
}

async function measureMixed(brokerageId: number, agentId: number, count: number): Promise<{ statements: string[] }> {
  const job = await seedJob(brokerageId, agentId, count);
  const contacts = Array.from({ length: count }, (_, index) =>
    contact(`c-${index}`, "create_new", [index + 1], {
      firstName: "Mix",
      lastName: String(index),
      email: `mix${index}-${job.id}@i13-test.local`,
    }),
  );
  const contactProperties = Array.from({ length: count }, (_, index) =>
    property(`p-${index}`, "create_new", [index + 1], `${index + 1} Wattle Street, Bondi NSW 2026`),
  );
  const relationships = Array.from({ length: count }, (_, index) => relationship(`c-${index}`, `p-${index}`, [index + 1]));
  return capture(() =>
    executeImportBatch({
      importJobId: job.id,
      brokerageId,
      agentId,
      contacts,
      contactProperties,
      relationships,
    }),
  );
}

async function capture<T>(run: () => Promise<T>): Promise<{ statements: string[]; result: T }> {
  const statements: string[] = [];
  const uninstall = setDbQueryObserver((query) => statements.push(query));
  try {
    const result = await run();
    return { statements, result };
  } finally {
    uninstall();
  }
}

function contact(
  groupKey: string,
  resolution: ContactExecutionPlanItem["resolution"],
  sourceRowNumbers: number[],
  person: ContactExecutionPlanItem["person"],
  candidatePartyId?: number,
): ContactExecutionPlanItem {
  return { groupKey, resolution, sourceRowNumbers, person, candidatePartyId };
}

function property(
  groupKey: string,
  resolution: PropertyExecutionPlanItem["resolution"],
  sourceRowNumbers: number[],
  formattedAddress?: string,
  extra?: { candidatePropertyId?: number; suburb?: string; state?: string; postcode?: string },
): PropertyExecutionPlanItem {
  return {
    groupKey,
    resolution,
    sourceRowNumbers,
    formattedAddress,
    candidatePropertyId: extra?.candidatePropertyId,
    suburb: extra?.suburb,
    state: extra?.state,
    postcode: extra?.postcode,
    isManualAddress: true,
  };
}

function relationship(
  contactGroupKey: string,
  propertyGroupKey: string,
  sourceRowNumbers: number[],
  ownershipStart?: RelationshipExecutionPlanItem["ownershipStart"],
  needsPendingReview = false,
): RelationshipExecutionPlanItem {
  return {
    contactGroupKey,
    propertyGroupKey,
    relationshipType: "owner",
    rawType: needsPendingReview ? "Best Friend" : "Owner",
    sourceRowNumbers,
    needsPendingReview,
    ownershipStart,
  };
}

async function makeBrokerage(name: string) {
  const [row] = await db.insert(brokerages).values({ name }).returning();
  return row;
}

async function makeUser(brokerageId: number, label: string) {
  const [row] = await db
    .insert(users)
    .values({
      authProviderId: `i13-${label}-${randomUUID()}`,
      email: `${label}-${randomUUID()}@i13-test.local`,
      firstName: "Test",
      lastName: "Agent",
      role: "Agent",
      brokerageId,
    })
    .returning();
  return row;
}

async function seedJob(brokerageId: number, userId: number, rowCount: number, firstRowNumber = 1) {
  const [job] = await db
    .insert(importJobs)
    .values({
      brokerageId,
      initiatedByUserId: userId,
      filename: "i13.csv",
      sourceFileType: "csv",
      status: "READY_TO_IMPORT",
      totalRows: rowCount,
    })
    .returning();
  if (rowCount > 0) {
    await db.insert(importRecords).values(
      Array.from({ length: rowCount }, (_, index) => ({
        importJobId: job.id,
        sourceRowNumber: firstRowNumber + index,
        rawData: { row: String(firstRowNumber + index) },
        status: "valid" as const,
      })),
    );
  }
  return job;
}

async function loadRecords(importJobId: number) {
  return db.select().from(importRecords).where(eq(importRecords.importJobId, importJobId));
}

async function cleanupBrokerage(brokerageId: number) {
  const jobIds = (await db.select({ id: importJobs.id }).from(importJobs).where(eq(importJobs.brokerageId, brokerageId))).map(
    (job) => job.id,
  );
  for (const jobId of jobIds) {
    await db.delete(importRecords).where(eq(importRecords.importJobId, jobId));
  }
  await db.delete(importJobs).where(eq(importJobs.brokerageId, brokerageId));
  await db.delete(growActivities).where(eq(growActivities.brokerageId, brokerageId));
  await db.delete(growRelationships).where(eq(growRelationships.brokerageId, brokerageId));
  await db.delete(properties).where(eq(properties.brokerageId, brokerageId));
  await db.delete(parties).where(eq(parties.brokerageId, brokerageId));
  await db.delete(users).where(eq(users.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
}
