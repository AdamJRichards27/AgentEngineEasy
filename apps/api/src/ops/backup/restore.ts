import { createScopedRunner, runCommand } from "./commands.js";
import { loadProductionBackupConfig } from "./config.js";
import { restoreBackup } from "./engine.js";
import { parseRestoreArgs } from "./restoreArgs.js";

const config = loadProductionBackupConfig();
await restoreBackup(config, parseRestoreArgs(process.argv.slice(2)), { run: config.envIsolation ? createScopedRunner(config.envIsolation) : runCommand });
