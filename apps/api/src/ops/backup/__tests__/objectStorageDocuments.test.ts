import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { S3ObjectStorageProvider } from "@aee/integration-object-storage";
import { runCommand } from "../commands.js";
import { loadProductionBackupConfig } from "../config.js";
import { createBackup, restoreBackup } from "../engine.js";
import { stageObjectStorageDocuments } from "../objectDocuments.js";
import type { BackupConfig, CommandSpec } from "../types.js";

interface StoredObject { content: Buffer; checksum: string; }

/** In-memory fake S3 endpoint; the real S3ObjectStorageProvider (signing, integrity checks) runs against it. */
function fakeS3(): { provider: S3ObjectStorageProvider; objects: Map<string, StoredObject>; put: (key: string, text: string) => void } {
  const objects = new Map<string, StoredObject>();
  const prefix = "https://objects.example.test/documents/production/";
  const keyOf = (url: string): string => decodeURIComponent(url.slice(prefix.length));
  const fetchImpl: typeof fetch = async (input, init) => {
    const key = keyOf(String(input));
    const object = objects.get(key);
    const method = init?.method ?? "GET";
    if (method === "HEAD") {
      if (!object) return new Response(null, { status: 404 });
      return new Response(null, {
        status: 200,
        headers: { "content-length": String(object.content.length), "x-amz-meta-sha256": object.checksum, etag: '"x"' },
      });
    }
    if (method === "GET") return object ? new Response(object.content) : new Response(null, { status: 404 });
    return new Response(null, { status: 200 });
  };
  const provider = new S3ObjectStorageProvider({
    endpoint: "https://objects.example.test",
    region: "ap-southeast-2",
    bucket: "documents",
    accessKeyId: "TEST_ACCESS_KEY",
    secretAccessKey: "TEST_SECRET",
    prefix: "production",
    serverSideEncryption: "AES256",
    fetch: fetchImpl,
  });
  return {
    provider,
    objects,
    put: (key, text) => {
      const content = Buffer.from(text);
      objects.set(key, { content, checksum: createHash("sha256").update(content).digest("hex") });
    },
  };
}

const KEY_A = "tenants/b1/documents/d1/11111111-1111-1111-1111-111111111111-v1.pdf";
const KEY_B = "tenants/b2/documents/d2/22222222-2222-2222-2222-222222222222-v1.pdf";

