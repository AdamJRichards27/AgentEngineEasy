import { logger } from "@aee/events";
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
const maskPaths = (text: string): string => text.replace(/'[^']*'/g, "'<path>'");
try {
  const config = loadProductionBackupConfig();
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
