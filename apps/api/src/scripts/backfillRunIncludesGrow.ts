/**
 * RUN-INCLUDES-GROW: tops up existing Run (Starter) subscriptions with the Grow entitlements the
 * catalogue now attaches to Starter. See lib/billing/runIncludesGrowBackfill.ts.
 *
 * DRY-RUN BY DEFAULT: prints the plan, writes nothing. Pass --apply to insert. Not imported by index.ts
 * and never runs at boot. Run against a database only with explicit operator approval.
 *   pnpm --filter api backfill:run-includes-grow            # dry run
 *   pnpm --filter api backfill:run-includes-grow --apply    # write (operator approval required)
 */
import { ensureCatalogueSeeded } from "../lib/billing/catalogue.js";
import { backfillRunSubscriptionEntitlements } from "../lib/billing/runIncludesGrowBackfill.js";

async function main() {
  const apply = process.argv.includes("--apply");
  if (apply) await ensureCatalogueSeeded(); // the Starter product rows must exist before topping up
  const r = await backfillRunSubscriptionEntitlements({ dryRun: !apply });
  const byBrokerage = new Map<number, number>();
  for (const p of r.planned) byBrokerage.set(p.brokerageId, (byBrokerage.get(p.brokerageId) ?? 0) + 1);
  console.log(JSON.stringify({
    mode: apply ? "APPLY" : "DRY-RUN",
    subscriptionsChecked: r.subscriptionsChecked,
    plannedGrants: r.planned.length,
    insertedGrants: r.inserted.length,
    brokerages: [...byBrokerage].map(([brokerageId, grants]) => ({ brokerageId, grants })),
    skippedLapsedTrials: r.skippedLapsedTrials,
  }, null, 2));
  if (!apply && r.planned.length > 0) console.log("Dry run only. Re-run with --apply (operator approval required) to insert.");
}

main().then(() => process.exit(0), (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
