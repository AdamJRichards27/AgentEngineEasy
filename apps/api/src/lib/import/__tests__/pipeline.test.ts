import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  db,
  brokerages,
  users,
  parties,
  properties,
  growRelationships,
  importJobs,
  importRecords,
} from "@aee/db";
import {
  createImportJobFromFile,
  runMappingAndValidation,
  buildImportPreview,
  buildExecutionPlan,
  listImportJobs,
  exportRejectedRecordsCsv,
} from "../pipeline.js";
import { executeImportBatch, rollbackImportJob } from "../execute.js";
import type { UploadedFileLike } from "../fileValidation.js";
import type { ColumnMapping } from "../mapping.js";

// B.28/B.29 -- end-to-end tests for the Stage B import pipeline, run against
// a real database exactly like entitlement.test.ts: insert real fixture
// rows (brokerage/user/parties/properties), drive the actual exported
// pipeline + execute functions -- never mocks -- and clean up in `finally`.
// Fixture data uses realistic Australian names, AU mobile formats
// (04XX XXX XXX), and AU state/postcode addresses throughout.

// Column headers on the left mirror what an agent's own spreadsheet might
// use; the mapping is supplied directly (as the mapping step's PUT
// /jobs/:id/mapping would persist) rather than relying on suggestMapping's
// fuzzy header guessing, which is exercised separately elsewhere.
const MAPPING: ColumnMapping = {
  "First Name": "person.firstName",
  "Last Name": "person.lastName",
  "Email": "person.email",
  "Mobile": "person.mobile",
  "Property Address": "property.address.full",
  "Relationship Type": "relationship.type",
};

function toCsv(rows: Record<string, string>[]): string {
  const headers = Object.keys(MAPPING);
  const escape = (v: string) => (v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => escape(row[h] ?? "")).join(","));
  }
  return lines.join("\n");
}

function csvFile(csvText: string, originalname = "contacts.csv"): UploadedFileLike {
  return {
    originalname,
    mimetype: "text/csv",
    size: Buffer.byteLength(csvText, "utf-8"),
    buffer: Buffer.from(csvText, "utf-8"),
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
      authProviderId: `import-test-${label}-${randomUUID()}`,
      email: `${label}@import-test.local`,
      firstName: "Test",
      lastName: "Agent",
      role: "Agent",
      brokerageId,
    })
    .returning();
  return row;
}

