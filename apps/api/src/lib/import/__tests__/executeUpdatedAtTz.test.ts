// Import execution's batched raw-SQL writes must stamp updated_at with the real
// instant, whatever the API process TZ is. import_records / parties /
// properties.updated_at are `timestamp` (without time zone) holding UTC
// wall-clock, which is how Drizzle maps them. A JS Date bound into raw SQL is
// serialised by node-postgres in the PROCESS-LOCAL zone with an offset, and the
// implicit assignment cast to `timestamp` drops that offset, so a non-UTC
// process (e.g. TZ=Australia/Brisbane) would store local wall-clock, i.e. an
// updated_at hours in the future. Run this file under a non-UTC TZ to exercise it.
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
} from "@aee/db";
import {
  executeImportBatch,
  type ContactExecutionPlanItem,
  type PropertyExecutionPlanItem,
  type RelationshipExecutionPlanItem,
} from "../execute.js";

process.env.NODE_ENV = process.env.NODE_ENV ?? "test";

// Generous enough for a slow box, far smaller than any whole-hour UTC offset.
const TOLERANCE_MS = 5 * 60 * 1000;

/** Returns a description of the problem, or null when `value` is the write instant. */
function stampProblem(label: string, value: Date | null | undefined, before: number, after: number): string | null {
  if (!(value instanceof Date)) return `${label}: updated_at is not set`;
  const t = value.getTime();
  if (t >= before - TOLERANCE_MS && t <= after + TOLERANCE_MS) return null;
  return (
    `${label}: updated_at ${value.toISOString()} is not the write instant ` +
    `(${new Date(before).toISOString()}..${new Date(after).toISOString()}), skew ${Math.round((t - after) / 60000)} min`
  );
}

