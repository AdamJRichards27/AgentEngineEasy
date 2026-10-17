import path from "node:path";
import { DEFAULT_TIER_POLICY, TIERS, type TierPolicy } from "./artifacts.js";
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

function optionalCommand(env: NodeJS.ProcessEnv, name: string, placeholders: string[]): CommandSpec | undefined {
  if (!env[name]?.trim()) return undefined;
  return requirePlaceholders(name, command(env, name), placeholders);
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

function strictBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be exactly true or false`);
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function tierPolicy(env: NodeJS.ProcessEnv): TierPolicy {
  const policy = { daily: { ...DEFAULT_TIER_POLICY.daily }, weekly: { ...DEFAULT_TIER_POLICY.weekly }, monthly: { ...DEFAULT_TIER_POLICY.monthly } };
  for (const tier of TIERS) {
    const upper = tier.toUpperCase();
    policy[tier].keep = positiveInteger(env, `BACKUP_TIER_${upper}_KEEP`, policy[tier].keep);
    policy[tier].retentionDays = positiveInteger(env, `BACKUP_TIER_${upper}_DAYS`, policy[tier].retentionDays);
  }
  return policy;
}

/** Package B: optional separate download commands so verifier and restore can run under their own storage identities. */
function optionalIdentityCommands(env: NodeJS.ProcessEnv): Pick<BackupConfig, "verifyDownload" | "restoreDownload"> {
  const verifyDownload = optionalCommand(env, "BACKUP_VERIFY_DOWNLOAD_COMMAND", ["source", "destination"]);
  const restoreDownload = optionalCommand(env, "BACKUP_RESTORE_DOWNLOAD_COMMAND", ["source", "destination"]);
  return { ...(verifyDownload ? { verifyDownload } : {}), ...(restoreDownload ? { restoreDownload } : {}) };
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
  const documentSource = (env.BACKUP_DOCUMENT_SOURCE?.trim() || "directory").toLowerCase();
  if (documentSource !== "directory" && documentSource !== "object-storage") {
    throw new Error("BACKUP_DOCUMENT_SOURCE must be directory or object-storage");
  }
  if (documentSource === "object-storage" && env.OBJECT_STORAGE_PROVIDER?.trim().toLowerCase() !== "s3") {
    throw new Error("BACKUP_DOCUMENT_SOURCE=object-storage requires OBJECT_STORAGE_PROVIDER=s3");
  }
  const stagingDirectory = path.resolve(required(env, "BACKUP_STAGING_DIRECTORY"));
  let documentDirectory: string | undefined;
  if (documentSource === "directory") {
    documentDirectory = path.resolve(required(env, "BACKUP_DOCUMENT_DIRECTORY"));
    if (documentDirectory === stagingDirectory || documentDirectory.startsWith(stagingDirectory + path.sep)) {
      throw new Error("BACKUP_STAGING_DIRECTORY must not contain the live document directory");
    }
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
  // Pruning needs list+delete rights and is incompatible with a write-once vault. The switch keeps the
  // #224 behaviour (on) unless set; in vault mode it must be switched off explicitly (fail closed).
  const vaultMode = strictBoolean(env, "BACKUP_VAULT_MODE") ?? false;
  const pruneRaw = env.BACKUP_PRUNE?.trim().toLowerCase();
  if (pruneRaw !== undefined && pruneRaw !== "" && pruneRaw !== "on" && pruneRaw !== "off") {
    throw new Error("BACKUP_PRUNE must be exactly on or off");
  }
  const prune = pruneRaw === "off" ? false : true;
  if (vaultMode && prune) {
    throw new Error("BACKUP_PRUNE=off is required when BACKUP_VAULT_MODE=true; pruning is prohibited in vault mode");
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
    documentSource,
    ...(documentDirectory ? { documentDirectory } : {}),
    restoreDatabaseUrl: required(env, "BACKUP_RESTORE_DATABASE_URL"),
    restoreDocumentDirectory,
    restoreRoot,
    restoreEnvironmentId,
    encryptionKmsProfile: encryptionProfile,
    stagingDirectory,
    destination: destination.replace(/\/+$/, ""),
    retentionDays,
    minRetainedBackups,
    tierPolicy: tierPolicy(env),
    prune,
    vaultMode,
    encryption: requirePlaceholders("BACKUP_ENCRYPT_COMMAND", command(env, "BACKUP_ENCRYPT_COMMAND"), ["input", "output", "kmsProfile"]),
    decryption: requirePlaceholders("BACKUP_DECRYPT_COMMAND", command(env, "BACKUP_DECRYPT_COMMAND"), ["input", "output", "kmsProfile"]),
    upload: requirePlaceholders("BACKUP_UPLOAD_COMMAND", command(env, "BACKUP_UPLOAD_COMMAND"), ["source", "destination"]),
    download: requirePlaceholders("BACKUP_DOWNLOAD_COMMAND", command(env, "BACKUP_DOWNLOAD_COMMAND"), ["source", "destination"]),
    ...optionalIdentityCommands(env),
    list: requirePlaceholders("BACKUP_LIST_COMMAND", command(env, "BACKUP_LIST_COMMAND"), ["destination"]),
    remove: requirePlaceholders("BACKUP_DELETE_COMMAND", command(env, "BACKUP_DELETE_COMMAND"), ["object"]),
    alert: requirePlaceholders("BACKUP_ALERT_COMMAND", command(env, "BACKUP_ALERT_COMMAND"), ["operation", "error"]),
  };
}