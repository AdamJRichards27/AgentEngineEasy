// WS4 follow-up: pluggable alert hook for the scheduled risk exception scan.
//
// Before this, a scheduled scan that threw (or completed with per-rule errors) produced only a log line
// (bootstrap.ts's exception_engine_scheduled_scan_failed), so nothing could page an operator. This module defines a
// deliberately small sink interface the scheduler tick calls on failure. The DEFAULT SINK IS A NO-OP: no real
// receiver, transport or credential is wired here. Choosing and configuring a real receiver (e.g. an adapter onto
// lib/operationalAlerts.ts's dispatchOperationalAlert with a new alert type and policy) is a separate, approved change.
//
// Contract: notify() may be sync or async; anything it throws or rejects with is caught and logged
// (exception_engine_scan_failure_alert_sink_failed) and never affects the scan, the tick or the timer. The tick
// does not await the sink, so a slow or hung receiver cannot delay or stack scheduler ticks.

import { logger } from "@aee/events";

export type ScanFailureKind = "scan_threw" | "scan_completed_with_errors";

export interface ScanFailureAlert {
  kind: ScanFailureKind;
  trigger: "SCHEDULED";
  /** ISO-8601 UTC time the failure was observed by the tick. */
  occurredAt: string;
  durationMs: number;
  /** scan_threw only: the thrown error's name and message (message truncated to 500 chars). No stack, no data rows. */
  errorName?: string;
  errorMessage?: string;
  /** scan_completed_with_errors only. */
  scanRunId?: string;
  errors?: number;
}

export interface ScanFailureAlertSink {
  notify(alert: ScanFailureAlert): void | Promise<void>;
}

export const noopScanFailureAlertSink: ScanFailureAlertSink = Object.freeze({
  notify(): void {
    /* intentionally nothing: no receiver configured */
  },
});

/** Test/dev receiver: keeps every alert in memory. Never used unless explicitly installed. */
export function createRecordingScanFailureAlertSink(): ScanFailureAlertSink & { alerts: ScanFailureAlert[] } {
  const alerts: ScanFailureAlert[] = [];
  return {
    alerts,
    notify(alert) {
      alerts.push(alert);
    },
  };
}

let currentSink: ScanFailureAlertSink = noopScanFailureAlertSink;

/** Install a sink (boot wiring or tests). Pass null to restore the no-op default. Returns the previous sink. */
export function setScanFailureAlertSink(sink: ScanFailureAlertSink | null): ScanFailureAlertSink {
  const previous = currentSink;
  currentSink = sink ?? noopScanFailureAlertSink;
  return previous;
}

export function getScanFailureAlertSink(): ScanFailureAlertSink {
  return currentSink;
}

function logSinkFailure(err: unknown, alert: ScanFailureAlert): void {
  logger.warn("exception_engine_scan_failure_alert_sink_failed", {
    kind: alert.kind,
    sinkError: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
  });
}

/** Fire-and-forget delivery to the current sink. Never throws, never rejects. */
export function notifyScanFailure(alert: ScanFailureAlert): void {
  try {
    const result = currentSink.notify(alert);
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch((err: unknown) => logSinkFailure(err, alert));
    }
  } catch (err) {
    logSinkFailure(err, alert);
  }
}
