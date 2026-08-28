// B.31 -- performance check for the Stage B import pipeline. Generates a
// synthetic but realistic AU dataset, drives it through the full pipeline
// exactly like a real upload would, and prints per-stage timings plus
// throughput (rows/sec). Cleans up everything it creates. Run with:
//   pnpm exec tsx src/lib/import/__tests__/perf-check.ts <rowCount>
import { eq } from "drizzle-orm";
import { db, brokerages, users, parties, properties, growRelationships, importJobs, importRecords } from "@aee/db";
import {
  createImportJobFromFile,
  runMappingAndValidation,
  buildImportPreview,
  buildExecutionPlan,
} from "../pipeline.js";
import { executeImportBatch } from "../execute.js";
import type { UploadedFileLike } from "../fileValidation.js";
import type { ColumnMapping } from "../mapping.js";

const ROW_COUNT = Number(process.argv[2] ?? 5000);

const FIRST_NAMES = ["Olivia", "William", "Charlotte", "Jack", "Amelia", "Noah", "Isla", "Thomas", "Mia", "Lucas", "Ava", "Henry", "Grace", "Oliver", "Chloe", "Ethan", "Zoe", "James", "Ruby", "Liam"];
const LAST_NAMES = ["Smith", "Jones", "Williams", "Brown", "Wilson", "Taylor", "Nguyen", "Chen", "Lee", "Kelly", "Ryan", "Walker", "Robinson", "Mitchell", "Campbell", "Anderson", "Thompson", "White", "Martin", "Clarke"];
const SUBURBS: [string, string, string][] = [
  ["Bondi", "NSW", "2026"], ["Toowong", "QLD", "4066"], ["Glenelg", "SA", "5045"], ["Fremantle", "WA", "6160"],
  ["Ballarat", "VIC", "3350"], ["Hobart", "TAS", "7000"], ["Darwin", "NT", "0800"], ["Cairns", "QLD", "4870"],
  ["Newtown", "NSW", "2042"], ["Fitzroy", "VIC", "3065"],
];
const REL_TYPES = ["Owner", "Co Owner", "Tenant", "Landlord", "Buyer", "Seller", "Investor"];
const STREETS = ["Wattle", "Banksia", "Grevillea", "Melaleuca", "Jacaranda", "Currawong", "Hibiscus", "Acacia"];

function seededRow(i: number) {
  const first = FIRST_NAMES[i % FIRST_NAMES.length];
  const last = LAST_NAMES[(i * 7) % LAST_NAMES.length];
  const [suburb, state, postcode] = SUBURBS[i % SUBURBS.length];
  const street = STREETS[i % STREETS.length];
  // Deliberate row-to-row duplication (~5%) to exercise dedup under load,
  // not just a purely unique dataset.
  const isDuplicateOfPrevious = i > 0 && i % 20 === 0;
  const emailFirst = isDuplicateOfPrevious ? FIRST_NAMES[(i - 1) % FIRST_NAMES.length] : first;
  const emailLast = isDuplicateOfPrevious ? LAST_NAMES[((i - 1) * 7) % LAST_NAMES.length] : last;
  return {
    "First Name": first,
    "Last Name": last,
    Email: `${emailFirst.toLowerCase()}.${emailLast.toLowerCase()}${isDuplicateOfPrevious ? "" : i}@perf-test.local`,
    Mobile: `04${String(10000000 + (i % 90000000)).padStart(8, "0")}`,
    "Property Address": `${(i % 300) + 1} ${street} Street, ${suburb} ${state} ${postcode}`,
    "Relationship Type": REL_TYPES[i % REL_TYPES.length],
  };
}

const MAPPING: ColumnMapping = {
  "First Name": "person.firstName",
  "Last Name": "person.lastName",
  Email: "person.email",
  Mobile: "person.mobile",
  "Property Address": "property.address.full",
  "Relationship Type": "relationship.type",
};

function toCsv(rows: Record<string, string>[]): string {
  const headers = Object.keys(MAPPING);
  const esc = (v: string) => (v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h] ?? "")).join(","))].join("\n");
}

