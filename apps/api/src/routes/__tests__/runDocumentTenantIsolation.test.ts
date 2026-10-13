// R-F44. Property-backed documents keep brokerage_id NULL (migration 0022).
// Every read, list, update, delete, and download path must still resolve the
// owning brokerage from the parent property or transaction inside SQL. A
// foreign document id is a 404 with the same body as a missing id, and the
// response carries no filename, size, or existence cue.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import { db, documentObjectVersions, documents } from "@aee/db";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
    ? process.env.SESSION_SECRET
    : "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";

let server: Server;
let baseUrl: string;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };

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
  A = await createBrokerageWithUsers(baseUrl, `R-F44 Documents A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `R-F44 Documents B ${suffix}`);
});

after(async () => {
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function headersFor(cookie: string) {
  return { "content-type": "application/json", cookie };
}

async function readBody(res: Response): Promise<{ text: string; json: unknown }> {
  const text = await res.text();
  let json: unknown = text;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { text, json };
}

function assertBareNotFound(res: Response, parsed: { text: string; json: unknown }, leaked: string[]) {
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("content-disposition"), null);
  assert.deepEqual(parsed.json, { error: "Not found" });
  const blob = `${parsed.text}\n${[...res.headers.entries()].map(([key, value]) => `${key}: ${value}`).join("\n")}`;
  for (const secret of leaked) {
    assert.equal(blob.toLowerCase().includes(secret.toLowerCase()), false, `response disclosed ${secret}`);
  }
  for (const field of ["byteSize", "displayFilename", "originalFilename", "objectStorageKey", "storageObjectKey"]) {
    assert.equal(blob.includes(field), false, `response disclosed ${field}`);
  }
}

async function createReadyToList(cookie: string, address: string): Promise<{ propertyId: number; packageId: number }> {
  const propertyRes = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: headersFor(cookie),
    body: JSON.stringify({ formattedAddress: address, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  assert.equal(propertyRes.status, 201);
  const { property } = (await propertyRes.json()) as { property: { id: number } };
  const sellerRes = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: headersFor(cookie),
    body: JSON.stringify({
      propertyId: property.id,
      role: "Seller",
      firstName: "Sam",
      lastName: "Seller",
      email: `seller-${suffix}-${property.id}@example.com`,
    }),
  });
  assert.equal(sellerRes.status, 201);
  const readyRes = await fetch(`${baseUrl}/api/properties/${property.id}/ready-to-list`, {
    method: "POST",
    headers: headersFor(cookie),
  });
  assert.equal(readyRes.status, 200);
  const { documentPackage } = (await readyRes.json()) as { documentPackage: { id: number } };
  return { propertyId: property.id, packageId: documentPackage.id };
}

async function listPackage(cookie: string, propertyId: number) {
  const res = await fetch(`${baseUrl}/api/documents/packages/by-property/${propertyId}`, { headers: { cookie } });
  const parsed = await readBody(res);
  return { res, parsed };
}

async function upload(cookie: string, documentId: number, filename: string, bytes: string) {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: "text/plain" }), filename);
  const res = await fetch(`${baseUrl}/api/documents/${documentId}/versions`, {
    method: "POST",
    headers: { cookie },
    body: form,
  });
  const parsed = await readBody(res);
  return { res, parsed };
}

async function ownedDraft() {
  const filename = `secret-agreement-${suffix}.txt`;
  const bytes = `confidential-bytes-${suffix}`;
  const { propertyId } = await createReadyToList(A.agent.cookie, `${Math.floor(Math.random() * 1_000_000)} R-F44 ${suffix} Rd`);
  const listing = await listPackage(A.agent.cookie, propertyId);
  assert.equal(listing.res.status, 200);
  const body = listing.parsed.json as {
    documents: Array<{ id: number; title: string; brokerageId: number | null }>;
  };
  const doc = body.documents[0];
  assert.ok(doc);
  const [row] = await db
    .select({
      id: documents.id,
      brokerageId: documents.brokerageId,
      title: documents.title,
      status: documents.status,
      objectStorageKey: documents.objectStorageKey,
    })
    .from(documents)
    .where(eq(documents.id, doc.id));
  assert.equal(row.brokerageId, null);
  return { propertyId, documentId: doc.id, title: row.title, filename, bytes, status: row.status, objectStorageKey: row.objectStorageKey };
}

async function versionCount(documentId: number) {
  const rows = await db
    .select({ id: documentObjectVersions.id })
    .from(documentObjectVersions)
    .where(eq(documentObjectVersions.documentId, documentId));
  return rows.length;
}

test("NULL brokerage_id documents stay scoped through the parent, and same-brokerage list, read, update, and download are unchanged", async () => {
  const owned = await ownedDraft();
  const listing = await listPackage(A.agent.cookie, owned.propertyId);
  assert.equal(listing.res.status, 200);
  const listed = listing.parsed.json as { documents: Array<{ id: number; title: string }> };
  assert.ok(listed.documents.some((document) => document.id === owned.documentId && document.title === owned.title));

  const empty = await fetch(`${baseUrl}/api/documents/${owned.documentId}/content`, { headers: { cookie: A.agent.cookie } });
  const emptyBody = await readBody(empty);
  assert.equal(empty.status, 404);
  assert.deepEqual(emptyBody.json, { error: "No stored content for this document" });

  const uploaded = await upload(A.agent.cookie, owned.documentId, owned.filename, owned.bytes);
  assert.equal(uploaded.res.status, 201);
  const uploadedBody = uploaded.parsed.json as { version: { displayFilename: string; byteSize: number } };
  assert.equal(uploadedBody.version.displayFilename, owned.filename);
  assert.equal(uploadedBody.version.byteSize, Buffer.byteLength(owned.bytes));

  const content = await fetch(`${baseUrl}/api/documents/${owned.documentId}/content`, { headers: { cookie: A.agent.cookie } });
  assert.equal(content.status, 200);
  assert.match(content.headers.get("content-disposition") ?? "", /attachment/);
  assert.equal(await content.text(), owned.bytes);

  const link = await fetch(`${baseUrl}/api/documents/${owned.documentId}/signed-download`, {
    method: "POST",
    headers: { cookie: A.agent.cookie },
  });
  const linkBody = await readBody(link);
  assert.equal(link.status, 200);
  assert.match((linkBody.json as { url: string }).url, /^\/api\/documents\/signed-download\/\d+\?expires=\d+&signature=/);

  const removed = await fetch(`${baseUrl}/api/documents/${owned.documentId}`, {
    method: "DELETE",
    headers: { cookie: A.agent.cookie },
  });
  const removedBody = await readBody(removed);
  assert.equal(removed.status, 404);
  assert.equal(removedBody.text.toLowerCase().includes(owned.title.toLowerCase()), false);
  assert.equal(removedBody.text.includes(owned.filename), false);
  const [stillThere] = await db.select({ id: documents.id }).from(documents).where(eq(documents.id, owned.documentId));
  assert.ok(stillThere);
});

test("cross-brokerage read, list, update, delete, and download are 404 with no disclosure", async () => {
  const owned = await ownedDraft();
  const uploaded = await upload(A.agent.cookie, owned.documentId, owned.filename, owned.bytes);
  assert.equal(uploaded.res.status, 201);
  const leaked = [owned.title, owned.filename, owned.bytes];
  const versionsBefore = await versionCount(owned.documentId);
  const [before] = await db
    .select({ status: documents.status, objectStorageKey: documents.objectStorageKey })
    .from(documents)
    .where(eq(documents.id, owned.documentId));

  const foreignRead = await fetch(`${baseUrl}/api/documents/${owned.documentId}/content`, { headers: { cookie: B.agent.cookie } });
  const foreignReadBody = await readBody(foreignRead);
  const missingRead = await fetch(`${baseUrl}/api/documents/999999999/content`, { headers: { cookie: B.agent.cookie } });
  const missingReadBody = await readBody(missingRead);
  assertBareNotFound(foreignRead, foreignReadBody, leaked);
  assert.deepEqual(foreignReadBody.json, missingReadBody.json);

  const foreignList = await listPackage(B.agent.cookie, owned.propertyId);
  assertBareNotFound(foreignList.res, foreignList.parsed, leaked);
  const workspace = await fetch(`${baseUrl}/api/properties/${owned.propertyId}/workspace`, { headers: { cookie: B.agent.cookie } });
  const workspaceBody = await readBody(workspace);
  assertBareNotFound(workspace, workspaceBody, leaked);

  const foreignUpdate = await upload(B.agent.cookie, owned.documentId, `intruder-${suffix}.txt`, `intruder-bytes-${suffix}`);
  const missingUpdate = await upload(B.agent.cookie, 999999999, `intruder-${suffix}.txt`, `intruder-bytes-${suffix}`);
  assertBareNotFound(foreignUpdate.res, foreignUpdate.parsed, [...leaked, `intruder-${suffix}.txt`]);
  assert.deepEqual(foreignUpdate.parsed.json, missingUpdate.parsed.json);
  const [after] = await db
    .select({ status: documents.status, objectStorageKey: documents.objectStorageKey })
    .from(documents)
    .where(eq(documents.id, owned.documentId));
  assert.deepEqual(after, before);
  assert.equal(await versionCount(owned.documentId), versionsBefore);

  const foreignDelete = await fetch(`${baseUrl}/api/documents/${owned.documentId}`, {
    method: "DELETE",
    headers: { cookie: B.agent.cookie },
  });
  const foreignDeleteBody = await readBody(foreignDelete);
  const sameDelete = await fetch(`${baseUrl}/api/documents/${owned.documentId}`, {
    method: "DELETE",
    headers: { cookie: A.agent.cookie },
  });
  const sameDeleteBody = await readBody(sameDelete);
  assert.equal(foreignDelete.status, 404);
  assert.equal(sameDelete.status, 404);
  assert.deepEqual(foreignDeleteBody.json, sameDeleteBody.json);
  assert.equal(foreignDeleteBody.text.toLowerCase().includes(owned.title.toLowerCase()), false);
  assert.equal(foreignDeleteBody.text.includes(owned.filename), false);
  assert.equal(foreignDeleteBody.text.includes(owned.bytes), false);
  const [survived] = await db.select({ id: documents.id }).from(documents).where(eq(documents.id, owned.documentId));
  assert.ok(survived);

  const foreignDownload = await fetch(`${baseUrl}/api/documents/${owned.documentId}/signed-download`, {
    method: "POST",
    headers: { cookie: B.agent.cookie },
  });
  const foreignDownloadBody = await readBody(foreignDownload);
  const missingDownload = await fetch(`${baseUrl}/api/documents/999999999/signed-download`, {
    method: "POST",
    headers: { cookie: B.agent.cookie },
  });
  const missingDownloadBody = await readBody(missingDownload);
  assertBareNotFound(foreignDownload, foreignDownloadBody, leaked);
  assert.deepEqual(foreignDownloadBody.json, missingDownloadBody.json);
  assert.equal(JSON.stringify(foreignDownloadBody.json).includes("url"), false);
});
