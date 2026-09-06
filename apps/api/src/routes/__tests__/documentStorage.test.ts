import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import type { ObjectStorageProvider } from "@aee/integration-object-storage";
import { and, eq } from "drizzle-orm";
import { db, auditLogs, documentObjectVersions } from "@aee/db";
import {
  assertDocumentStorageConfigured,
  configuredDocumentWebhookMaxBytes,
  configuredEsignMaxDocumentBytes,
  configuredEsignMaxDocuments,
  configuredMaxDocumentBytes,
  configuredSignedDownloadSeconds,
  configuredRetentionClasses,
  getStoredDocumentContent,
  ingestDocumentVersion,
  reconcilePendingDocumentVersions,
  setDocumentStorageProviderForTests,
} from "../../lib/documentStorage.js";
import { createBrokerageWithUsers, cleanupBrokerages, type DevLoginResult } from "./testSupport.js";

process.env.SESSION_SECRET ??= "test-only-session-secret-not-for-real-use-0123456789";
process.env.ALLOW_DEV_AUTH = "true";
process.env.DOCUMENT_STORAGE_MAX_BYTES = "64";

class MemoryStorage implements ObjectStorageProvider {
  readonly objects = new Map<string, Buffer>();
  readonly putKeys: string[] = [];
  readonly deleteKeys: string[] = [];
  failNextPut: Error | null = null;
  readiness: { ready: boolean; message?: string } = { ready: true };

  async putObject(key: string, content: string | Buffer) {
    this.putKeys.push(key);
    if (this.failNextPut) {
      const error = this.failNextPut;
      this.failNextPut = null;
      throw error;
    }
    this.objects.set(key, Buffer.isBuffer(content) ? Buffer.from(content) : Buffer.from(content));
    return { key };
  }
  async getObject(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) {
      const error = new Error(`Missing object ${key}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return Buffer.from(bytes);
  }
  async headObject(key: string) {
    const bytes = await this.getObject(key);
    return { key, size: bytes.length, checksumSha256: createHash("sha256").update(bytes).digest("hex") };
  }
  async deleteObject(key: string) {
    this.deleteKeys.push(key);
    this.objects.delete(key);
  }
  async createSignedDownload(key: string, expiresInSeconds = 300) {
    await this.headObject(key);
    return { url: `memory://tenant-scoped/${encodeURIComponent(key)}`, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }
  async verifyIntegrity(key: string) {
    const bytes = await this.getObject(key);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    return { valid: true, expectedChecksum: checksum, actualChecksum: checksum };
  }
  async checkReadiness() {
    return this.readiness;
  }
}

let server: Server;
let baseUrl: string;
let A: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
let B: { admin: DevLoginResult; agent: DevLoginResult; brokerageId: number };
const storage = new MemoryStorage();

before(async () => {
  setDocumentStorageProviderForTests(storage);
  const { configureEvents } = await import("../../lib/events.js");
  configureEvents();
  const { createApp } = await import("../../app.js");
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("unexpected server address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const suffix = Date.now();
  A = await createBrokerageWithUsers(baseUrl, `Document storage A ${suffix}`);
  B = await createBrokerageWithUsers(baseUrl, `Document storage B ${suffix}`);
});

after(async () => {
  setDocumentStorageProviderForTests(null);
  await cleanupBrokerages([A?.brokerageId, B?.brokerageId]);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

async function createDocument(cookie: string): Promise<number> {
  const property = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ formattedAddress: `${Date.now()} Storage Street`, state: "NSW", suburb: "Testville", postcode: "2000" }),
  });
  assert.equal(property.status, 201);
  const propertyId = ((await property.json()) as { property: { id: number } }).property.id;
  const seller = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      propertyId,
      role: "Seller",
      firstName: "Storage",
      lastName: "Seller",
      email: `storage-${propertyId}-${Date.now()}@example.com`,
    }),
  });
  assert.equal(seller.status, 201);
  const ready = await fetch(`${baseUrl}/api/properties/${propertyId}/ready-to-list`, { method: "POST", headers: { cookie } });
  assert.equal(ready.status, 200);
  const listing = await fetch(`${baseUrl}/api/documents/packages/by-property/${propertyId}`, { headers: { cookie } });
  const body = (await listing.json()) as { documents: Array<{ id: number }> };
  assert.ok(body.documents[0]);
  return body.documents[0].id;
}

