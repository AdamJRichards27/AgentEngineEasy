import { runCommand } from "./commands.js";
import { loadProductionBackupConfig } from "./config.js";
import { restoreBackup } from "./engine.js";
import { parseRestoreArgs } from "./restoreArgs.js";

await restoreBackup(loadProductionBackupConfig(), parseRestoreArgs(process.argv.slice(2)), { run: runCommand });
