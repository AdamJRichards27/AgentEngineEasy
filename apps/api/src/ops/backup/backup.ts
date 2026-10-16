import { createObjectStorageProvider } from "@aee/integration-object-storage";
import { runCommand } from "./commands.js";
import { loadProductionBackupConfig } from "./config.js";
import { createBackup } from "./engine.js";

const config = loadProductionBackupConfig();
await createBackup(config, {
  run: runCommand,
  ...(config.documentSource === "object-storage" ? { documentProvider: createObjectStorageProvider() } : {}),
});
