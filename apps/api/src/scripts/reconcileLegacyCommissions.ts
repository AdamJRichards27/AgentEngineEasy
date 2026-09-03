/**
 * Agent Engine 2.0 — Financial Transaction Engine Verification (Step 2,
 * Integration Readiness Program) — COHERENCE-001 remediation.
 *
 * CLI wrapper around lib/financial/legacyReconciliation.ts's
 * runLegacyCommissionReconciliationBackfill — the Section 7 "preferred
 * solution" backfill shape (idempotent, dry-run capable, produces a
 * report), adapted to the safe-fallback content that module's own header
 * comment explains in full: it never materialises a commissionAgreement
 * or commissionCalculation, only a labelled financialReconciliations row
 * per legacy transaction, for a human to act on.
 *
 * Usage (from the repository root):
 *
 *   pnpm --filter @aee/api exec tsx src/scripts/reconcileLegacyCommissions.ts --brokerage-id=<id> [--apply] [--actor-user-id=<id>]
 *
 * Defaults to dry-run — pass --apply to actually write. Without
 * --brokerage-id, scans every brokerage in the database one at a time and
 * prints one report per brokerage (still governed by the same --apply
 * flag).
 *
 * This script was authored but NOT executed in the session that wrote it
 * — that session had no DATABASE_URL and no way to run any script in this
 * repository (see docs/FINANCIAL_TRANSACTION_ENGINE_VERIFICATION.md,
 * Automated Test Results). It is not required for either COHERENCE-001 or
 * RISK-001 — the "Flag for Reconciliation" route+UI action already
 * satisfies the brief's remediation requirement one transaction at a
 * time. This wrapper exists only as a convenience for an operator who
 * later wants to run the same scan across every historical transaction in
 * a brokerage in one pass, exactly as Section 7's "preferred solution"
 * describes.
 */
import { db, brokerages } from "@aee/db";
import { runLegacyCommissionReconciliationBackfill } from "../lib/financial/legacyReconciliation.js";

function parseArgs(argv: string[]): { brokerageId: number | null; apply: boolean; actorUserId: number | null } {
  let brokerageId: number | null = null;
  let apply = false;
  let actorUserId: number | null = null;
  for (const arg of argv) {
    if (arg === "--apply") apply = true;
    else if (arg.startsWith("--brokerage-id=")) brokerageId = Number(arg.slice("--brokerage-id=".length));
    else if (arg.startsWith("--actor-user-id=")) actorUserId = Number(arg.slice("--actor-user-id=".length));
  }
  return { brokerageId, apply, actorUserId };
}

async function main() {
  const { brokerageId, apply, actorUserId } = parseArgs(process.argv.slice(2));
  const dryRun = !apply;

  const targetBrokerageIds =
    brokerageId != null ? [brokerageId] : (await db.select({ id: brokerages.id }).from(brokerages)).map((b) => b.id);

  console.log(
    `Legacy commission reconciliation backfill — ${dryRun ? "DRY RUN (pass --apply to write)" : "APPLYING"} — ${targetBrokerageIds.length} brokerage(s).`,
  );

  let totalScanned = 0;
  let totalCreated = 0;
  let totalAlreadyFlagged = 0;
  let totalSkipped = 0;

  for (const id of targetBrokerageIds) {
    const report = await runLegacyCommissionReconciliationBackfill(id, { dryRun, actorUserId });
    totalScanned += report.scanned;
    totalCreated += report.created;
    totalAlreadyFlagged += report.alreadyFlagged;
    totalSkipped += report.skipped.length;

    console.log(
      `  brokerage ${id}: scanned=${report.scanned} created=${report.created} alreadyFlagged=${report.alreadyFlagged} skipped=${report.skipped.length}`,
    );
    for (const row of report.rows) {
      console.log(`    transaction ${row.transactionId} (property ${row.propertyId}): ${row.outcome} — ${(row.grossCommissionCents / 100).toFixed(2)}`);
    }
    for (const skip of report.skipped) {
      console.log(`    transaction ${skip.transactionId}: SKIPPED — ${skip.reason}`);
    }
  }

  console.log(
    `Done. Totals — scanned=${totalScanned} created=${totalCreated} alreadyFlagged=${totalAlreadyFlagged} skipped=${totalSkipped}. ${
      dryRun ? "Nothing was written (dry run)." : ""
    }`,
  );

  // @aee/db's `db` export does not expose its underlying pg Pool (see
  // packages/db/src/index.ts), so there is no clean pool.end() available
  // to this script the way packages/db/src/migrate.ts's own standalone
  // pool has. An explicit exit avoids the process hanging on the open
  // pool's keep-alive connections once the script's own work is done.
  process.exit(0);
}

main().catch((err) => {
  console.error("Legacy commission reconciliation backfill failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
