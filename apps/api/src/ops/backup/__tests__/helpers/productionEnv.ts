// Minimal valid production backup environment for config tests (copy of the T9 fixture).
import path from "node:path";
import { fileURLToPath } from "node:url";

/** R19: the exact configuration fragment that enables pruning: BACKUP_PRUNE=on plus a real, resolvable verifier. */
export const PRUNE_ENABLE_ENV: Record<string, string> = {
  BACKUP_PRUNE: "on",
  BACKUP_DELETE_VERIFY_COMMAND: JSON.stringify([process.execPath, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../verifiers/verifyDeleteMc.mjs"), "--alias", "l", "{remote}"]),
};

export function productionEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const command = JSON.stringify(["tool", "{input}", "{output}", "{kmsProfile}"]);
  return {
    BACKUP_ENVIRONMENT: "production", DATABASE_URL: "postgresql://db.invalid/aee",
    BACKUP_DOCUMENT_DIRECTORY: "/tmp/x/documents", BACKUP_STAGING_DIRECTORY: "/tmp/x/staging",
    BACKUP_DESTINATION: "s3://vault/backups", BACKUP_RETENTION_DAYS: "30",
    BACKUP_ENCRYPT_COMMAND: command, BACKUP_DECRYPT_COMMAND: command,
    BACKUP_UPLOAD_COMMAND: JSON.stringify(["u", "{source}", "{destination}"]),
    BACKUP_DOWNLOAD_COMMAND: JSON.stringify(["d", "{source}", "{destination}"]),
    BACKUP_LIST_COMMAND: JSON.stringify(["l", "{destination}"]),
    BACKUP_DELETE_COMMAND: JSON.stringify(["r", "{object}"]),
    BACKUP_ALERT_COMMAND: JSON.stringify(["a", "{operation}", "{error}"]),
    BACKUP_ENCRYPTION_AUTHENTICATED: "true", BACKUP_ENCRYPTION_KMS_PROFILE: "kms:production-backup",
    BACKUP_RESTORE_DISPOSABLE: "true", BACKUP_RESTORE_ENVIRONMENT_ID: "restore-drill-01",
    BACKUP_RESTORE_ROOT: "/tmp/x/restore-root", BACKUP_RESTORE_DOCUMENT_DIRECTORY: "/tmp/x/restore-root/documents",
    BACKUP_RESTORE_DATABASE_URL: "postgresql://restore.invalid/aee_restore", ...extra,
  };
}
