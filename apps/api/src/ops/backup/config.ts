import path from "node:path";
import { DEFAULT_TIER_POLICY, TIERS, type TierPolicy } from "./artifacts.js";
import { patternsOverlap } from "./commands.js";
import type { BackupConfig, BackupOperation, CommandSpec, EnvIsolationPolicy } from "./types.js";

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

const ENV_OPERATIONS: Array<[BackupOperation, string]> = [
  ["database", "DATABASE"], ["restore_database", "RESTORE_DATABASE"], ["encrypt", "ENCRYPT"], ["upload", "UPLOAD"], ["verify_download", "VERIFY_DOWNLOAD"],
  ["list", "LIST"], ["delete", "DELETE"], ["alert", "ALERT"], ["decrypt", "DECRYPT"], ["restore_download", "RESTORE_DOWNLOAD"],
];

function allowList(env: NodeJS.ProcessEnv, name: string): string[] {
  const raw = env[name]?.trim();
  if (!raw) return [];
  const entries = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  for (const entry of entries) {
    if (entry === "*") throw new Error(`${name} must not allow every variable`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*\*?$/.test(entry)) {
      throw new Error(`${name} entries must be environment variable names, optionally ending in * for a prefix`);
    }
  }
  return entries;
}

/**
 * Command-level environment isolation. OFF unless BACKUP_ENV_ISOLATION=true (legacy behaviour otherwise).
 * When on, each operation's child gets the fixed base variables + BACKUP_ENV_COMMON_ALLOW + its own
 * BACKUP_ENV_<OPERATION>_ALLOW. Per-operation allowlists must not overlap, so no credential variable can be
 * admitted to two operations (this is what keeps writers away from restore/decrypt credentials and the
 * verifier away from write/delete credentials). Only names are inspected; values are never read here.
 */
/**
 * Variables that let a process discover credentials or identities from files, metadata endpoints or agents
 * (config/credential file paths, role/token sources, SSH agent, kubeconfig...). Env isolation never passes them
 * unless named; these rules also stop them being shared with every operation or swept in by a prefix.
 * Names that only locate the home directory must use BACKUP_ENV_HOME instead.
 */
const HOME_LOCATORS = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "XDG_*"];
const CREDENTIAL_DISCOVERY = [
  ...HOME_LOCATORS,
  "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONTAINER_*", "AWS_EC2_METADATA_*", "AWS_SSO_*", "AWS_CA_BUNDLE",
  "GOOGLE_APPLICATION_CREDENTIALS", "CLOUDSDK_*", "AZURE_*", "KUBECONFIG", "PGPASSFILE", "PGSERVICEFILE", "PGSYSCONFDIR",
  "SSH_AUTH_SOCK", "NETRC", "CURL_HOME", "GNUPGHOME", "DOCKER_CONFIG",
];
const SECRET_LOOKING = /(SECRET|TOKEN|PASSWORD|PASSWD|KEY|CREDENTIAL|SESSION|PRIVATE|URL|DSN)/i;

function discoveryMatch(entry: string): string | undefined {
  return CREDENTIAL_DISCOVERY.find((pattern) => patternsOverlap(pattern, entry));
}

function assertAllowlistNames(common: string[], operations: Record<BackupOperation, string[]>): void {
  for (const entry of common) {
    if (entry.endsWith("*")) throw new Error(`Environment isolation: BACKUP_ENV_COMMON_ALLOW entry "${entry}" is a prefix; the shared allowlist accepts exact names only`);
    if (!/^[A-Z][A-Z0-9_]*$/.test(entry)) throw new Error(`Environment isolation: BACKUP_ENV_COMMON_ALLOW entry "${entry}" must be an upper-case variable name (shared allowlist)`);
    if (SECRET_LOOKING.test(entry)) throw new Error(`Environment isolation: BACKUP_ENV_COMMON_ALLOW entry "${entry}" looks like a secret or connection string; the shared allowlist is for non-secret settings only`);
    if (discoveryMatch(entry)) throw new Error(`Environment isolation: BACKUP_ENV_COMMON_ALLOW entry "${entry}" is a credential-discovery variable and may not be shared with every operation`);
  }
  for (const [operation, entries] of Object.entries(operations)) {
    for (const entry of entries) {
      const hit = discoveryMatch(entry);
      if (!hit) continue;
      if (HOME_LOCATORS.some((pattern) => patternsOverlap(pattern, entry))) {
        throw new Error(`Environment isolation: ${operation} allowlist entry "${entry}" would pass a home-directory locator; use BACKUP_ENV_HOME instead (credential-discovery)`);
      }
      if (entry.endsWith("*")) {
        throw new Error(`Environment isolation: ${operation} allowlist prefix "${entry}" could admit credential-discovery variables (matches ${hit}); list exact names instead`);
      }
    }
  }
}

function envIsolation(env: NodeJS.ProcessEnv): EnvIsolationPolicy | undefined {
  if (!strictBoolean(env, "BACKUP_ENV_ISOLATION")) return undefined;
  const operations = { archive: [] } as unknown as Record<BackupOperation, string[]>;
  for (const [operation, suffix] of ENV_OPERATIONS) operations[operation] = allowList(env, `BACKUP_ENV_${suffix}_ALLOW`);
  const common = allowList(env, "BACKUP_ENV_COMMON_ALLOW");
  for (let i = 0; i < ENV_OPERATIONS.length; i += 1) {
    for (let j = i + 1; j < ENV_OPERATIONS.length; j += 1) {
      const [a] = ENV_OPERATIONS[i];
      const [b] = ENV_OPERATIONS[j];
      for (const left of operations[a]) {
        for (const right of operations[b]) {
          if (patternsOverlap(left, right)) {
            throw new Error(`Environment isolation: ${a} and ${b} allowlists overlap on "${left}" / "${right}"; a variable may be allowed to only one backup operation`);
          }
        }
      }
    }
  }
  for (const [operation] of ENV_OPERATIONS) {
    for (const entry of operations[operation]) {
      if (common.some((shared) => patternsOverlap(shared, entry))) {
        throw new Error(`Environment isolation: "${entry}" is in both BACKUP_ENV_COMMON_ALLOW and a per-operation allowlist`);
      }
    }
  }
  assertAllowlistNames(common, operations);
  const home = env.BACKUP_ENV_HOME?.trim();
  if (home && !path.isAbsolute(home)) throw new Error("BACKUP_ENV_HOME must be an absolute path");
  return { common, operations, ...(home ? { homeDirectory: home } : {}) };
}