function csvFile(csvText: string): UploadedFileLike {
  return { originalname: "perf.csv", mimetype: "text/csv", size: Buffer.byteLength(csvText), buffer: Buffer.from(csvText, "utf-8") };
}

async function main() {
  console.log(`Performance check: ${ROW_COUNT} rows`);
  const [brokerage] = await db.insert(brokerages).values({ name: `Perf Test ${ROW_COUNT} rows` }).returning();
  const [user] = await db
    .insert(users)
    .values({ authProviderId: `perf-test-${Date.now()}`, email: "perf@perf-test.local", firstName: "Perf", lastName: "Tester", role: "Agent", brokerageId: brokerage.id })
    .returning();

  const timings: Record<string, number> = {};
  try {
    const rows = Array.from({ length: ROW_COUNT }, (_, i) => seededRow(i));
    const csv = toCsv(rows);
    console.log(`CSV size: ${(Buffer.byteLength(csv) / 1024).toFixed(1)} KB`);

    let t0 = Date.now();
    const { job } = await createImportJobFromFile(brokerage.id, user.id, csvFile(csv));
    timings.ingestAndParse = Date.now() - t0;

    t0 = Date.now();
    const validation = await runMappingAndValidation(job.id, brokerage.id, MAPPING);
    timings.mapAndValidate = Date.now() - t0;
    console.log(`Validation: valid=${validation.validRows} warning=${validation.warningRows} rejected=${validation.rejectedRows}`);

    t0 = Date.now();
    const preview = await buildImportPreview(job.id, brokerage.id);
    timings.dedupAndPreview = Date.now() - t0;
    console.log(
      `Preview: contactsNew=${preview.summary.contactsNew} propertiesNew=${preview.summary.propertiesNew} relationships=${preview.summary.relationshipsTotal} needsReview=${preview.summary.duplicatesRequiringReview}`
    );

    t0 = Date.now();
    const plan = await buildExecutionPlan(job.id, brokerage.id);
    timings.buildExecutionPlan = Date.now() - t0;

    t0 = Date.now();
    const result = await executeImportBatch({
      importJobId: job.id,
      brokerageId: brokerage.id,
      agentId: user.id,
      contacts: plan.contacts,
      contactProperties: plan.contactProperties,
      relationships: plan.relationships,
    });
    timings.executeImportBatch = Date.now() - t0;
    console.log(
      `Executed: contactsCreated=${result.contactsCreated} propertiesCreated=${result.propertiesCreated} relationshipsCreated=${result.relationshipsCreated}`
    );

    const totalMs = Object.values(timings).reduce((a, b) => a + b, 0);
    console.log("\n--- Timings (ms) ---");
    for (const [k, v] of Object.entries(timings)) console.log(`${k}: ${v}ms`);
    console.log(`TOTAL: ${totalMs}ms (${(ROW_COUNT / (totalMs / 1000)).toFixed(1)} rows/sec end-to-end)`);

    // Sanity: confirm what actually landed in the DB matches the reported counts.
    const partyCount = (await db.select().from(parties).where(eq(parties.brokerageId, brokerage.id))).length;
    const propertyCount = (await db.select().from(properties).where(eq(properties.brokerageId, brokerage.id))).length;
    const relCount = (await db.select().from(growRelationships).where(eq(growRelationships.brokerageId, brokerage.id))).length;
    console.log(`\nDB counts: parties=${partyCount} properties=${propertyCount} relationships=${relCount}`);
  } finally {
    const jobIds = (await db.select({ id: importJobs.id }).from(importJobs).where(eq(importJobs.brokerageId, brokerage.id))).map((j) => j.id);
    for (const jobId of jobIds) await db.delete(importRecords).where(eq(importRecords.importJobId, jobId));
    await db.delete(importJobs).where(eq(importJobs.brokerageId, brokerage.id));
    await db.delete(growRelationships).where(eq(growRelationships.brokerageId, brokerage.id));
    await db.delete(properties).where(eq(properties.brokerageId, brokerage.id));
    await db.delete(parties).where(eq(parties.brokerageId, brokerage.id));
    await db.delete(users).where(eq(users.brokerageId, brokerage.id));
    await db.delete(brokerages).where(eq(brokerages.id, brokerage.id));
    console.log("\nCleanup complete.");
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
