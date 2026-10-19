// WS4-07: one switch for restored / cloned environments (a production backup restored for a drill, UAT or an
// investigation). Such a copy carries real queued messages, outbox rows, payment requests and provider settings, so
// the moment its API boots, the background loops would start sending and mutating as if it were production.
//
//   AEE_RESTORED_ENVIRONMENT=true      (also 1 / yes / on; case-insensitive, trimmed)
//
// Name: it states WHAT the deployment is (a restored copy), not which mechanism to turn off, so every current and
// future loop opts in under one meaning, and it follows the repo's AEE_ prefix (AEE_TEST_DB_PER_FILE,
// AEE_DISABLE_SCAN_SCHEDULERS). The narrower WS4-05 AEE_DISABLE_SCAN_SCHEDULERS (exception scan + signal sweep only)
// becomes a SUBSET of this switch wherever both exist (see the WS4-08 stacked branch).
//
// Values: unset / empty / false / 0 / no / off -> today's behaviour, unchanged. true-like -> every loop in
// BACKGROUND_LOOPS stays off. ANY OTHER VALUE FAILS SAFE (loops off) with reason unrecognised_value_fail_closed.
// The switch wins over an explicit `startScheduler: true`. Event handlers, routes and manual runs are not loops
// and are NOT disabled by this switch (see the WS4-07 README for the request-triggered outbound paths).
//
// Every register function that starts a timer must call `backgroundLoopDisabled(<id>)` before starting it and be
// listed in BACKGROUND_LOOPS; __tests__/restoredEnvironment.test.ts fails if a new setInterval appears in a file
// that is not registered here.

import { logger } from "@aee/events";

export const RESTORED_ENVIRONMENT_ENV = "AEE_RESTORED_ENVIRONMENT";

export const BACKGROUND_LOOPS = {
  exception_scan: { file: "lib/exceptions/bootstrap.ts", register: "registerExceptionEngine", effect: "writes risk exceptions" },
  signal_sweep: { file: "lib/propertyIntelligence/sweepBootstrap.ts", register: "registerSignalSweep", effect: "writes Grow signals; operational alert" },
  pit_crew_waiting_on_sweep: { file: "lib/pitCrew/waitingOnSweepBootstrap.ts", register: "registerPitCrewWaitingOnSweep", effect: "records detections; operational alert" },
  communications_outbox: { file: "lib/communications/bootstrap.ts", register: "registerCommunicationsEngine", effect: "SENDS queued email/SMS via providers" },
  financial_payment_outbox: { file: "lib/financial/bootstrap.ts", register: "registerFinancialEngine", effect: "dispatches payment outbox to the payment provider" },
  integrations_outbox: { file: "lib/integrations/bootstrap.ts", register: "registerIntegrationsEngine", effect: "dispatches integration commands / webhooks to providers" },
  document_storage_reconciler: { file: "lib/documentStorageReconciler.ts", register: "registerDocumentStorageReconciler", effect: "reads/quarantines object storage; operational alert" },
  call_transcription_reconciler: { file: "lib/telephony/callTranscriptionReconciler.ts", register: "registerCallTranscriptionReconciler", effect: "transcription provider retries; operational alert" },
} as const;

export type BackgroundLoopId = keyof typeof BACKGROUND_LOOPS;
export const BACKGROUND_LOOP_IDS = Object.keys(BACKGROUND_LOOPS) as BackgroundLoopId[];

export type RestoredEnvironmentReason = "unset" | "explicit_off" | "explicit_on" | "unrecognised_value_fail_closed";
export interface RestoredEnvironmentMode {
  restored: boolean;
  reason: RestoredEnvironmentReason;
}

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

export function restoredEnvironmentMode(env: Record<string, string | undefined> = process.env): RestoredEnvironmentMode {
  const raw = (env[RESTORED_ENVIRONMENT_ENV] ?? "").trim().toLowerCase();
  if (raw === "") return { restored: false, reason: "unset" };
  if (FALSE_VALUES.has(raw)) return { restored: false, reason: "explicit_off" };
  if (TRUE_VALUES.has(raw)) return { restored: true, reason: "explicit_on" };
  return { restored: true, reason: "unrecognised_value_fail_closed" };
}

let summaryLogged = false;

/**
 * True when the restored-environment switch is on: the caller must NOT start its loop. The first disable in a
 * process logs ONE structured line, restored_environment_background_loops_disabled, listing every loop the switch
 * disables (all of BACKGROUND_LOOPS: each one consults this function before starting a timer).
 */
export function backgroundLoopDisabled(loop: BackgroundLoopId, env: Record<string, string | undefined> = process.env): boolean {
  const mode = restoredEnvironmentMode(env);
  if (!mode.restored) return false;
  if (!summaryLogged) {
    summaryLogged = true;
    logger.warn("restored_environment_background_loops_disabled", {
      env: RESTORED_ENVIRONMENT_ENV,
      reason: mode.reason,
      disabled: BACKGROUND_LOOP_IDS,
      firstCaller: loop,
    });
  }
  return true;
}

/** Test-only. */
export function __resetRestoredEnvironmentLogForTesting(): void {
  summaryLogged = false;
}
