import assert from "node:assert/strict";
import { S3ObjectStorageProvider } from "../../packages/integrations/object-storage/src/index.js";

async function main(): Promise<void> {
  const endpoint = process.env.SYNTHETIC_S3_ENDPOINT;
  if (!endpoint) throw new Error("SYNTHETIC_S3_ENDPOINT is required");

  const provider = new S3ObjectStorageProvider({
    endpoint,
    region: "ap-southeast-2",
    bucket: "synthetic-private-documents",
    accessKeyId: "ci-only-access-key",
    secretAccessKey: "ci-only-secret-key-not-a-real-secret",
    serverSideEncryption: "AES256",
  });

  const key = "tenants/1/documents/1/synthetic-v1.pdf";
  const bytes = Buffer.from("%PDF-1.7\nsynthetic durable storage verification\n", "utf8");

  await provider.putObject(key, bytes, "application/pdf");
  const head = await provider.headObject(key);
  assert.equal(head.size, bytes.length);
  assert.equal(head.contentType, "application/pdf");
  assert.deepEqual(await provider.getObject(key), bytes);
  assert.equal((await provider.verifyIntegrity(key)).valid, true);

  const signed = await provider.createSignedDownload(key, 60);
  const signedResponse = await fetch(signed.url);
  assert.equal(signedResponse.status, 200);
  assert.deepEqual(Buffer.from(await signedResponse.arrayBuffer()), bytes);

  const tamperedUrl = new URL(signed.url);
  const signature = tamperedUrl.searchParams.get("X-Amz-Signature");
  assert.ok(signature);
  tamperedUrl.searchParams.set(
    "X-Amz-Signature",
    `${signature[0] === "0" ? "1" : "0"}${signature.slice(1)}`,
  );
  assert.equal((await fetch(tamperedUrl)).status, 403);

  const shortLived = await provider.createSignedDownload(key, 1);
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  assert.equal((await fetch(shortLived.url)).status, 403);

  await provider.deleteObject(key);
  await assert.rejects(provider.headObject(key), /HTTP 404/);
  process.stdout.write("Synthetic S3-compatible encrypted object lifecycle passed.\n");
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});