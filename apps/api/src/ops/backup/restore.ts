import { runCommand } from "./commands.js";
import { loadProductionBackupConfig } from "./config.js";
import { restoreBackup } from "./engine.js";

function argument(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
  if (!found) throw new Error(`Required argument --${name}=... is missing`);
  return found;
}

function optionalTier(): "daily" | "weekly" | "monthly" | undefined {
  const value = process.argv.slice(2).find((entry) => entry.startsWith("--tier="))?.slice("--tier=".length);
  if (value === undefined) return undefined;
  if (value !== "daily" && value !== "weekly" && value !== "monthly") throw new Error("--tier must be daily, weekly or monthly");
  return value;
}

await restoreBackup(
  loadProductionBackupConfig(),
  {
    artifact: argument("artifact"),
    confirmDisposable: process.argv.includes("--confirm-disposable"),
    tier: optionalTier(),
  },
  { run: runCommand },
);