import type { TierPolicy } from "./artifacts.js";

export interface CommandSpec {
  executable: string;
  args: string[];
}

/**
 * Backup child-process operations. When environment isolation is enabled each operation's child process
 * receives ONLY the fixed non-secret base variables plus that operation's own allowlist (PH-7 env isolation).
 */
export type BackupOperation =
  | "database"
  | "archive"
  | "encrypt"
  | "upload"
  | "verify_download"
  | "list"
  | "delete"
  | "alert"
  | "decrypt"
  | "restore_download";

/** Per-operation allowlists of environment variable names; a trailing `*` makes an entry a prefix. */
export interface EnvIsolationPolicy {
  /** Extra non-secret variables every operation may receive (e.g. AWS_REGION). */
  common: string[];
  operations: Record<BackupOperation, string[]>;
}

export interface BackupConfig {
  databaseUrl: string;
  /**
   * Where production document bytes live. "directory" (default, previous behaviour) archives
   * `documentDirectory`; "object-storage" reads every database-referenced document key from the
   * configured S3-compatible provider (OBJECT_STORAGE_*).
   */
  documentSource?: "directory" | "object-storage";
  /** Required when documentSource is "directory"; unused for "object-storage". */
  documentDirectory?: string;
  restoreDatabaseUrl: string;
  restoreDocumentDirectory: string;
  restoreRoot: string;
  restoreEnvironmentId: string;
  encryptionKmsProfile: string;
  stagingDirectory: string;
  destination: string;
  retentionDays: number;
  /** Newest recoverable backups that are never pruned. Defaults to 7. */
  minRetainedBackups?: number;
  /** Per-tier keep/age policy (7 daily / 4 weekly / 12 monthly by default). */
  tierPolicy?: TierPolicy;
  /** Whether the engine prunes after a verified upload. Default OFF (D-2): only `true` enables destructive pruning. */
  prune?: boolean;
  /** Where the prune setting came from (operator status output only): unset/blank env = "default". */
  pruneSource?: "default" | "explicit";
  /** Write-once vault (S3 Object Lock / lifecycle expiry). Pruning is prohibited in vault mode. */
  vaultMode?: boolean;
  encryption: CommandSpec;
  decryption: CommandSpec;
  upload: CommandSpec;
  download: CommandSpec;
  /** Optional read-only verifier download (Package B). Undefined = falls back to `download`. */
  verifyDownload?: CommandSpec;
  /** Optional restricted restore download (Package B). Undefined = falls back to `download`. */
  restoreDownload?: CommandSpec;
  list: CommandSpec;
  remove: CommandSpec;
  alert: CommandSpec;
  /** Command-level environment isolation. Undefined = legacy behaviour (full process.env to every child). */
  envIsolation?: EnvIsolationPolicy;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: CommandSpec,
  replacements?: Record<string, string>,
  /** Which backup operation this child process performs; selects its scoped environment when isolation is on. */
  operation?: BackupOperation,
) => Promise<CommandResult>;

export interface DatabaseInventory {
  tenantCount: number;
  recordCounts: Record<string, number>;
  documentKeys: string[];
}

export interface ArtifactManifest {
  version: 1;
  artifact: string;
  createdAt: string;
  sha256: string;
  bytes: number;
}

export interface RemoteObject {
  key: string;
  lastModified: string;
}

export interface OperationLog {
  timestamp: string;
  level: "info" | "error";
  operation: "backup" | "restore";
  event: string;
  runId: string;
  durationMs?: number;
  error?: string;
  [key: string]: unknown;
}