import { logger } from "@aee/events";
import {
  configuredPendingReconciliation,
  reconcilePendingDocumentVersions,
  type PendingDocumentReconciliationResult,
} from "./documentStorage.js";
import { dispatchOperationalAlert } from "./operationalAlerts.js";

let registered = false;
let running = false;
let intervalHandle: NodeJS.Timeout | null = null;
let nextCursor = 0;

export interface RegisterDocumentStorageReconcilerOptions {
  startScheduler?: boolean;
  runImmediately?: boolean;
}

export async function runPendingDocumentReconciliationSweep(): Promise<PendingDocumentReconciliationResult | null> {
  if (running) return null;
  running = true;
  try {
    const result = await reconcilePendingDocumentVersions({
      afterId: nextCursor,
    });
    nextCursor = result.nextCursor ?? 0;
    const details = { ...result };
    logger.info("document_storage_pending_reconciliation_completed", details);
    if (
      result.quarantinedIntegrity > 0 ||
      result.quarantinedMissing > 0 ||
      result.deferredProviderError > 0 ||
      result.deferredTransitionError > 0
    ) {
      await dispatchOperationalAlert({
        type: "DOCUMENT_STORAGE_PENDING_RECONCILIATION_FAILURE",
        summary: "Pending document storage reconciliation requires attention",
        dedupKey: "document-storage:pending-reconciliation",
        details,
      });
    }
    return result;
  } finally {
    running = false;
  }
}

export function registerDocumentStorageReconciler(
  options: RegisterDocumentStorageReconcilerOptions = {},
): void {
  if (registered) return;
  registered = true;
  const startScheduler =
    options.startScheduler ?? process.env.NODE_ENV !== "test";
  if (!startScheduler) return;
  const { intervalMs } = configuredPendingReconciliation();
  const run = () => {
    runPendingDocumentReconciliationSweep().catch((error) => {
      logger.error("document_storage_pending_reconciliation_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  intervalHandle = setInterval(run, intervalMs);
  intervalHandle.unref?.();
  if (options.runImmediately ?? true) run();
}

export function stopDocumentStorageReconciler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}