async function prepareESignCompletion(cookie: string): Promise<{
  providerReference: string;
  completedDocuments: Array<{
    documentId: number;
    contentBase64: string;
    filename: string;
    contentType: string;
  }>;
}> {
  const headers = { "content-type": "application/json", cookie };
  const property = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      formattedAddress: `${Date.now()} ESign Retry Street`,
      state: "NSW",
      suburb: "Testville",
      postcode: "2000",
    }),
  });
  assert.equal(property.status, 201);
  const propertyId = ((await property.json()) as { property: { id: number } }).property.id;
  const seller = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      propertyId,
      role: "Seller",
      firstName: "Retry",
      lastName: "Seller",
      email: `esign-retry-${propertyId}@example.com`,
    }),
  });
  assert.equal(seller.status, 201);
  const ready = await fetch(`${baseUrl}/api/properties/${propertyId}/ready-to-list`, {
    method: "POST",
    headers,
  });
  assert.equal(ready.status, 200);
  const packageId = ((await ready.json()) as { documentPackage: { id: number } })
    .documentPackage.id;
  const terms = await fetch(
    `${baseUrl}/api/documents/agency-agreement-terms/${propertyId}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        commissionType: "Percentage",
        commissionRateBps: 220,
        agreementTermDays: 90,
      }),
    },
  );
  assert.equal(terms.status, 200);
  const populated = await fetch(
    `${baseUrl}/api/documents/packages/${packageId}/populate`,
    { method: "POST", headers },
  );
  assert.equal(populated.status, 200);
  const sent = await fetch(
    `${baseUrl}/api/documents/packages/${packageId}/send-for-signature`,
    { method: "POST", headers },
  );
  assert.equal(sent.status, 201);
  const providerReference = (
    (await sent.json()) as { signatureRequest: { providerReference: string } }
  ).signatureRequest.providerReference;
  const packageResponse = await fetch(
    `${baseUrl}/api/documents/packages/by-property/${propertyId}`,
    { headers: { cookie } },
  );
  assert.equal(packageResponse.status, 200);
  const packageDocuments = (
    (await packageResponse.json()) as {
      documents: Array<{ id: number; title: string }>;
    }
  ).documents;
  return {
    providerReference,
    completedDocuments: packageDocuments.map((document) => ({
      documentId: document.id,
      contentBase64: Buffer.from(`Signed document: ${document.title}\n`).toString(
        "base64",
      ),
      filename: `${document.title.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`,
      contentType: "text/plain",
    })),
  };
}

async function upload(cookie: string, documentId: number, bytes: Buffer, filename = "agreement.txt", fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: "text/plain" }), filename);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return fetch(`${baseUrl}/api/documents/${documentId}/versions`, { method: "POST", headers: { cookie }, body: form });
}

test("ingestion generates tenant-owned keys, validates bytes/type/size, and preserves SHA-256", async () => {
  const documentId = await createDocument(A.agent.cookie);
  const bytes = Buffer.from("durable signed document\n");
  const response = await upload(A.agent.cookie, documentId, bytes);
  assert.equal(response.status, 201);
  const body = (await response.json()) as { version: { storageObjectKey: string; contentSha256: string; byteSize: number; displayFilename: string } };
  assert.match(body.version.storageObjectKey, new RegExp(`^tenants/${A.brokerageId}/documents/${documentId}/`));
  assert.equal(body.version.contentSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(body.version.byteSize, bytes.length);
  assert.equal(body.version.displayFilename, "agreement.txt");

  for (const [content, filename, expected] of [
    [Buffer.alloc(0), "empty.txt", "EMPTY_DOCUMENT"],
    [Buffer.from("%PDF-1.7"), "wrong.txt", "DOCUMENT_TYPE_MISMATCH"],
    [Buffer.from([0, 255, 0]), "unsafe.txt", "UNSUPPORTED_DOCUMENT_TYPE"],
  ] as const) {
    const invalid = await upload(A.agent.cookie, documentId, content, filename);
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as { code: string }).code, expected);
  }
  const oversized = await upload(A.agent.cookie, documentId, Buffer.alloc(65, 0x61));
  assert.equal(oversized.status, 413);
  assert.equal(((await oversized.json()) as { code: string }).code, "DOCUMENT_TOO_LARGE");
});

test("deduplicates identical active content and requires a reason for replacement versions", async () => {
  const documentId = await createDocument(A.agent.cookie);
  const first = await upload(A.agent.cookie, documentId, Buffer.from("first"));
  const firstBody = (await first.json()) as { version: { id: number; version: number } };
  assert.equal(first.status, 201);
  const duplicate = await upload(A.agent.cookie, documentId, Buffer.from("first"));
  assert.equal(duplicate.status, 200);
  const duplicateBody = (await duplicate.json()) as { created: boolean; version: { id: number; version: number } };
  assert.equal(duplicateBody.created, false);
  assert.equal(duplicateBody.version.id, firstBody.version.id);
  const noReason = await upload(A.agent.cookie, documentId, Buffer.from("replacement"));
  assert.equal(noReason.status, 400);
  assert.equal(((await noReason.json()) as { code: string }).code, "REPLACEMENT_REASON_REQUIRED");
  const replacement = await upload(A.agent.cookie, documentId, Buffer.from("replacement"), "agreement.txt", { replacementReason: "Corrected signed copy" });
  assert.equal(replacement.status, 201);
  const replacementBody = (await replacement.json()) as { version: { version: number; previousVersionId: number; replacementReason: string } };
  assert.equal(replacementBody.version.version, 2);
  assert.equal(replacementBody.version.previousVersionId, firstBody.version.id);
  assert.equal(replacementBody.version.replacementReason, "Corrected signed copy");
});

test("a failed object write preserves pending metadata and an identical retry resumes its storage key", async () => {
  const documentId = await createDocument(A.agent.cookie);
  const bytes = Buffer.from("retry this exact document");
  const firstPut = storage.putKeys.length;
  const firstDelete = storage.deleteKeys.length;
  storage.failNextPut = new Error("deterministic object write failure");

  const ingestion = {
    documentId,
    brokerageId: A.brokerageId,
    actorUserId: A.agent.user.id,
    bytes,
    originalFilename: "agreement.txt",
    declaredMimeType: "text/plain",
    source: "upload" as const,
  };
  await assert.rejects(
    ingestDocumentVersion(ingestion),
    /deterministic object write failure/,
  );

  const [pending] = await db
    .select()
    .from(documentObjectVersions)
    .where(
      and(
        eq(documentObjectVersions.documentId, documentId),
        eq(documentObjectVersions.brokerageId, A.brokerageId),
      ),
    );
  assert.ok(pending);
  assert.equal(pending.objectStatus, "PendingUpload");
  assert.equal(pending.contentSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(storage.putKeys.slice(firstPut), [pending.storageObjectKey]);
  assert.equal(storage.deleteKeys.length, firstDelete, "a failed write must not attempt object deletion");
  const failureAudits = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.recordId, String(pending.id)));
  assert.ok(failureAudits.some((audit) => audit.action === "document_version_upload_pending"));
  assert.ok(failureAudits.some((audit) => audit.action === "document_version_storage_write_failed"));

  const retried = await ingestDocumentVersion(ingestion);
  assert.equal(retried.created, false);
  assert.equal(retried.version.id, pending.id);
  assert.equal(retried.version.storageObjectKey, pending.storageObjectKey);
  assert.equal(retried.version.objectStatus, "Active");
  assert.deepEqual(
    storage.putKeys.slice(firstPut),
    [pending.storageObjectKey, pending.storageObjectKey],
    "the retry must write to the already-persisted key",
  );
  assert.equal(storage.deleteKeys.length, firstDelete);

  const [finalized] = await db
    .select()
    .from(documentObjectVersions)
    .where(eq(documentObjectVersions.id, pending.id));
  assert.equal(finalized?.objectStatus, "Active");
  const reconciliationAudits = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.recordId, String(pending.id)));
  assert.ok(reconciliationAudits.some((audit) => audit.action === "document_version_upload_reconciled"));
});

test("a failed replacement keeps the previous active version readable", async () => {
  const documentId = await createDocument(A.agent.cookie);
  const originalBytes = Buffer.from("stable active document");
  await ingestDocumentVersion({
    documentId,
    brokerageId: A.brokerageId,
    actorUserId: A.agent.user.id,
    bytes: originalBytes,
    originalFilename: "agreement.txt",
    declaredMimeType: "text/plain",
    source: "upload",
  });

  storage.failNextPut = new Error("deterministic replacement failure");
  await assert.rejects(
    ingestDocumentVersion({
      documentId,
      brokerageId: A.brokerageId,
      actorUserId: A.agent.user.id,
      bytes: Buffer.from("replacement still pending"),
      originalFilename: "agreement.txt",
      declaredMimeType: "text/plain",
      replacementReason: "Corrected copy",
      source: "upload",
    }),
    /deterministic replacement failure/,
  );

  const readable = await getStoredDocumentContent(documentId, A.brokerageId);
  assert.deepEqual(readable?.bytes, originalBytes);
  assert.equal(readable?.version?.objectStatus, "Active");
  assert.equal(readable?.version?.version, 1);
});

test("aged pending uploads are finalized or terminally quarantined without automatic deletion", async () => {
  const recoveredDocumentId = await createDocument(A.agent.cookie);
  const recoveredBytes = Buffer.from("recovered pending bytes");
  storage.failNextPut = new Error("ambiguous provider write");
  await assert.rejects(
    () =>
      ingestDocumentVersion({
        documentId: recoveredDocumentId,
        brokerageId: A.brokerageId,
        bytes: recoveredBytes,
        originalFilename: "recovered.txt",
        declaredMimeType: "text/plain",
        source: "esign",
        sourceProvider: "mock-esign",
        providerDocumentId: "provider-recovered",
        webhookVerified: true,
        retentionClass: "signed-agreement",
      }),
    /ambiguous provider write/,
  );
  const [recoverable] = await db
    .select()
    .from(documentObjectVersions)
    .where(
      and(
        eq(documentObjectVersions.documentId, recoveredDocumentId),
        eq(documentObjectVersions.objectStatus, "PendingUpload"),
      ),
    );
  assert.ok(recoverable);
  storage.objects.set(recoverable.storageObjectKey, recoveredBytes);

  const missingDocumentId = await createDocument(A.agent.cookie);
  storage.failNextPut = new Error("object never reached provider");
  await assert.rejects(
    () =>
      ingestDocumentVersion({
        documentId: missingDocumentId,
        brokerageId: A.brokerageId,
        bytes: Buffer.from("missing pending bytes"),
        originalFilename: "missing.txt",
        declaredMimeType: "text/plain",
        source: "esign",
        sourceProvider: "mock-esign",
        providerDocumentId: "provider-missing",
        webhookVerified: true,
        retentionClass: "signed-agreement",
      }),
    /object never reached provider/,
  );
  const [missing] = await db
    .select()
    .from(documentObjectVersions)
    .where(
      and(
        eq(documentObjectVersions.documentId, missingDocumentId),
        eq(documentObjectVersions.objectStatus, "PendingUpload"),
      ),
    );
  assert.ok(missing);
  const deletesBefore = storage.deleteKeys.length;
  const result = await reconcilePendingDocumentVersions({
    now: new Date(Date.now() + 1_000),
    reconcileAfterMs: 0,
    quarantineAfterMs: 0,
    limit: 50,
  });
  assert.ok(result.finalized >= 1);
  assert.ok(result.quarantinedMissing >= 1);
  assert.equal(storage.deleteKeys.length, deletesBefore);

  const [recovered] = await db
    .select()
    .from(documentObjectVersions)
    .where(eq(documentObjectVersions.id, recoverable.id));
  const [quarantined] = await db
    .select()
    .from(documentObjectVersions)
    .where(eq(documentObjectVersions.id, missing.id));
  assert.equal(recovered?.objectStatus, "Active");
  assert.equal(quarantined?.objectStatus, "Quarantined");
  const recoveryAudits = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.recordId, String(recoverable.id)));
  const quarantineAudits = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.recordId, String(missing.id)));
  assert.ok(
    recoveryAudits.some(
      (audit) => audit.action === "document_version_pending_reconciled",
    ),
  );
  assert.ok(
    quarantineAudits.some(
      (audit) => audit.action === "document_version_pending_missing_quarantined",
    ),
  );
});

test("e-sign storage failures request redelivery and resume the pending version", async () => {
  const previousMaximum = process.env.DOCUMENT_STORAGE_MAX_BYTES;
  process.env.DOCUMENT_STORAGE_MAX_BYTES = "1048576";
  try {
    const completion = await prepareESignCompletion(A.agent.cookie);
    storage.failNextPut = new Error("transient e-sign storage failure");
    const payload = JSON.stringify({
      providerReference: completion.providerReference,
      status: "Completed",
      completedDocuments: completion.completedDocuments,
    });
    const failed = await fetch(`${baseUrl}/api/documents/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("retry-after"), "30");
    assert.equal(
      ((await failed.json()) as { reason: string }).reason,
      "completed_document_storage_retry_required",
    );

    const [pending] = await db
      .select()
      .from(documentObjectVersions)
      .where(
        and(
          eq(
            documentObjectVersions.documentId,
            completion.completedDocuments[0].documentId,
          ),
          eq(documentObjectVersions.objectStatus, "PendingUpload"),
        ),
      );
    assert.ok(pending);
    const retryAudits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.providerReference, completion.providerReference));
    assert.ok(
      retryAudits.some(
        (audit) =>
          audit.action === "esign_completed_document_storage_retry_required",
      ),
    );

    const retried = await fetch(`${baseUrl}/api/documents/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    assert.equal(retried.status, 200);
    assert.equal(((await retried.json()) as { processed: boolean }).processed, true);
    const [finalized] = await db
      .select()
      .from(documentObjectVersions)
      .where(eq(documentObjectVersions.id, pending.id));
    assert.equal(finalized?.objectStatus, "Active");
    const finalAudits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.recordId, String(pending.id)));
    assert.ok(
      finalAudits.some(
        (audit) => audit.action === "document_version_upload_reconciled",
      ),
    );
  } finally {
    if (previousMaximum === undefined) {
      delete process.env.DOCUMENT_STORAGE_MAX_BYTES;
    } else {
      process.env.DOCUMENT_STORAGE_MAX_BYTES = previousMaximum;
    }
  }
});

test("multipart document uploads reject excessive fields, parts, and field values", async (t) => {
  const documentId = await createDocument(A.agent.cookie);
  const endpoint = `${baseUrl}/api/documents/${documentId}/versions`;

  await t.test("fields", async () => {
    const form = new FormData();
    form.set("one", "1");
    form.set("two", "2");
    form.set("three", "3");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { cookie: A.agent.cookie },
      body: form,
    });
    assert.equal(response.status, 413);
    assert.equal(((await response.json()) as { code: string }).code, "DOCUMENT_UPLOAD_LIMIT");
  });

  await t.test("parts", async () => {
    const form = new FormData();
    form.set("file", new Blob(["valid"], { type: "text/plain" }), "valid.txt");
    form.set("replacementReason", "reason");
    form.set("retentionClass", "legal-pending");
    form.set("extraFile", new Blob(["extra"], { type: "text/plain" }), "extra.txt");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { cookie: A.agent.cookie },
      body: form,
    });
    assert.equal(response.status, 413);
    assert.equal(((await response.json()) as { code: string }).code, "DOCUMENT_UPLOAD_LIMIT");
  });

  await t.test("field values", async () => {
    const form = new FormData();
    form.set("file", new Blob(["valid"], { type: "text/plain" }), "valid.txt");
    form.set("replacementReason", "x".repeat(2_049));
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { cookie: A.agent.cookie },
      body: form,
    });
    assert.equal(response.status, 413);
    assert.equal(((await response.json()) as { code: string }).code, "DOCUMENT_UPLOAD_LIMIT");
  });
});

test("rejects cross-tenant storage access, corrupted retrieval, quarantined objects, and scoped signed links", async () => {
  const documentId = await createDocument(A.agent.cookie);
  const uploaded = await upload(A.agent.cookie, documentId, Buffer.from("original"));
  const version = ((await uploaded.json()) as { version: { storageObjectKey: string } }).version;
  const crossUpload = await upload(B.agent.cookie, documentId, Buffer.from("attacker"));
  assert.equal(crossUpload.status, 404);
  const crossLink = await fetch(`${baseUrl}/api/documents/${documentId}/signed-download`, { method: "POST", headers: { cookie: B.agent.cookie } });
  assert.equal(crossLink.status, 404);
  const ownLink = await fetch(`${baseUrl}/api/documents/${documentId}/signed-download`, { method: "POST", headers: { cookie: A.agent.cookie } });
  assert.equal(ownLink.status, 200);
  const link = (await ownLink.json()) as { url: string; expiresAt: string };
  assert.match(link.url, /^\/api\/documents\/signed-download\/\d+\?expires=\d+&signature=/);
  assert.ok(Date.parse(link.expiresAt) > Date.now());
  const redeemed = await fetch(`${baseUrl}${link.url}`);
  assert.equal(redeemed.status, 200);
  assert.equal(await redeemed.text(), "original");
  assert.match(redeemed.headers.get("content-disposition") ?? "", /^attachment;/);
  assert.equal(redeemed.headers.get("x-content-type-options"), "nosniff");

  storage.objects.set(version.storageObjectKey, Buffer.from("tampered"));
  const corrupt = await fetch(`${baseUrl}/api/documents/${documentId}/content`, { headers: { cookie: A.agent.cookie } });
  assert.equal(corrupt.status, 404);
  storage.objects.set(version.storageObjectKey, Buffer.from("original"));
  const quarantine = await fetch(`${baseUrl}/api/documents/${documentId}/quarantine`, { method: "POST", headers: { cookie: A.admin.cookie } });
  assert.equal(quarantine.status, 200);
  const revokedIssuedLink = await fetch(`${baseUrl}${link.url}`);
  assert.equal(revokedIssuedLink.status, 404);
  const quarantinedContent = await fetch(`${baseUrl}/api/documents/${documentId}/content`, { headers: { cookie: A.agent.cookie } });
  assert.equal(quarantinedContent.status, 404);
  const quarantinedLink = await fetch(`${baseUrl}/api/documents/${documentId}/signed-download`, { method: "POST", headers: { cookie: A.agent.cookie } });
  assert.equal(quarantinedLink.status, 404);
});

test("document storage configuration rejects invalid production/provider/expiry configuration", () => {
  assert.throws(() => assertDocumentStorageConfigured({
    NODE_ENV: "production",
    OBJECT_STORAGE_PROVIDER: "local",
    DOCUMENT_STORAGE_SIGNING_SECRET: "x".repeat(32),
  }), /requires OBJECT_STORAGE_PROVIDER=s3/);
  assert.throws(() => configuredMaxDocumentBytes({ DOCUMENT_STORAGE_MAX_BYTES: "0" }), /DOCUMENT_STORAGE_MAX_BYTES/);
  assert.throws(
    () =>
      configuredEsignMaxDocumentBytes({
        DOCUMENT_STORAGE_ESIGN_MAX_DOCUMENT_BYTES: "0",
      }),
    /DOCUMENT_STORAGE_ESIGN_MAX_DOCUMENT_BYTES/,
  );
  assert.throws(
    () =>
      configuredEsignMaxDocuments({
        DOCUMENT_STORAGE_ESIGN_MAX_DOCUMENTS: "11",
      }),
    /DOCUMENT_STORAGE_ESIGN_MAX_DOCUMENTS/,
  );
  assert.equal(
    configuredDocumentWebhookMaxBytes({
      DOCUMENT_STORAGE_ESIGN_MAX_DOCUMENT_BYTES: "3000",
      DOCUMENT_STORAGE_ESIGN_MAX_DOCUMENTS: "2",
    }),
    2 * (4000 + 8192) + 65_536,
  );
  assert.throws(() => configuredSignedDownloadSeconds({ DOCUMENT_STORAGE_SIGNED_DOWNLOAD_SECONDS: "901" }), /DOCUMENT_STORAGE_SIGNED_DOWNLOAD_SECONDS/);
  assert.throws(() => configuredRetentionClasses({ DOCUMENT_STORAGE_RETENTION_CLASSES: "valid,bad/class" }), /RETENTION_CLASSES/);
  assert.throws(() => assertDocumentStorageConfigured({
    NODE_ENV: "production", OBJECT_STORAGE_PROVIDER: "s3", OBJECT_STORAGE_ENDPOINT: "http://unsafe.example",
    OBJECT_STORAGE_REGION: "ap-southeast-2", OBJECT_STORAGE_BUCKET: "bucket", OBJECT_STORAGE_ACCESS_KEY_ID: "key",
    OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret", DOCUMENT_STORAGE_SIGNING_SECRET: "x".repeat(32),
  }), /HTTPS/);
});

test("readiness marks storage failure unavailable without affecting liveness", async () => {
  storage.readiness = { ready: false, message: "simulated storage outage" };
  try {
    const ready = await fetch(`${baseUrl}/api/health/ready`);
    assert.equal(ready.status, 503);
    assert.deepEqual((await ready.json() as { reasons: string[] }).reasons, ["document storage unreachable"]);
    const live = await fetch(`${baseUrl}/api/health/live`);
    assert.equal(live.status, 200);
  } finally {
    storage.readiness = { ready: true };
  }
});