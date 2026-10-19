import { logger } from "@aee/events";
import { redactSecrets } from "./artifacts.js";
import { BuildStampError, EMBEDDED_BUILD_STAMP, checkBuildStamp } from "./buildStamp.js";
import { loadProductionBackupConfig } from "./config.js";
import { sweepStaging } from "./stagingSweep.js";

// Operator command: sweeps stale staging run directories according to BACKUP_STAGING_SWEEP (off | dry-run | on).
// Output goes through the shared structured logger (central redaction). One JSON line per run on stdout:
//   staging_sweep_disabled          -> mode off, nothing was read or changed
//   staging_sweep, mode=dry-run     -> decisions only, nothing was changed
//   staging_sweep, mode=on          -> decisions applied
// A failure writes one `staging_sweep_failed` line to stderr and sets a non-zero exit code. A run that completed but
// had per-directory errors (counts.error > 0) is also reported as a failure so schedulers notice it.
// The process ends naturally (no process.exit) so buffered stdout/stderr is always flushed.
// Note: the logger caps arrays at 20 items; the complete per-directory record is the staging-root sweep-audit.jsonl.
// Per-directory error reasons are raw fs messages that quote absolute paths (e.g. "EACCES: ..., unlink '/x/y'");
// the console line shows them with quoted paths masked. The staging-root audit file keeps the raw text.
// CLI-SPEC §2 (R29b): a refused configuration exits 78 (CONFIG) with one `staging_sweep_config_refused` line that names
// variables, never values; every other failure keeps exit 1.
const maskPaths = (text: string): string => text.replace(/'[^']*'/g, "'<path>'");
let config: ReturnType<typeof loadProductionBackupConfig> | undefined;
// WS4-13: a stale or unstamped bundle refuses (69; 78 for a missing/malformed expectation) before config is read.
let stampRefused = false;
try {
  checkBuildStamp({ stamp: EMBEDDED_BUILD_STAMP, entryUrl: import.meta.url, env: process.env });
} catch (error) {
  if (!(error instanceof BuildStampError)) throw error;
  logger.error("staging_sweep_build_stamp_refused", { event: "staging_sweep_build_stamp_refused", tool: "backup-cli", kind: error.kind, found: error.found, required: error.required, detail: redactSecrets(error.message).slice(0, 400) });
  process.exitCode = error.exitCode;
  stampRefused = true;
}
if (!stampRefused) {
  try {
    config = loadProductionBackupConfig();
  } catch (error) {
    logger.error("staging_sweep_config_refused", { event: "staging_sweep_config_refused", reason: "config_refused", detail: redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 400) });
    process.exitCode = 78;
  }
}
if (config) {
  try {
    const mode = config.stagingSweep ?? "off";
    if (mode === "off") {
      logger.info("staging_sweep_disabled", { event: "staging_sweep_disabled", mode, message: "BACKUP_STAGING_SWEEP is off (default); set dry-run to preview or on to remove stale directories" });
    } else {
      const report = await sweepStaging({ stagingDirectory: config.stagingDirectory, mode, minAgeMs: (config.stagingSweepMinAgeHours ?? 24) * 3_600_000 });
      const errors = report.counts.error ?? 0;
      logger.info("staging_sweep", { event: "staging_sweep", mode, counts: report.counts, entries: report.entries.map((entry) => (entry.decision === "error" ? { ...entry, reason: maskPaths(entry.reason) } : entry)) });
      if (errors > 0) {
        logger.error("staging_sweep_failed", { event: "staging_sweep_failed", mode, reason: "completed_with_errors", errorCount: errors });
        process.exitCode = 1;
      }
    }
  } catch (error) {
    // Errors from the filesystem carry absolute paths in their message; report only the code for those.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const detail = typeof code === "string" ? code : error instanceof Error ? error.message.slice(0, 200) : "unknown error";
    logger.error("staging_sweep_failed", { event: "staging_sweep_failed", reason: "exception", detail });
    process.exitCode = 1;
  }
}
