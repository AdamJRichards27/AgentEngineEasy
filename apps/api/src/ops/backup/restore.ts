import { runCommand } from "./commands.js";
import { loadProductionBackupConfig } from "./config.js";
import { restoreBackup } from "./engine.js";

function argument(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
  if (!found) throw new Error(`Required argument --${name}=... is missing`);
  return found;
}

await restoreBackup(
  loadProductionBackupConfig(),
  {
    artifact: argument("artifact"),
    confirmDisposable: process.argv.includes("--confirm-disposable"),
  },
  { run: runCommand },
);