test("stageObjectStorageDocuments copies every referenced object preserving the key layout", async () => {
  const s3 = fakeS3();
  s3.put(KEY_A, "alpha");
  s3.put(KEY_B, "bravo!");
  const root = await mkdtemp(path.join(tmpdir(), "aee-s3docs-"));
  try {
    const result = await stageObjectStorageDocuments(s3.provider, [KEY_B, KEY_A, KEY_A], path.join(root, "out"));
    assert.deepEqual(result, { count: 2, bytes: 11 });
    assert.equal(await readFile(path.join(root, "out", ...KEY_A.split("/")), "utf8"), "alpha");
    assert.equal(await readFile(path.join(root, "out", ...KEY_B.split("/")), "utf8"), "bravo!");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing or corrupt document objects fail loudly with counts instead of 'missing local file'", async () => {
  const s3 = fakeS3();
  s3.put(KEY_A, "alpha");
  s3.put(KEY_B, "bravo!");
  s3.objects.get(KEY_B)!.checksum = "0".repeat(64); // corrupt: bytes no longer match stored checksum
  const root = await mkdtemp(path.join(tmpdir(), "aee-s3docs-"));
  try {
    await assert.rejects(
      stageObjectStorageDocuments(s3.provider, [KEY_A, KEY_B, "tenants/b3/documents/gone.pdf"], path.join(root, "out")),
      (error: Error) => {
        assert.match(error.message, /Document integrity failed before backup: 2 of 3 referenced objects missing, unreadable or corrupt in object storage/);
        assert.match(error.message, /ObjectIntegrityError/);
        assert.match(error.message, /HTTP 404/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsafe database keys are refused rather than written outside the staging directory", async () => {
  const s3 = fakeS3();
  const root = await mkdtemp(path.join(tmpdir(), "aee-s3docs-"));
  try {
    await assert.rejects(stageObjectStorageDocuments(s3.provider, ["../escape.pdf"], path.join(root, "out")), /1 of 1/);
    await assert.rejects(stat(path.join(root, "escape.pdf")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function objectStorageConfig(root: string): BackupConfig {
  const spec = (executable: string): CommandSpec => ({ executable, args: [] });
  return {
    databaseUrl: "postgresql://source.invalid/aee",
    documentSource: "object-storage",
    restoreDatabaseUrl: "postgresql://restore.invalid/aee_restore",
    restoreDocumentDirectory: path.join(root, "restore-root", "documents"),
    restoreRoot: path.join(root, "restore-root"),
    restoreEnvironmentId: "restore-drill-01",
    encryptionKmsProfile: "kms:production-backup",
    stagingDirectory: path.join(root, "staging"),
    destination: "durable://vault/backups",
    retentionDays: 30,
    encryption: spec("encrypt"), decryption: spec("decrypt"), upload: spec("upload"),
    download: spec("download"), list: spec("list"), remove: spec("remove"), alert: spec("alert"),
  };
}

test("backup + restore round trip protects documents that live only in object storage", async () => {
  const s3 = fakeS3();
  s3.put(KEY_A, "signed agreement bytes");
  const root = await mkdtemp(path.join(tmpdir(), "aee-s3docs-rt-"));
  const config = objectStorageConfig(root); // no local document directory exists at all
  const inventory = { tenantCount: 1, recordCounts: { documents: 1 }, documentKeys: [KEY_A] };
  const remote = new Map<string, Buffer>();
  const alerts: unknown[] = [];
  const run = async (command: CommandSpec, replacements: Record<string, string> = {}) => {
    switch (command.executable) {
      case "pg_dump":
        await writeFile(command.args[command.args.indexOf("--file") + 1]!, "dump");
        return { stdout: "", stderr: "" };
      case "psql":
        if (command.args.some((arg) => arg.includes("count(*) FROM information_schema.tables"))) return { stdout: "0\n", stderr: "" };
        return { stdout: JSON.stringify(inventory), stderr: "" };
      case "pg_restore": return { stdout: "", stderr: "" };
      case "tar": return runCommand(command);
      case "encrypt": case "decrypt":
        await copyFile(replacements.input!, replacements.output!);
        return { stdout: "", stderr: "" };
      case "upload": remote.set(replacements.destination!, await readFile(replacements.source!)); return { stdout: "", stderr: "" };
      case "download": {
        const content = remote.get(replacements.source!);
        if (!content) throw new Error("missing remote");
        await writeFile(replacements.destination!, content);
        return { stdout: "", stderr: "" };
      }
      case "list": return { stdout: "[]", stderr: "" };
      case "alert": alerts.push(replacements); return { stdout: "", stderr: "" };
      default: throw new Error(`unexpected ${command.executable}`);
    }
  };
  try {
    const artifact = await createBackup(config, { run, documentProvider: s3.provider, log: () => undefined });
    assert.equal(alerts.length, 0);
    await restoreBackup(config, { artifact, confirmDisposable: true }, { run, log: () => undefined });
    assert.equal(
      await readFile(path.join(config.restoreDocumentDirectory, ...KEY_A.split("/")), "utf8"),
      "signed agreement bytes",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("object-storage backup fails and alerts when a referenced object is gone, and requires a provider", async () => {
  const s3 = fakeS3(); // KEY_A is referenced by the database but absent from storage
  const root = await mkdtemp(path.join(tmpdir(), "aee-s3docs-fail-"));
  const config = objectStorageConfig(root);
  const alerts: Array<Record<string, string>> = [];
  const run = async (command: CommandSpec, replacements: Record<string, string> = {}) => {
    switch (command.executable) {
      case "pg_dump": await writeFile(command.args[command.args.indexOf("--file") + 1]!, "dump"); return { stdout: "", stderr: "" };
      case "psql": return { stdout: JSON.stringify({ tenantCount: 1, recordCounts: {}, documentKeys: [KEY_A] }), stderr: "" };
      case "alert": alerts.push(replacements); return { stdout: "", stderr: "" };
      default: throw new Error(`unexpected ${command.executable}`);
    }
  };
  try {
    await assert.rejects(createBackup(config, { run, documentProvider: s3.provider, log: () => undefined }), /Document integrity failed before backup: 1 of 1/);
    assert.equal(alerts.length, 1);
    await assert.rejects(createBackup(config, { run, log: () => undefined }), /requires a configured object storage provider/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function productionEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const command = JSON.stringify(["tool", "{input}", "{output}", "{kmsProfile}"]);
  return {
    BACKUP_ENVIRONMENT: "production", DATABASE_URL: "postgresql://db.invalid/aee",
    BACKUP_STAGING_DIRECTORY: "/tmp/x/staging", BACKUP_DESTINATION: "s3://vault/backups", BACKUP_RETENTION_DAYS: "30",
    BACKUP_ENCRYPT_COMMAND: command, BACKUP_DECRYPT_COMMAND: command,
    BACKUP_UPLOAD_COMMAND: JSON.stringify(["u", "{source}", "{destination}"]),
    BACKUP_DOWNLOAD_COMMAND: JSON.stringify(["d", "{source}", "{destination}"]),
    BACKUP_LIST_COMMAND: JSON.stringify(["l", "{destination}"]),
    BACKUP_DELETE_COMMAND: JSON.stringify(["r", "{object}"]),
    BACKUP_ALERT_COMMAND: JSON.stringify(["a", "{operation}", "{error}"]),
    BACKUP_ENCRYPTION_AUTHENTICATED: "true", BACKUP_ENCRYPTION_KMS_PROFILE: "kms:production-backup",
    BACKUP_RESTORE_DISPOSABLE: "true", BACKUP_RESTORE_ENVIRONMENT_ID: "restore-drill-01",
    BACKUP_RESTORE_ROOT: "/tmp/x/restore-root", BACKUP_RESTORE_DOCUMENT_DIRECTORY: "/tmp/x/restore-root/documents",
    BACKUP_RESTORE_DATABASE_URL: "postgresql://restore.invalid/aee_restore",
    ...extra,
  } as NodeJS.ProcessEnv;
}

test("BACKUP_DOCUMENT_SOURCE selects object storage without a document directory and keeps directory as the default", () => {
  const objectConfig = loadProductionBackupConfig(
    productionEnv({ BACKUP_DOCUMENT_SOURCE: "object-storage", OBJECT_STORAGE_PROVIDER: "s3" }),
  );
  assert.equal(objectConfig.documentSource, "object-storage");
  assert.equal(objectConfig.documentDirectory, undefined);

  assert.throws(
    () => loadProductionBackupConfig(productionEnv({ BACKUP_DOCUMENT_SOURCE: "object-storage", OBJECT_STORAGE_PROVIDER: "local" })),
    /requires OBJECT_STORAGE_PROVIDER=s3/,
  );
  assert.throws(() => loadProductionBackupConfig(productionEnv({ BACKUP_DOCUMENT_SOURCE: "bucket" })), /directory or object-storage/);
  assert.throws(() => loadProductionBackupConfig(productionEnv({})), /BACKUP_DOCUMENT_DIRECTORY is missing/);
  const directory = loadProductionBackupConfig(productionEnv({ BACKUP_DOCUMENT_DIRECTORY: "/tmp/x/documents" }));
  assert.equal(directory.documentSource, "directory");
  // config.ts normalises with path.resolve(), so compare against the platform-resolved form
  assert.equal(directory.documentDirectory, path.resolve("/tmp/x/documents"));
});
