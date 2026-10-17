import type { TierPolicy } from "./artifacts.js";

export interface CommandSpec {
  executable: string;
  args: string[];
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
  /** Whether the engine prunes after a verified upload. Undefined = on (unchanged #224 behaviour). */
  prune?: boolean;
  /** Write-once vault (S3 Object Lock / lifecycle expiry). Pruning is prohibited in vault mode. */
  vaultMode?: boolean;
  encryption: CommandSpec;
  decryption: CommandSpec;
  upload: CommandSpec;
  download: CommandSpec;
  list: CommandSpec;
  remove: CommandSpec;
  alert: CommandSpec;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: CommandSpec,
  replacements?: Record<string, string>,
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