const sameCommand = (a: CommandSpec | undefined, b: CommandSpec | undefined): boolean =>
  !!a && !!b && a.executable === b.executable && a.args.length === b.args.length && a.args.every((arg, i) => arg === b.args[i]);

/**
 * BACKUP_ENV_ISOLATION_REQUIRED=true: production must not run with partial isolation. Everything the policy depends on
 * must be configured, otherwise loading fails (fail closed) naming what is missing.
 */
function assertIsolationRequirements(env: NodeJS.ProcessEnv, config: BackupConfig): void {
  const required = strictBoolean(env, "BACKUP_ENV_ISOLATION_REQUIRED");
  if (!required) return;
  const policy = config.envIsolation;
  if (!policy) throw new Error("BACKUP_ENV_ISOLATION=true is required when BACKUP_ENV_ISOLATION_REQUIRED=true");
  const missing: string[] = [];
  if (!policy.homeDirectory) missing.push("BACKUP_ENV_HOME (explicit home directory for children)");
  const needed: BackupOperation[] = ["database", "restore_database", "encrypt", "upload", "verify_download", "alert", "decrypt", "restore_download"];
  const pruning = config.prune === true;
  if (pruning) needed.push("list", "delete");
  for (const operation of needed) {
    if ((policy.operations[operation] ?? []).length === 0) missing.push(`${operation} allowlist (BACKUP_ENV_${operation.toUpperCase()}_ALLOW)`);
  }
  if (!config.verifyDownload) missing.push("BACKUP_VERIFY_DOWNLOAD_COMMAND (the verifier must not fall back to the writer download)");
  if (!config.restoreDownload) missing.push("BACKUP_RESTORE_DOWNLOAD_COMMAND (restore must not fall back to the writer download)");
  if (missing.length > 0) throw new Error(`Environment isolation is required but incomplete: missing ${missing.join("; ")}`);
  if (!pruning) {
    for (const operation of ["list", "delete"] as BackupOperation[]) {
      if ((policy.operations[operation] ?? []).length > 0) {
        throw new Error(`Environment isolation: pruning is off, so the ${operation} allowlist must be empty (no delete-capable credentials may be provisioned to a backup that does not prune)`);
      }
    }
  }
  const verify = config.verifyDownload;
  for (const [label, other] of [["upload", config.upload], ["delete", config.remove], ["list", config.list], ["writer download", config.download]] as Array<[string, CommandSpec]>) {
    if (sameCommand(verify, other)) throw new Error(`Environment isolation: the verifier command must differ from the ${label} command`);
  }
  const restore = config.restoreDownload;
  for (const [label, other] of [["upload", config.upload], ["delete", config.remove], ["verifier", verify], ["writer download", config.download]] as Array<[string, CommandSpec | undefined]>) {
    if (sameCommand(restore, other)) throw new Error(`Environment isolation: the restore command must differ from the ${label} command`);
  }
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
  // D-2: pruning is destructive, so it is OFF unless an operator deliberately sets BACKUP_PRUNE=on.
  const prune = pruneRaw === "on";
  const pruneSource: "default" | "explicit" = pruneRaw === undefined || pruneRaw === "" ? "default" : "explicit";
  if (vaultMode && prune) {
    throw new Error("BACKUP_PRUNE must not be on when BACKUP_VAULT_MODE=true; pruning is prohibited in vault mode");
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
  const isolation = envIsolation(env);
  const config: BackupConfig = {
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
    pruneSource,
    vaultMode,
    encryption: requirePlaceholders("BACKUP_ENCRYPT_COMMAND", command(env, "BACKUP_ENCRYPT_COMMAND"), ["input", "output", "kmsProfile"]),
    decryption: requirePlaceholders("BACKUP_DECRYPT_COMMAND", command(env, "BACKUP_DECRYPT_COMMAND"), ["input", "output", "kmsProfile"]),
    upload: requirePlaceholders("BACKUP_UPLOAD_COMMAND", command(env, "BACKUP_UPLOAD_COMMAND"), ["source", "destination"]),
    download: requirePlaceholders("BACKUP_DOWNLOAD_COMMAND", command(env, "BACKUP_DOWNLOAD_COMMAND"), ["source", "destination"]),
    ...optionalIdentityCommands(env),
    list: requirePlaceholders("BACKUP_LIST_COMMAND", command(env, "BACKUP_LIST_COMMAND"), ["destination"]),
    remove: requirePlaceholders("BACKUP_DELETE_COMMAND", command(env, "BACKUP_DELETE_COMMAND"), ["object"]),
    alert: requirePlaceholders("BACKUP_ALERT_COMMAND", command(env, "BACKUP_ALERT_COMMAND"), ["operation", "error"]),
    ...(isolation ? { envIsolation: isolation } : {}),
    ...(strictBoolean(env, "BACKUP_ENV_ISOLATION_REQUIRED") ? { envIsolationRequired: true } : {}),
  };
  assertIsolationRequirements(env, config);
  return config;
}