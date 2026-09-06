import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LocalObjectStorageProvider,
  ObjectIntegrityError,
  S3ObjectStorageProvider,
  assertSafeObjectKey,
  createObjectStorageProvider,
  validateS3ObjectStorageConfig,
} from "../.test-dist/index.js";

test("unsafe keys and unknown providers fail closed", () => {
  for (const key of ["", "../secret", "a/../secret", "/absolute", "a\\b", "a//b", "a?b"]) {
    assert.throws(() => assertSafeObjectKey(key), /Unsafe/);
  }
  assert.throws(
    () => createObjectStorageProvider({ OBJECT_STORAGE_PROVIDER: "unknown" }),
    /Unsupported/,
  );
});

test("local adapter stores metadata, detects corruption, signs, and deletes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "object-storage-"));
  const provider = new LocalObjectStorageProvider({
    baseDir: directory,
    signingSecret: "a".repeat(32),
    maxSignedDownloadSeconds: 30,
  });
  try {
    await provider.putObject("documents/one.pdf", Buffer.from("authentic"), "application/pdf");
    const head = await provider.headObject("documents/one.pdf");
    assert.equal(head.size, 9);
    assert.equal(head.contentType, "application/pdf");
    assert.match(head.checksumSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(await provider.getObject("documents/one.pdf"), Buffer.from("authentic"));
    assert.equal((await provider.verifyIntegrity("documents/one.pdf")).valid, true);

    const signed = await provider.createSignedDownload("documents/one.pdf", 10);
    assert.deepEqual(await provider.getSignedObject(signed.url), Buffer.from("authentic"));
    const tampered = signed.url.replace(/signature=./, "signature=x");
    await assert.rejects(provider.getSignedObject(tampered), /signature/);
    await assert.rejects(provider.createSignedDownload("documents/one.pdf", 31), /limit/);

    await writeFile(path.join(directory, "documents/one.pdf"), "corrupt");
    assert.equal((await provider.verifyIntegrity("documents/one.pdf")).valid, false);
    await assert.rejects(provider.getObject("documents/one.pdf"), ObjectIntegrityError);

    await provider.deleteObject("documents/one.pdf");
    await assert.rejects(readFile(path.join(directory, "documents/one.pdf")));
    assert.equal((await provider.checkReadiness()).ready, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("S3 configuration rejects insecure or incomplete production settings", () => {
  const base = {
    endpoint: "https://objects.example.test",
    region: "ap-southeast-2",
    bucket: "private-documents",
    accessKeyId: "access",
    secretAccessKey: "secret",
    serverSideEncryption: "AES256",
  };
  assert.throws(
    () => validateS3ObjectStorageConfig({ ...base, endpoint: "http://objects.example.test" }),
    /HTTPS/,
  );
  assert.throws(
    () => validateS3ObjectStorageConfig({
      ...base,
      serverSideEncryption: "aws:kms",
    }),
    /KMS_KEY_ID/,
  );
  assert.throws(
    () => validateS3ObjectStorageConfig({ ...base, secretAccessKey: "" }),
    /SECRET_ACCESS_KEY/,
  );
});

test("S3 adapter signs private encrypted writes without leaking credentials", async () => {
  const calls = [];
  const content = Buffer.from("signed bytes");
  const checksum = "d6eade346b42f707c1684aa3d3c029ab0809164b8b878fcccf56fe1d83b3dc1d";
  const fakeFetch = async (url, init) => {
    calls.push({ url: url.toString(), init });
    if (init.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "content-length": String(content.length),
          "content-type": "application/pdf",
          "x-amz-meta-sha256": checksum,
          etag: '"opaque"',
        },
      });
    }
    if (init.method === "GET") return new Response(content);
    return new Response(null, { status: 200 });
  };
  const provider = new S3ObjectStorageProvider({
    endpoint: "https://objects.example.test/storage",
    region: "ap-southeast-2",
    bucket: "documents",
    accessKeyId: "ACCESS_KEY",
    secretAccessKey: "TOP_SECRET",
    prefix: "production",
    serverSideEncryption: "aws:kms",
    kmsKeyId: "key-id",
    fetch: fakeFetch,
  });

  await provider.putObject("packages/final.pdf", content, "application/pdf");
  const put = calls[0];
  assert.equal(put.init.headers["x-amz-acl"], "private");
  assert.equal(put.init.headers["x-amz-server-side-encryption"], "aws:kms");
  assert.equal(put.init.headers["x-amz-server-side-encryption-aws-kms-key-id"], "key-id");
  assert.match(put.init.headers.authorization, /^AWS4-HMAC-SHA256 /);
  assert.ok(!JSON.stringify(put).includes("TOP_SECRET"));
  assert.equal(put.url, "https://objects.example.test/storage/documents/production/packages/final.pdf");

  assert.deepEqual(await provider.getObject("packages/final.pdf"), content);
  const signed = await provider.createSignedDownload("packages/final.pdf", 60);
  assert.match(signed.url, /^https:/);
  assert.match(signed.url, /X-Amz-Signature=/);
  assert.ok(!signed.url.includes("TOP_SECRET"));
  await provider.deleteObject("packages/final.pdf");
});

test("S3 integrity mismatch and readiness behavior are explicit", async () => {
  const expected = "0".repeat(64);
  const provider = new S3ObjectStorageProvider({
    endpoint: "https://objects.example.test",
    region: "region",
    bucket: "bucket",
    accessKeyId: "access",
    secretAccessKey: "secret",
    serverSideEncryption: "AES256",
    fetch: async (_url, init) => {
      if (init.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-length": "3", "x-amz-meta-sha256": expected },
        });
      }
      return new Response("bad");
    },
  });
  await assert.rejects(provider.getObject("safe/key"), ObjectIntegrityError);
  assert.equal((await provider.verifyIntegrity("safe/key")).valid, false);

  const readinessProvider = new S3ObjectStorageProvider({
    endpoint: "https://objects.example.test",
    region: "region",
    bucket: "bucket",
    accessKeyId: "access",
    secretAccessKey: "secret",
    serverSideEncryption: "AES256",
    fetch: async () => new Response(null, { status: 404 }),
  });
  assert.equal((await readinessProvider.checkReadiness()).ready, true);
});