// F-04: end-to-end, DB-backed proof that createImportJobFromFile (pipeline.ts)
// enforces validateUploadedFile's compensating controls BEFORE any database
// write and BEFORE the xlsx parser ever touches the buffer -- not
// just that the unit-level validator returns ok:false in isolation (see
// fileValidation.test.ts / excelParser.test.ts for that), but that a
// malicious upload leaves no trace in the real importJobs table.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, brokerages, users, importJobs } from "@aee/db";
import { createImportJobFromFile, ImportUserError } from "../pipeline.js";
import type { UploadedFileLike } from "../fileValidation.js";

async function makeBrokerage(name: string) {
  const [row] = await db.insert(brokerages).values({ name }).returning();
  return row;
}

async function makeUser(brokerageId: number, label: string) {
  const [row] = await db
    .insert(users)
    .values({
      authProviderId: `f04-test-${label}-${randomUUID()}`,
      email: `${label}@f04-test.local`,
      firstName: "F04",
      lastName: "Tester",
      role: "Agent",
      brokerageId,
    })
    .returning();
  return row;
}

async function cleanupBrokerage(brokerageId: number) {
  await db.delete(importJobs).where(eq(importJobs.brokerageId, brokerageId));
  await db.delete(users).where(eq(users.brokerageId, brokerageId));
  await db.delete(brokerages).where(eq(brokerages.id, brokerageId));
}

test("F-04: createImportJobFromFile rejects a malicious upload and never creates an importJobs row", async (t) => {
  const brokerage = await makeBrokerage(`F-04 Pipeline Safety ${randomUUID()}`);
  const agent = await makeUser(brokerage.id, "agent");
  t.after(() => cleanupBrokerage(brokerage.id));

  const maliciousFile: UploadedFileLike = {
    originalname: "totally-legit-report.xlsx",
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 2048,
    // Named and MIME-typed as a real .xlsx, but not a real zip -- exactly
    // the shape a crafted upload aimed at the xlsx parser would take.
    buffer: Buffer.from("this is not a zip file, just plain bytes pretending to be one"),
  };

  await assert.rejects(
    () => createImportJobFromFile(brokerage.id, agent.id, maliciousFile),
    ImportUserError,
  );

  const rows = await db
    .select({ id: importJobs.id })
    .from(importJobs)
    .where(eq(importJobs.brokerageId, brokerage.id));
  assert.equal(rows.length, 0, "a rejected upload must never create an importJobs row");
});

test("F-04: createImportJobFromFile rejects an oversized upload before touching the database", async (t) => {
  const brokerage = await makeBrokerage(`F-04 Pipeline Oversize ${randomUUID()}`);
  const agent = await makeUser(brokerage.id, "agent");
  t.after(() => cleanupBrokerage(brokerage.id));

  const oversizedFile: UploadedFileLike = {
    originalname: "huge-import.csv",
    mimetype: "text/csv",
    size: 26 * 1024 * 1024,
    buffer: Buffer.from("First Name,Last Name\nJane,Smith\n"),
  };

  await assert.rejects(
    () => createImportJobFromFile(brokerage.id, agent.id, oversizedFile),
    ImportUserError,
  );

  const rows = await db
    .select({ id: importJobs.id })
    .from(importJobs)
    .where(eq(importJobs.brokerageId, brokerage.id));
  assert.equal(rows.length, 0);
});