describe("import execution stamps updated_at as a UTC instant in any process TZ", { concurrency: false }, () => {
  test("import_records (error / party / property / relationship marks), parties and properties gap updates", async () => {
    const [brokerage] = await db.insert(brokerages).values({ name: "I-13 updated_at TZ" }).returning();
    const [user] = await db
      .insert(users)
      .values({
        authProviderId: `i13-uat-${randomUUID()}`,
        email: `uat-${randomUUID()}@i13-test.local`,
        firstName: "Test",
        lastName: "Agent",
        role: "Agent",
        brokerageId: brokerage.id,
      })
      .returning();
    try {
      const [gapParty] = await db
        .insert(parties)
        .values({ brokerageId: brokerage.id, partyType: "Person", firstName: "Gap", lastName: "Party", email: null })
        .returning();
      const [gapProperty] = await db
        .insert(properties)
        .values({
          brokerageId: brokerage.id,
          agentId: user.id,
          formattedAddress: "7 Wattle St, Ashgrove QLD 4060",
          isManualAddress: true,
          suburb: null,
        })
        .returning();

      const [job] = await db
        .insert(importJobs)
        .values({
          brokerageId: brokerage.id,
          initiatedByUserId: user.id,
          filename: "uat.csv",
          sourceFileType: "csv",
          status: "READY_TO_IMPORT",
          totalRows: 4,
        })
        .returning();
      await db.insert(importRecords).values(
        [1, 2, 3, 4].map((n) => ({ importJobId: job.id, sourceRowNumber: n, rawData: { row: String(n) }, status: "valid" as const })),
      );

      const before = Date.now();
      await executeImportBatch({
        importJobId: job.id,
        brokerageId: brokerage.id,
        agentId: user.id,
        contacts: [
          // row 1: error mark only (merge with no candidate)
          contact("err", "merge", [1], { firstName: "No", lastName: "Candidate" }),
          // row 2: party mark only; fills the gap party's email -> parties gap update
          contact("gap", "merge", [2], { firstName: "Gap", lastName: "Party", email: "gap.party@i13-test.local" }, gapParty.id),
          // row 4: party + property + relationship marks (relationship mark is the last write)
          contact("rel", "create_new", [4], { firstName: "Rel", lastName: "Owner", email: "rel.owner@i13-test.local" }),
        ],
        contactProperties: [
          // row 3: property mark only; fills the gap property's suburb -> properties gap update
          property("gapP", "merge", [3], { candidatePropertyId: gapProperty.id, suburb: "Ashgrove" }),
          property("relP", "create_new", [4], { formattedAddress: "8 Wattle St, Ashgrove QLD 4060" }),
        ],
        relationships: [relationship("rel", "relP", [4])],
      });
      const after = Date.now();

      const problems: (string | null)[] = [];
      const records = await db.select().from(importRecords).where(eq(importRecords.importJobId, job.id));
      const byRow = new Map(records.map((row) => [row.sourceRowNumber, row]));
      assert.equal(byRow.get(1)?.status, "error");
      problems.push(stampProblem("import_records error mark (row 1)", byRow.get(1)?.updatedAt, before, after));
      assert.equal(byRow.get(2)?.resultPartyId, gapParty.id);
      assert.equal(byRow.get(2)?.resultPropertyId, null);
      problems.push(stampProblem("import_records party mark (row 2)", byRow.get(2)?.updatedAt, before, after));
      assert.equal(byRow.get(3)?.resultPropertyId, gapProperty.id);
      assert.equal(byRow.get(3)?.resultPartyId, null);
      problems.push(stampProblem("import_records property mark (row 3)", byRow.get(3)?.updatedAt, before, after));
      assert.ok(byRow.get(4)?.resultRelationshipId);
      problems.push(stampProblem("import_records relationship mark (row 4)", byRow.get(4)?.updatedAt, before, after));

      const [party] = await db.select().from(parties).where(eq(parties.id, gapParty.id));
      assert.equal(party?.email, "gap.party@i13-test.local", "the merge filled the party gap");
      problems.push(stampProblem("parties gap update", party?.updatedAt, before, after));

      const [prop] = await db.select().from(properties).where(eq(properties.id, gapProperty.id));
      assert.equal(prop?.suburb, "Ashgrove", "the merge filled the property gap");
      problems.push(stampProblem("properties gap update", prop?.updatedAt, before, after));
      assert.deepEqual(
        problems.filter((problem) => problem !== null),
        [],
        `every batched updated_at must be the write instant (process TZ=${process.env.TZ ?? "(unset)"}, offset ${-new Date().getTimezoneOffset()} min)`,
      );
    } finally {
      const jobIds = (await db.select({ id: importJobs.id }).from(importJobs).where(eq(importJobs.brokerageId, brokerage.id))).map(
        (row) => row.id,
      );
      for (const jobId of jobIds) await db.delete(importRecords).where(eq(importRecords.importJobId, jobId));
      await db.delete(importJobs).where(eq(importJobs.brokerageId, brokerage.id));
      await db.delete(growActivities).where(eq(growActivities.brokerageId, brokerage.id));
      await db.delete(growRelationships).where(eq(growRelationships.brokerageId, brokerage.id));
      await db.delete(properties).where(eq(properties.brokerageId, brokerage.id));
      await db.delete(parties).where(eq(parties.brokerageId, brokerage.id));
      await db.delete(users).where(eq(users.brokerageId, brokerage.id));
      await db.delete(brokerages).where(eq(brokerages.id, brokerage.id));
    }
  });
});

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
  extra: { formattedAddress?: string; candidatePropertyId?: number; suburb?: string },
): PropertyExecutionPlanItem {
  return {
    groupKey,
    resolution,
    sourceRowNumbers,
    formattedAddress: extra.formattedAddress,
    candidatePropertyId: extra.candidatePropertyId,
    suburb: extra.suburb,
    isManualAddress: true,
  };
}

function relationship(contactGroupKey: string, propertyGroupKey: string, sourceRowNumbers: number[]): RelationshipExecutionPlanItem {
  return {
    contactGroupKey,
    propertyGroupKey,
    relationshipType: "owner",
    rawType: "Owner",
    sourceRowNumbers,
    needsPendingReview: false,
  };
}
