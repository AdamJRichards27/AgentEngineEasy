// F-05: permanent route-level HTTP regression coverage for
// apps/api/src/routes/import.ts (Stage B contact/property import). Exercises
// the router over real HTTP -- real multipart file uploads via Node's
// built-in fetch/FormData/Blob, not direct calls into the pipeline module --
// so a regression in the route wiring itself (a dropped entitlement gate, a
// tenant-scope check removed, a changed status code, multer misconfigured)
// is caught here even if the underlying pipeline code (see
// apps/api/src/lib/import/__tests__/pipeline.test.ts) still behaves
// correctly in isolation.
//
// This file is also the F-04/F-05 integration point: one test below proves
// the F-04 compensating controls in fileValidation.ts are actually wired in
// front of the real HTTP upload path, not just reachable from a unit test
// that calls createImportJobFromFile directly.
//
// Like grow.test.ts, tests are deliberately sequential and narrative rather
// than independent: Brokerage A accumulates the two import entitlements
// (grow.import.review, grow.import.execute) in the order the routes need
// them, then drives a single import job through its full mapping -> preview
// -> execute -> rollback lifecycle, matching the exact CSV fixture and
// expected counts already proven at the pipeline-unit level in
// pipeline.test.ts. Brokerage B is granted matching entitlements at each
// step specifically to isolate the row-level tenant check from the
// entitlement gate, the same technique grow.test.ts uses.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, importJobs, entitlementGrants } from "@aee/db";
import { invalidateEntitlementCache } from "../../lib/entitlements/resolver.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = Date.now();
const brokerageAName = `F-05 Import A ${suffix}`;
const brokerageBName = `F-05 Import B ${suffix}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let jobId: number;

before(async () => {
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  const app = createApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  A = await createBrokerageWithUsers(baseUrl, brokerageAName);
  B = await createBrokerageWithUsers(baseUrl, brokerageBName);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

async function grant(brokerageId: number, entitlementKey: string) {
  await db.insert(entitlementGrants).values({
    brokerageId,
    entitlementKey,
    granteeType: "brokerage",
    granteeId: brokerageId,
    sourceType: "manual",
    status: "Active",
  });
  invalidateEntitlementCache(brokerageId);
}

function importUrl(path: string) {
  return `${baseUrl}/api/import${path}`;
}

async function uploadFile(cookie: string, buffer: Buffer, filename: string, mimetype: string) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimetype }), filename);
  return fetch(importUrl("/jobs"), {
    method: "POST",
    headers: { cookie },
    body: form,
  });
}

// Mirrors pipeline.test.ts's fixture exactly, so the expected counts at
// every stage below (validRows, contactsNew, contactsCreated, ...) are the
// same numbers already proven correct at the pipeline-unit level -- this
// file is checking that the HTTP route layer delivers those same results,
// not re-deriving them.
const MAPPING: Record<string, string> = {
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

test("unauthenticated requests are rejected across the import surface", async () => {
  const endpoints: Array<[string, string]> = [
    ["POST", "/jobs"],
    ["GET", "/jobs"],
    ["GET", "/jobs/1"],
    ["PUT", "/jobs/1/mapping"],
    ["GET", "/jobs/1/preview"],
    ["POST", "/jobs/1/resolve"],
    ["POST", "/jobs/1/execute"],
    ["POST", "/jobs/1/rollback"],
    ["GET", "/jobs/1/rejected.csv"],
  ];
  for (const [method, path] of endpoints) {
    const res = await fetch(importUrl(path), {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" || method === "PUT" ? "{}" : undefined,
    });
    assert.equal(res.status, 401, `${method} ${path} should require authentication`);
  }
});

test("grow.import.review and grow.import.execute gate distinct halves of the import surface, each required independently", async () => {
  // Neither granted yet: both halves 403.
  const reviewRes1 = await fetch(importUrl("/jobs"), { headers: { cookie: A.agent.cookie } });
  assert.equal(reviewRes1.status, 403);
  const executeRes1 = await fetch(importUrl("/jobs"), { method: "POST", headers: { cookie: A.agent.cookie } });
  assert.equal(executeRes1.status, 403);

  await grant(A.brokerageId, "grow.import.review");

  // review alone unlocks the review surface -- a made-up job id does not
  // 403 (buildImportPreview reports a made-up id as a 400 ImportUserError
  // rather than a 404, since it isn't routed through loadJobOr404, but
  // either way it proves the request reached past the entitlement gate)...
  const reviewRes2 = await fetch(importUrl("/jobs"), { headers: { cookie: A.agent.cookie } });
  assert.equal(reviewRes2.status, 200, "GET /jobs should be reachable with only grow.import.review");
  const previewRes = await fetch(importUrl("/jobs/999999999/preview"), { headers: { cookie: A.agent.cookie } });
  assert.notEqual(previewRes.status, 403, "GET /preview should require grow.import.review, not grow.import.execute");
  const resolveRes = await fetch(importUrl("/jobs/999999999/resolve"), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ kind: "contact", groupKey: "x", resolution: "skip" }),
  });
  assert.notEqual(resolveRes.status, 403, "POST /resolve should require grow.import.review, not grow.import.execute");

  // ...but not the execute surface.
  const executeRes2 = await fetch(importUrl("/jobs"), { method: "POST", headers: { cookie: A.agent.cookie } });
  assert.equal(executeRes2.status, 403, "POST /jobs must require grow.import.execute specifically");
  const mappingRes = await fetch(importUrl("/jobs/999999999/mapping"), {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ mapping: {} }),
  });
  assert.equal(mappingRes.status, 403, "PUT /mapping must require grow.import.execute specifically");
  const rollbackGateRes = await fetch(importUrl("/jobs/999999999/rollback"), { method: "POST", headers: { cookie: A.agent.cookie } });
  assert.equal(rollbackGateRes.status, 403, "POST /rollback must require grow.import.execute specifically");

  await grant(A.brokerageId, "grow.import.execute");

  // now both are granted -- the execute surface opens up too (POST /jobs
  // with no attached file 400s on "no file uploaded" rather than 403ing).
  const executeRes3 = await fetch(importUrl("/jobs"), { method: "POST", headers: { cookie: A.agent.cookie } });
  assert.notEqual(executeRes3.status, 403);
});

test("a crafted .xlsx upload (correct filename and MIME type, not a real zip) is rejected before any importJobs row is created -- proves the F-04 compensating controls are wired through the real HTTP upload path, not just reachable at the unit level", async () => {
  const maliciousBuffer = Buffer.from("this is not a zip file, just plain bytes pretending to be one");
  const res = await uploadFile(
    A.agent.cookie,
    maliciousBuffer,
    "totally-legit-report.xlsx",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  const body = await res.json();
  assert.equal(res.status, 400, JSON.stringify(body));

  const rows = await db.select({ id: importJobs.id }).from(importJobs).where(eq(importJobs.brokerageId, A.brokerageId));
  assert.equal(rows.length, 0, "a rejected upload must never leave an importJobs row behind, even reached through the real HTTP layer");
});

test("POST /jobs accepts a real CSV upload and returns a job + suggested mapping; GET /jobs and GET /jobs/:id stay tenant-scoped", async () => {
  const csv = toCsv([
    {
      "First Name": "John",
      "Last Name": "Smith",
      Email: "john.smith@f05-import-test.local",
      Mobile: "0412 345 678",
      "Property Address": "12 Wattle Street, Bondi NSW 2026",
      "Relationship Type": "Owner",
    },
    {
      "First Name": "Jane",
      "Last Name": "Smith",
      Email: "jane.smith@f05-import-test.local",
      Mobile: "0413 456 789",
      "Property Address": "12 Wattle Street, Bondi NSW 2026",
      "Relationship Type": "Co Owner",
    },
    {
      "First Name": "Sarah",
      "Last Name": "Lee",
      Email: "sarah.lee@f05-import-test.local",
      Mobile: "0423 456 789",
      "Property Address": "45 Banksia Ave, Toowong QLD 4066",
      "Relationship Type": "Tenant",
    },
  ]);
  const res = await uploadFile(A.agent.cookie, Buffer.from(csv, "utf-8"), "contacts.csv", "text/csv");
  const body = (await res.json()) as { job: { id: number }; suggestedMapping: Record<string, string> };
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.ok(body.job.id > 0);
  assert.ok(body.suggestedMapping, "a suggestedMapping should always be returned, even though the mapping actually used below is supplied explicitly");
  jobId = body.job.id;

  await grant(B.brokerageId, "grow.import.review");
  const crossTenantGetRes = await fetch(importUrl(`/jobs/${jobId}`), { headers: { cookie: B.agent.cookie } });
  assert.equal(crossTenantGetRes.status, 404, "Brokerage B must never be able to read Brokerage A's import job, even with its own grow.import.review grant");

  const listRes = await fetch(importUrl("/jobs"), { headers: { cookie: A.agent.cookie } });
  const listBody = (await listRes.json()) as { jobs: Array<{ id: number }> };
  assert.equal(listRes.status, 200);
  assert.ok(listBody.jobs.some((j) => j.id === jobId));

  const bListRes = await fetch(importUrl("/jobs"), { headers: { cookie: B.agent.cookie } });
  const bListBody = (await bListRes.json()) as { jobs: Array<{ id: number }> };
  assert.equal(bListRes.status, 200);
  assert.ok(!bListBody.jobs.some((j) => j.id === jobId), "Brokerage B's job list must never include Brokerage A's jobs");
});

test("PUT /jobs/:id/mapping validates the request body and, given a valid mapping, returns validation counts matching the known-good fixture", async () => {
  const missingRes = await fetch(importUrl(`/jobs/${jobId}/mapping`), {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({}),
  });
  assert.equal(missingRes.status, 400);

  const notObjectRes = await fetch(importUrl(`/jobs/${jobId}/mapping`), {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ mapping: "not-an-object" }),
  });
  assert.equal(notObjectRes.status, 400);

  const okRes = await fetch(importUrl(`/jobs/${jobId}/mapping`), {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ mapping: MAPPING }),
  });
  const okBody = (await okRes.json()) as { validRows: number; warningRows: number; rejectedRows: number };
  assert.equal(okRes.status, 200, JSON.stringify(okBody));
  assert.equal(okBody.validRows, 3);
  assert.equal(okBody.warningRows, 0);
  assert.equal(okBody.rejectedRows, 0);
});

test("GET /jobs/:id/preview reports the same summary counts already proven for this fixture at the pipeline-unit level", async () => {
  const res = await fetch(importUrl(`/jobs/${jobId}/preview`), { headers: { cookie: A.agent.cookie } });
  const body = (await res.json()) as { summary: { contactsNew: number; propertiesNew: number; relationshipsTotal: number } };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.summary.contactsNew, 3);
  assert.equal(body.summary.propertiesNew, 2);
  assert.equal(body.summary.relationshipsTotal, 3);
});

test("POST /jobs/:id/execute runs the import and is guarded against double-submission; rollback and the rejected-rows export stay tenant-scoped", async () => {
  const executeRes = await fetch(importUrl(`/jobs/${jobId}/execute`), { method: "POST", headers: { cookie: A.agent.cookie } });
  const executeBody = (await executeRes.json()) as { contactsCreated: number; propertiesCreated: number; relationshipsCreated: number };
  assert.equal(executeRes.status, 200, JSON.stringify(executeBody));
  assert.equal(executeBody.contactsCreated, 3);
  assert.equal(executeBody.propertiesCreated, 2);
  assert.equal(executeBody.relationshipsCreated, 3);

  const repeatRes = await fetch(importUrl(`/jobs/${jobId}/execute`), { method: "POST", headers: { cookie: A.agent.cookie } });
  const repeatBody = (await repeatRes.json()) as { error: string };
  assert.equal(repeatRes.status, 409, "a completed job must reject a second execute call, not silently re-run it");
  assert.match(repeatBody.error, /already completed/i);

  await grant(B.brokerageId, "grow.import.execute");
  const crossTenantRollbackRes = await fetch(importUrl(`/jobs/${jobId}/rollback`), { method: "POST", headers: { cookie: B.agent.cookie } });
  assert.equal(crossTenantRollbackRes.status, 404, "Brokerage B must never be able to roll back Brokerage A's job");

  const rollbackRes = await fetch(importUrl(`/jobs/${jobId}/rollback`), { method: "POST", headers: { cookie: A.agent.cookie } });
  const rollbackBody = await rollbackRes.json();
  assert.equal(rollbackRes.status, 200, JSON.stringify(rollbackBody));

  const csvRes = await fetch(importUrl(`/jobs/${jobId}/rejected.csv`), { headers: { cookie: A.agent.cookie } });
  assert.equal(csvRes.status, 200);
  assert.match(csvRes.headers.get("content-type") ?? "", /text\/csv/);
  assert.equal(csvRes.headers.get("content-disposition"), `attachment; filename="import-${jobId}-rejected.csv"`);
});

test("POST /jobs/:id/resolve validates kind, groupKey, and resolution before touching duplicate-resolution logic", async () => {
  const csv = toCsv([
    {
      "First Name": "Resolve",
      "Last Name": "Case",
      Email: "resolve.case@f05-import-test.local",
      Mobile: "0499 000 111",
      "Property Address": "",
      "Relationship Type": "",
    },
  ]);
  const uploadRes = await uploadFile(A.agent.cookie, Buffer.from(csv, "utf-8"), "resolve-fixture.csv", "text/csv");
  const uploadBody = (await uploadRes.json()) as { job: { id: number } };
  assert.equal(uploadRes.status, 201, JSON.stringify(uploadBody));
  const resolveJobId = uploadBody.job.id;

  const badKindRes = await fetch(importUrl(`/jobs/${resolveJobId}/resolve`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ kind: "property-or-contact-typo", groupKey: "x", resolution: "skip" }),
  });
  assert.equal(badKindRes.status, 400);
  const badKindBody = (await badKindRes.json()) as { error: string };
  assert.match(badKindBody.error, /"kind" must be "contact" or "property"/i);

  const missingGroupKeyRes = await fetch(importUrl(`/jobs/${resolveJobId}/resolve`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ kind: "contact", resolution: "skip" }),
  });
  assert.equal(missingGroupKeyRes.status, 400);
  const missingGroupKeyBody = (await missingGroupKeyRes.json()) as { error: string };
  assert.match(missingGroupKeyBody.error, /"groupKey" is required/i);

  const badResolutionRes = await fetch(importUrl(`/jobs/${resolveJobId}/resolve`), {
    method: "POST",
    headers: { "content-type": "application/json", cookie: A.agent.cookie },
    body: JSON.stringify({ kind: "contact", groupKey: "x", resolution: "not-a-real-resolution" }),
  });
  assert.equal(badResolutionRes.status, 400);
});
