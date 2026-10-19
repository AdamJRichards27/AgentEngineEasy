import { logger } from "@aee/events";
import {
  configuredCallTranscriptionReconciliation,
  reconcileAbandonedCallTranscriptions,
  type CallTranscriptionReconciliationResult,
} from "./callTranscriptionReconciliation.js";
import { dispatchOperationalAlert } from "../operationalAlerts.js";
import { backgroundLoopDisabled } from "../restoredEnvironment.js";

let registered = false;
let running = false;
let intervalHandle: NodeJS.Timeout | null = null;
let nextCursor = 0;

export interface RegisterCallTranscriptionReconcilerOptions {
  startScheduler?: boolean;
  runImmediately?: boolean;
}

export async function runCallTranscriptionReconciliationSweep(): Promise<CallTranscriptionReconciliationResult | null> {
  if (running) return null;
  running = true;
  try {
    const result = await reconcileAbandonedCallTranscriptions({
      afterId: nextCursor,
    });
    nextCursor = result.nextCursor ?? 0;
    const details = { ...result };
    logger.info("call_transcription_reconciliation_completed", details);
    if (
      result.failedAbandoned > 0 ||
      result.failedUnavailable > 0 ||
      result.failedDeleted > 0 ||
      result.failedTenantMismatch > 0 ||
      result.deferredTransitionError > 0
    ) {
      await dispatchOperationalAlert({
        type: "CALL_TRANSCRIPTION_RECONCILIATION_FAILURE",
        summary: "Call transcription reconciliation requires attention",
        dedupKey: "call-transcription:reconciliation",
        details,
      });
    }
    return result;
  } finally {
    running = false;
  }
}

export function registerCallTranscriptionReconciler(
  options: RegisterCallTranscriptionReconcilerOptions = {},
): void {
  if (registered) return;
  registered = true;
  // WS4-07: AEE_RESTORED_ENVIRONMENT (lib/restoredEnvironment.ts) keeps this timer off (and the runImmediately sweep), even with startScheduler: true.
  if (backgroundLoopDisabled("call_transcription_reconciler")) return;
  const startScheduler =
    options.startScheduler ?? process.env.NODE_ENV !== "test";
  if (!startScheduler) return;
  const { intervalMs } = configuredCallTranscriptionReconciliation();
  const run = () => {
    runCallTranscriptionReconciliationSweep().catch((error) => {
      logger.error("call_transcription_reconciliation_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      void dispatchOperationalAlert({
        type: "CALL_TRANSCRIPTION_RECONCILIATION_FAILURE",
        summary: "Call transcription reconciliation sweep failed",
        dedupKey: "call-transcription:reconciliation:sweep-failed",
        details: { reason: "sweep_failed" },
      }).catch(() => {
        // Alert delivery is best effort; the scheduler must remain alive.
      });
    });
  };
  intervalHandle = setInterval(run, intervalMs);
  intervalHandle.unref?.();
  if (options.runImmediately ?? true) run();
}

export function stopCallTranscriptionReconciler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
