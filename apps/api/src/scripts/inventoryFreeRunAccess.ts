/**
 * Owner t222u: READ-ONLY inventory of free (non-subscription) run.access grants and what removing them
 * would do. There is NO apply mode: this script only reads. Removal is a separate, Owner-approved step
 * (docs/T222U_FREE_RUN_ACCESS_REMOVAL_PLAN.md) and must never run against a shared or staging database
 * without explicit authorisation.
 *   pnpm --filter api inventory:free-run-access [--protect-ids=1,2] [--protect-prefix="QA ,Demo "]
 */
import { planFreeRunAccessRemoval } from "../lib/billing/freeRunAccessInventory.js";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  if (process.argv.includes("--apply")) {
    process.stderr.write("No apply mode: this inventory is read-only. Removal is a separately approved step.\n");
    process.exit(2);
  }
  const protectBrokerageIds = (arg("protect-ids") ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  const protectNamePrefixes = (arg("protect-prefix") ?? "").split(",").map((s) => s.trimStart()).filter(Boolean);
  const plan = await planFreeRunAccessRemoval({ protectBrokerageIds, protectNamePrefixes });
  process.stdout.write(`${JSON.stringify({ mode: "DRY-RUN (read-only)", ...plan }, null, 2)}\n`);
}

main().then(() => process.exit(0), (err) => { process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`); process.exit(1); });
