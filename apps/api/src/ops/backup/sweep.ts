import { loadProductionBackupConfig } from "./config.js";
import { sweepStaging } from "./stagingSweep.js";

// Operator command: sweeps stale staging run directories according to BACKUP_STAGING_SWEEP (off | dry-run | on).
const config = loadProductionBackupConfig();
const mode = config.stagingSweep ?? "off";
if (mode === "off") {
  console.log(JSON.stringify({ event: "staging_sweep_disabled", message: "BACKUP_STAGING_SWEEP is off (default); set dry-run to preview or on to remove stale directories" }));
} else {
  const report = await sweepStaging({ stagingDirectory: config.stagingDirectory, mode, minAgeMs: (config.stagingSweepMinAgeHours ?? 24) * 3_600_000 });
  console.log(JSON.stringify({ event: "staging_sweep", mode, counts: report.counts, entries: report.entries }));
}
