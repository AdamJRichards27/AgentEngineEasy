// WS4 follow-up: off-switch for the risk exception scan and Grow signal sweep TIMERS in restored / cloned
// environments (e.g. a backup restored for a drill or for UAT), so a copy of production data does not start
// scanning and writing risk exceptions / signals on its own.
//
//   AEE_DISABLE_SCAN_SCHEDULERS=true   (also 1 / yes / on, case-insensitive, trimmed)
//
// Unset, empty, or false / 0 / no / off: schedulers behave exactly as before (default ON outside NODE_ENV=test).
// Any other non-empty value FAILS CLOSED (schedulers off) and the registration log says so, because a typo in a
// safety switch must not silently leave the timers running.
//
// Scope: only the two scan timers (lib/exceptions/bootstrap.ts, lib/propertyIntelligence/sweepBootstrap.ts).
// Event-driven exception handlers and MANUAL-trigger runs are unaffected. Other background loops (communications
// outbox, integrations outbox, financial, pit crew waiting-on sweep, reconcilers) do NOT read this switch.

export const SCAN_SCHEDULERS_OFF_SWITCH_ENV = "AEE_DISABLE_SCAN_SCHEDULERS";

export type ScanSchedulersOffSwitchReason = "unset" | "explicit_off" | "explicit_on" | "unrecognised_value_fail_closed";

export interface ScanSchedulersOffSwitch {
  disabled: boolean;
  reason: ScanSchedulersOffSwitchReason;
}

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

export function scanSchedulersOffSwitch(env: Record<string, string | undefined> = process.env): ScanSchedulersOffSwitch {
  const raw = (env[SCAN_SCHEDULERS_OFF_SWITCH_ENV] ?? "").trim().toLowerCase();
  if (raw === "") return { disabled: false, reason: "unset" };
  if (FALSE_VALUES.has(raw)) return { disabled: false, reason: "explicit_on" };
  if (TRUE_VALUES.has(raw)) return { disabled: true, reason: "explicit_off" };
  return { disabled: true, reason: "unrecognised_value_fail_closed" };
}