// Deletes everything a test's brokerage could have produced, in FK-safe
// order. Mirrors the exact table set Stage B writes to (see the "engine
// populates existing tables, never a parallel one" comment in schema/import.ts).
async function cleanupBrokerage(brokerageId: number) {
  const jobIds = (
    await db.select({ id: importJobs.id }).from(importJobs).where(eq(importJobs.brokerageId, brokerageId))
  ).map((j) => j.id);
  for (const jobId of jobIds) {
    await db.delete(importRecords).where(eq(importRecords.importJobId, jobId));
  }
  await db.delete(importJobs).where(eq(importJobs.brokerageId, brokerageId));
  await db.delete(growRelationships).where(eq(growRelationships.brokerageId, brokerageId));
  await db.delete(properties).where(eq(properties.brokerageId, brokerageId));
  await db.delete(parties).where(eq(parties.brokerageId, brokerageId));
  await db.delete(users).where(eq(users.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
}

async function runPlanAndExecute(jobId: number, brokerageId: number, agentId: number) {
  const plan = await buildExecutionPlan(jobId, brokerageId);
  return executeImportBatch({
    importJobId: jobId,
    brokerageId,
    agentId,
    contacts: plan.contacts,
    contactProperties: plan.contactProperties,
    relationships: plan.relationships,
  });
}

test("full pipeline: creates contacts, a shared property, and relationships scoped to the brokerage", async () => {
  const brokerage = await makeBrokerage("Import Test - Stage B happy path");
  const user = await makeUser(brokerage.id, "happy");
  try {
    const csv = toCsv([
      {
        "First Name": "John",
        "Last Name": "Smith",
        Email: "john.smith@import-test.local",
        Mobile: "0412 345 678",
        "Property Address": "12 Wattle Street, Bondi NSW 2026",
        "Relationship Type": "Owner",
      },
      {
        "First Name": "Jane",
        "Last Name": "Smith",
        Email: "jane.smith@import-test.local",
        Mobile: "0413 456 789",
        "Property Address": "12 Wattle Street, Bondi NSW 2026",
        "Relationship Type": "Co Owner",
      },
      {
        "First Name": "Sarah",
        "Last Name": "Lee",
        Email: "sarah.lee@import-test.local",
        Mobile: "0423 456 789",
        "Property Address": "45 Banksia Ave, Toowong QLD 4066",
        "Relationship Type": "Tenant",
      },
    ]);

    const { job } = await createImportJobFromFile(brokerage.id, user.id, csvFile(csv));
    const validation = await runMappingAndValidation(job.id, brokerage.id, MAPPING);
    assert.equal(validation.validRows, 3);
    assert.equal(validation.warningRows, 0);
    assert.equal(validation.rejectedRows, 0);

    const preview = await buildImportPreview(job.id, brokerage.id);
    assert.equal(preview.summary.contactsNew, 3);
    assert.equal(preview.summary.propertiesNew, 2);
    assert.equal(preview.summary.relationshipsTotal, 3);

    const result = await runPlanAndExecute(job.id, brokerage.id, user.id);
    assert.equal(result.contactsCreated, 3);
    assert.equal(result.propertiesCreated, 2);
    assert.equal(result.relationshipsCreated, 3);

    const partyRows = await db.select().from(parties).where(eq(parties.brokerageId, brokerage.id));
    assert.equal(partyRows.length, 3);
    const propertyRows = await db.select().from(properties).where(eq(properties.brokerageId, brokerage.id));
    assert.equal(propertyRows.length, 2);
    const relRows = await db.select().from(growRelationships).where(eq(growRelationships.brokerageId, brokerage.id));
    assert.equal(relRows.length, 3);

    const bondi = propertyRows.find((p) => p.formattedAddress.includes("Wattle"));
    assert.ok(bondi, "the shared Bondi property should have been created");
    const bondiPartyIds = relRows.filter((r) => r.propertyId === bondi!.id).map((r) => r.partyId);
    assert.equal(bondiPartyIds.length, 2, "both John and Jane should be linked to the same property row");
  } finally {
    await cleanupBrokerage(brokerage.id);
  }
});

test("deduplicates against an existing contact on exact email match by default", async () => {
  const brokerage = await makeBrokerage("Import Test - dedup");
  const user = await makeUser(brokerage.id, "dedup");
  try {
    const [existing] = await db
      .insert(parties)
      .values({
        brokerageId: brokerage.id,
        partyType: "Person",
        firstName: "Jonathan",
        lastName: "Smith",
        email: "john.smith@import-test.local",
        mobile: "+61412345678",
      })
      .returning();

    const csv = toCsv([
      {
        "First Name": "John",
        "Last Name": "Smith",
        Email: "john.smith@import-test.local",
        Mobile: "0412 345 678",
        "Property Address": "",
        "Relationship Type": "",
      },
    ]);

    const { job } = await createImportJobFromFile(brokerage.id, user.id, csvFile(csv));
    await runMappingAndValidation(job.id, brokerage.id, MAPPING);
    const preview = await buildImportPreview(job.id, brokerage.id);

    assert.equal(preview.contactDuplicates.length, 1);
    const dup = preview.contactDuplicates[0];
    assert.equal(dup?.matches[0]?.matchType, "exact");
    assert.equal(dup?.matches[0]?.candidateId, existing.id);
    // Never on name alone: the incoming "John Smith" only matched the
    // existing "Jonathan Smith" because the email matched, not the name.
    assert.ok(dup?.matches[0]?.matchedOn.some((f) => f.toLowerCase().includes("email")));

    const result = await runPlanAndExecute(job.id, brokerage.id, user.id);
    assert.equal(result.contactsCreated, 0, "an unresolved exact match should reuse the existing party, not create one");

    const partyRows = await db.select().from(parties).where(eq(parties.brokerageId, brokerage.id));
    assert.equal(partyRows.length, 1);
  } finally {
    await cleanupBrokerage(brokerage.id);
  }
});

test("tenant isolation: a job cannot be read, planned, rolled back, or exported from a different brokerage", async () => {
  const brokerageA = await makeBrokerage("Import Test - tenant A");
  const brokerageB = await makeBrokerage("Import Test - tenant B");
  const userA = await makeUser(brokerageA.id, "tenantA");
  try {
    const csv = toCsv([
      {
        "First Name": "Alice",
        "Last Name": "Adams",
        Email: "alice.adams@import-test.local",
        Mobile: "0412 000 111",
        "Property Address": "",
        "Relationship Type": "",
      },
    ]);
    const { job } = await createImportJobFromFile(brokerageA.id, userA.id, csvFile(csv));
    await runMappingAndValidation(job.id, brokerageA.id, MAPPING);

    await assert.rejects(() => buildImportPreview(job.id, brokerageB.id));
    await assert.rejects(() => buildExecutionPlan(job.id, brokerageB.id));
    await assert.rejects(() => rollbackImportJob(job.id, brokerageB.id));
    await assert.rejects(() => exportRejectedRecordsCsv(job.id, brokerageB.id));

    const jobsForB = await listImportJobs(brokerageB.id);
    assert.equal(jobsForB.some((j) => j.id === job.id), false);
    const jobsForA = await listImportJobs(brokerageA.id);
    assert.equal(jobsForA.some((j) => j.id === job.id), true);
  } finally {
    await cleanupBrokerage(brokerageA.id);
    await cleanupBrokerage(brokerageB.id);
  }
});

test("executeImportBatch is idempotent -- a repeated call does not duplicate records", async () => {
  const brokerage = await makeBrokerage("Import Test - idempotency");
  const user = await makeUser(brokerage.id, "idempotent");
  try {
    const csv = toCsv([
      {
        "First Name": "Mia",
        "Last Name": "Nguyen",
        Email: "mia.nguyen@import-test.local",
        Mobile: "0433 222 111",
        "Property Address": "3 Hibiscus Way, Cairns QLD 4870",
        "Relationship Type": "Owner",
      },
    ]);
    const { job } = await createImportJobFromFile(brokerage.id, user.id, csvFile(csv));
    await runMappingAndValidation(job.id, brokerage.id, MAPPING);
    await buildImportPreview(job.id, brokerage.id);

    const first = await runPlanAndExecute(job.id, brokerage.id, user.id);
    assert.equal(first.contactsCreated, 1);
    assert.equal(first.propertiesCreated, 1);
    assert.equal(first.relationshipsCreated, 1);

    // Re-run the exact same job through plan+execute a second time, as a
    // retried double-submission would. The route guards against this at
    // the HTTP layer (see routes/import.ts's IMPORTING/COMPLETED checks),
    // but executeImportBatch itself must not duplicate rows if called
    // again directly -- that's the actual idempotency guarantee.
    await runPlanAndExecute(job.id, brokerage.id, user.id);

    const partyRows = await db.select().from(parties).where(eq(parties.brokerageId, brokerage.id));
    assert.equal(partyRows.length, 1);
    const propertyRows = await db.select().from(properties).where(eq(properties.brokerageId, brokerage.id));
    assert.equal(propertyRows.length, 1);
    const relRows = await db.select().from(growRelationships).where(eq(growRelationships.brokerageId, brokerage.id));
    assert.equal(relRows.length, 1);
  } finally {
    await cleanupBrokerage(brokerage.id);
  }
});

test("rollback removes everything the job created and marks the job ROLLED_BACK", async () => {
  const brokerage = await makeBrokerage("Import Test - rollback");
  const user = await makeUser(brokerage.id, "rollback");
  try {
    const csv = toCsv([
      {
        "First Name": "Priya",
        "Last Name": "Chandra",
        Email: "priya.chandra@import-test.local",
        Mobile: "0455 111 222",
        "Property Address": "7 Jacaranda Close, Ballarat VIC 3350",
        "Relationship Type": "Owner",
      },
    ]);
    const { job } = await createImportJobFromFile(brokerage.id, user.id, csvFile(csv));
    await runMappingAndValidation(job.id, brokerage.id, MAPPING);
    await buildImportPreview(job.id, brokerage.id);
    await runPlanAndExecute(job.id, brokerage.id, user.id);

    const rollback = await rollbackImportJob(job.id, brokerage.id);
    assert.ok(rollback.entries.length > 0);
    assert.ok(rollback.entries.every((e) => e.rolledBack), "nothing else referenced these fixture rows, so rollback should fully succeed");

    const partyRows = await db.select().from(parties).where(eq(parties.brokerageId, brokerage.id));
    assert.equal(partyRows.length, 0);
    const propertyRows = await db.select().from(properties).where(eq(properties.brokerageId, brokerage.id));
    assert.equal(propertyRows.length, 0);
    const relRows = await db.select().from(growRelationships).where(eq(growRelationships.brokerageId, brokerage.id));
    assert.equal(relRows.length, 0);

    const [reloadedJob] = await db.select().from(importJobs).where(eq(importJobs.id, job.id));
    assert.equal(reloadedJob?.status, "ROLLED_BACK");
  } finally {
    await cleanupBrokerage(brokerage.id);
  }
});

test("rejects unidentifiable rows and surfaces them through the rejected-rows CSV export", async () => {
  const brokerage = await makeBrokerage("Import Test - rejected rows");
  const user = await makeUser(brokerage.id, "rejected");
  try {
    const csv = toCsv([
      {
        "First Name": "",
        "Last Name": "",
        Email: "",
        Mobile: "",
        "Property Address": "9 Melaleuca Street, Darwin NT 0800",
        "Relationship Type": "Owner",
      },
      {
        "First Name": "Good",
        "Last Name": "Row",
        Email: "good.row@import-test.local",
        Mobile: "0400 111 222",
        "Property Address": "",
        "Relationship Type": "",
      },
    ]);
    const { job } = await createImportJobFromFile(brokerage.id, user.id, csvFile(csv));
    const validation = await runMappingAndValidation(job.id, brokerage.id, MAPPING);
    assert.equal(validation.rejectedRows, 1);
    assert.equal(validation.validRows, 1);

    const rejectedCsv = await exportRejectedRecordsCsv(job.id, brokerage.id);
    assert.ok(rejectedCsv.includes("Import Errors"));
    assert.ok(rejectedCsv.toLowerCase().includes("nothing to identify a contact by"));
  } finally {
    await cleanupBrokerage(brokerage.id);
  }
});

// AE Step 2 closure -- Part E (static analysis). exportRejectedRecordsCsv
// preserves an uploaded row's original values verbatim so an agent can fix
// and re-upload them -- which, before this pass, meant a cell value
// starting with =, +, -, or @ would round-trip straight into the exported
// CSV unmodified, and be interpreted as a formula (not plain text) by
// Excel/Sheets/LibreOffice when that file is opened. This is the standard
// "CSV/formula injection" class: an uploaded import file is exactly the
// kind of file an external, untrusted party (a vendor, a buyer, anyone
// whose data an agent imports on their behalf) can shape. Confirms the
// fix: any such value is now re-emitted with a leading `'`, which every
// mainstream spreadsheet application treats as forcing plain-text
// interpretation, instead of being passed through unmodified.
test("neutralises formula-injection-shaped values in the rejected-rows CSV export", async () => {
  const brokerage = await makeBrokerage("Import Test - CSV formula injection");
  const user = await makeUser(brokerage.id, "csv-injection");
  try {
    const csv = toCsv([
      {
        "First Name": "",
        "Last Name": "",
        Email: "",
        Mobile: "",
        "Property Address": "=1+1",
        "Relationship Type": "Owner",
      },
    ]);
    const { job } = await createImportJobFromFile(brokerage.id, user.id, csvFile(csv));
    const validation = await runMappingAndValidation(job.id, brokerage.id, MAPPING);
    assert.equal(validation.rejectedRows, 1);

    const rejectedCsv = await exportRejectedRecordsCsv(job.id, brokerage.id);
    assert.ok(
      rejectedCsv.includes("'=1+1"),
      "a formula-shaped cell value must be re-emitted with a neutralising leading quote",
    );
    assert.ok(
      !/(?<!')=1\+1/.test(rejectedCsv),
      "the raw, un-neutralised formula-shaped value must never appear in the export",
    );
  } finally {
    await cleanupBrokerage(brokerage.id);
  }
});

test("keeps warning-level rows importable -- an unrecognised relationship type and an invalid email do not block the row", async () => {
  const brokerage = await makeBrokerage("Import Test - warnings");
  const user = await makeUser(brokerage.id, "warnings");
  try {
    const csv = toCsv([
      {
        "First Name": "Warn",
        "Last Name": "Case",
        Email: "not-a-real-email",
        Mobile: "0466 333 444",
        "Property Address": "21 Currawong Rd, Hobart TAS 7000",
        "Relationship Type": "Best Friend",
      },
    ]);
    const { job } = await createImportJobFromFile(brokerage.id, user.id, csvFile(csv));
    const validation = await runMappingAndValidation(job.id, brokerage.id, MAPPING);
    assert.equal(validation.rejectedRows, 0);
    assert.equal(validation.warningRows, 1);

    await buildImportPreview(job.id, brokerage.id);
    const result = await runPlanAndExecute(job.id, brokerage.id, user.id);
    assert.equal(result.contactsCreated, 1);
    assert.equal(result.relationshipsCreated, 1);

    const relRows = await db.select().from(growRelationships).where(eq(growRelationships.brokerageId, brokerage.id));
    assert.equal(relRows.length, 1);
    // An unrecognised relationship type is never guessed or dropped -- it
    // lands in PendingReview so a human decides, per the dedup/relationship
    // philosophy the whole engine follows.
    assert.equal(relRows[0]?.relationshipType, "unknown_pending_review");
    assert.equal(relRows[0]?.status, "PendingReview");
  } finally {
    await cleanupBrokerage(brokerage.id);
  }
});
