import type { GrowCallSessionStatus } from "@aee/db";

/**
 * F2 recording substates intentionally remain in the existing text-backed
 * recording_status column.  Keeping this union local avoids a schema or
 * migration change for values that are independently state-machine guarded.
 */
export type GrowCallRecordingStatus =
  | "NOT_REQUESTED"
  | "DISCLOSURE_REQUIRED"
  | "DISCLOSED"
  | "CONFIRMED"
  | "DECLINED"
  | "UNRECORDED"
  | "DENIED"
  | "PERMITTED_NOT_CAPTURED";

// AE GROW Priority 6 Stage F1 — Call Foundation.
//
// §7 — the single source of truth for valid call-session state
// transitions. Every mutation to grow_call_sessions.status (routes/lib
// code and this file's own tests alike) must go through
// assertValidCallSessionTransition() below rather than writing a new
// status directly — this is what makes "add regression tests for invalid
// transitions" (§7) meaningful rather than a check duplicated ad hoc at
// each call site.
//
// Recording (grow_call_sessions.recordingPermitted/recordingStatus) is an
// orthogonal sub-state machine below — §7 is explicit that "call exists" must
// never be treated as equivalent to "recording authorised". Recording
// transitions never alter the call lifecycle and can change (e.g. a standing
// consent withdrawn) without a call-session state transition.
//
// Parameters are typed as plain `string` (rather than the narrower
// GrowCallSessionStatus union) wherever a value may have come from a
// database row — every text-backed status column in this codebase
// ($inferSelect) is a plain string, not a literal union, matching how
// every other status column (communicationMessages.status,
// entitlementGrants.status, growCommitments.status, etc.) is compared
// elsewhere in this repository. GrowCallSessionStatus is still used for
// the ALLOWED_TRANSITIONS table itself, so the compiler still enforces
// that all 8 known statuses are covered above.

const ALLOWED_TRANSITIONS: Record<GrowCallSessionStatus, readonly GrowCallSessionStatus[]> = {
  DRAFT: ["READY", "CANCELLED"],
  READY: ["DIAL_REQUESTED", "CANCELLED"],
  DIAL_REQUESTED: ["RINGING", "FAILED", "CANCELLED"],
  RINGING: ["CONNECTED", "FAILED", "CANCELLED"],
  CONNECTED: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

/** Terminal states can never transition anywhere else — used by cancel()'s own guard. */
export const TERMINAL_CALL_SESSION_STATUSES: readonly string[] = ["COMPLETED", "FAILED", "CANCELLED"];

export function isValidCallSessionTransition(from: string, to: string): boolean {
  const allowedFrom = (ALLOWED_TRANSITIONS as Record<string, readonly string[]>)[from];
  return allowedFrom?.includes(to) ?? false;
}

export class CallSessionTransitionError extends Error {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super(`Invalid call session transition: ${from} -> ${to}`);
    this.name = "CallSessionTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertValidCallSessionTransition(from: string, to: string): void {
  if (!isValidCallSessionTransition(from, to)) {
    throw new CallSessionTransitionError(from, to);
  }
}

/**
 * Recording is intentionally a second axis: these transitions never alter
 * the call-session status above.  In particular, a missing recording gate
 * settles at UNRECORDED while the base call can continue to COMPLETED.
 */
const ALLOWED_RECORDING_TRANSITIONS: Record<GrowCallRecordingStatus, readonly GrowCallRecordingStatus[]> = {
  NOT_REQUESTED: ["DISCLOSURE_REQUIRED"],
  DISCLOSURE_REQUIRED: ["DISCLOSED", "DECLINED", "UNRECORDED"],
  DISCLOSED: ["CONFIRMED", "DECLINED", "UNRECORDED"],
  CONFIRMED: ["PERMITTED_NOT_CAPTURED", "UNRECORDED", "DECLINED"],
  DECLINED: [],
  UNRECORDED: ["DISCLOSURE_REQUIRED", "DISCLOSED", "DECLINED"],
  DENIED: ["DISCLOSURE_REQUIRED", "UNRECORDED"],
  PERMITTED_NOT_CAPTURED: ["UNRECORDED"],
};

export function isValidRecordingTransition(from: string, to: string): boolean {
  const allowedFrom = (ALLOWED_RECORDING_TRANSITIONS as Record<string, readonly string[]>)[from];
  return allowedFrom?.includes(to) ?? false;
}

export class RecordingStateTransitionError extends Error {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super(`Invalid recording state transition: ${from} -> ${to}`);
    this.name = "RecordingStateTransitionError";
    this.from = from;
    this.to = to;
  }
}

export function assertValidRecordingTransition(from: string, to: string): void {
  if (!isValidRecordingTransition(from, to)) {
    throw new RecordingStateTransitionError(from, to);
  }
}
