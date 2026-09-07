import { runCommand } from "./commands.js";
import { loadProductionBackupConfig } from "./config.js";
import { createBackup } from "./engine.js";

await createBackup(loadProductionBackupConfig(), { run: runCommand });