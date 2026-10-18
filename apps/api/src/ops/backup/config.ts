import path from "node:path";
import type { BackupConfig, CommandSpec } from "./types.js";

const DURABLE_DESTINATION_SCHEMES = new Set(["s3:", "gs:", "azblob:"]);

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Required production backup configuration ${name} is missing`);
  return value;
}

function command(env: NodeJS.ProcessEnv, name: string): CommandSpec {
  const raw = required(env, name);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON array of an executable and arguments`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((part) => typeof part !== "string" || part.length === 0)) {
    throw new Error(`${name} must be a non-empty JSON string array`);
  }
  const [executable, ...args] = parsed as string[];
  return { executable, args };
}

function requirePlaceholders(name: string, spec: CommandSpec, placeholders: string[]): CommandSpec {
  const serialized = [spec.executable, ...spec.args].join("\0");
  for (const placeholder of placeholders) {
    if (!serialized.includes(`{${placeholder}}`)) {
      throw new Error(`${name} must include the {${placeholder}} placeholder`);
    }
  }
  return spec;
}

export function loadProductionBackupConfig(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  if (env.BACKUP_ENVIRONMENT !== "production") {
    throw new Error("BACKUP_ENVIRONMENT must explicitly equal production; no local backup fallback is permitted");
  }
  const destination = required(env, "BACKUP_DESTINATION");
  let destinationUrl: URL;
  try {
    destinationUrl = new URL(destination);
  } catch {
    throw new Error("BACKUP_DESTINATION must be a supported durable object-store URI");
  }
  if (!DURABLE_DESTINATION_SCHEMES.has(destinationUrl.protocol) || !destinationUrl.hostname) {
    throw new Error("BACKUP_DESTINATION must use supported durable object-store scheme: s3, gs, or azblob");
  }
  const documentDirectory = path.resolve(required(env, "BACKUP_DOCUMENT_DIRECTORY"));
  const stagingDirectory = path.resolve(required(env, "BACKUP_STAGING_DIRECTORY"));
  if (documentDirectory === stagingDirectory || documentDirectory.startsWith(stagingDirectory + path.sep)) {
    throw new Error("BACKUP_STAGING_DIRECTORY must not contain the live document directory");
  }
  const retentionDays = Number(required(env, "BACKUP_RETENTION_DAYS"));
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error("BACKUP_RETENTION_DAYS must be a positive integer");
  }
  const minRetainedRaw = env.BACKUP_MIN_RETAINED_COUNT?.trim();
  const minRetainedBackups = minRetainedRaw === undefined || minRetainedRaw === "" ? 7 : Number(minRetainedRaw);
  if (!Number.isInteger(minRetainedBackups) || minRetainedBackups < 1) {
    throw new Error("BACKUP_MIN_RETAINED_COUNT must be a positive integer");
  }
  if (env.BACKUP_ENCRYPTION_AUTHENTICATED !== "true") {
    throw new Error("BACKUP_ENCRYPTION_AUTHENTICATED must explicitly equal true");
  }
  const encryptionProfile = required(env, "BACKUP_ENCRYPTION_KMS_PROFILE");
  if (!/^kms:[a-z0-9][a-z0-9._/-]{2,}$/i.test(encryptionProfile)) {
    throw new Error("BACKUP_ENCRYPTION_KMS_PROFILE must be an explicit non-secret kms:<profile> identifier");
  }
  if (env.BACKUP_RESTORE_DISPOSABLE !== "true") {
    throw new Error("BACKUP_RESTORE_DISPOSABLE must explicitly equal true");
  }
  const restoreEnvironmentId = required(env, "BACKUP_RESTORE_ENVIRONMENT_ID");
  if (!/^restore-[a-z0-9][a-z0-9-]{2,}$/i.test(restoreEnvironmentId)) {
    throw new Error("BACKUP_RESTORE_ENVIRONMENT_ID must identify a dedicated restore-* environment");
  }
  const restoreRoot = path.resolve(required(env, "BACKUP_RESTORE_ROOT"));
  const restoreDocumentDirectory = path.resolve(required(env, "BACKUP_RESTORE_DOCUMENT_DIRECTORY"));
  if (!restoreDocumentDirectory.startsWith(restoreRoot + path.sep)) {
    throw new Error("BACKUP_RESTORE_DOCUMENT_DIRECTORY must be inside BACKUP_RESTORE_ROOT");
  }
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    documentDirectory,
    restoreDatabaseUrl: required(env, "BACKUP_RESTORE_DATABASE_URL"),
    restoreDocumentDirectory,
    restoreRoot,
    restoreEnvironmentId,
    encryptionKmsProfile: encryptionProfile,
    stagingDirectory,
    destination: destination.replace(/\/+$/, ""),
    retentionDays,
    minRetainedBackups,
    encryption: requirePlaceholders("BACKUP_ENCRYPT_COMMAND", command(env, "BACKUP_ENCRYPT_COMMAND"), ["input", "output", "kmsProfile"]),
    decryption: requirePlaceholders("BACKUP_DECRYPT_COMMAND", command(env, "BACKUP_DECRYPT_COMMAND"), ["input", "output", "kmsProfile"]),
    upload: requirePlaceholders("BACKUP_UPLOAD_COMMAND", command(env, "BACKUP_UPLOAD_COMMAND"), ["source", "destination"]),
    download: requirePlaceholders("BACKUP_DOWNLOAD_COMMAND", command(env, "BACKUP_DOWNLOAD_COMMAND"), ["source", "destination"]),
    list: requirePlaceholders("BACKUP_LIST_COMMAND", command(env, "BACKUP_LIST_COMMAND"), ["destination"]),
    remove: requirePlaceholders("BACKUP_DELETE_COMMAND", command(env, "BACKUP_DELETE_COMMAND"), ["object"]),
    alert: requirePlaceholders("BACKUP_ALERT_COMMAND", command(env, "BACKUP_ALERT_COMMAND"), ["operation", "error"]),
  };
}