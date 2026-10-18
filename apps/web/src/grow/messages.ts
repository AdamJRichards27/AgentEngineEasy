// Moved unchanged from Grow.tsx so a later shell can reuse this panel.

import { apiErrorMessage } from "../lib/api";
import { ACTIVITY_TYPE_NOT_MANUAL } from "@aee/domain";

export function growActivityTypeLabel(activityType: string): string {
  if (activityType === "call_summary") return "Call summary";
  return activityType.replace(/_/g, " ");
}
export function sandboxCallStatusLabel(status: string): string {
  switch (status) {
    case "READY":
      return "Ready to confirm";
    case "DIAL_REQUESTED":
      return "Sandbox dial requested";
    case "RINGING":
      return "Sandbox ringing";
    case "CONNECTED":
      return "Connected in sandbox";
    case "COMPLETED":
      return "Sandbox call completed";
    case "FAILED":
      return "Sandbox call failed";
    case "CANCELLED":
      return "Sandbox call cancelled";
    default:
      return "Preparing sandbox call";
  }
}
// AE GROW Completion W2-B (G-5) — the one way this page turns a failure into a
// sentence. It was already here (as callErrorMessage, used by the call panel);
// every remaining `(error as ApiError).friendly` cast on this page now goes
// through it instead, because that cast renders the literal string "undefined"
// whenever the failure isn't an ApiError — a dropped connection, an aborted
// request, or anything thrown before the response was parsed.
// A hand-log refusal carries the server's sentence ("Only calls, meetings and
// notes can be logged by hand."). Show that text. Other failures stay on
// apiErrorMessage, which is the plain sentence every other panel already uses.
export function growErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && (error as { code?: unknown }).code === ACTIVITY_TYPE_NOT_MANUAL) {
    const serverMessage = (error as { serverMessage?: unknown }).serverMessage;
    if (typeof serverMessage === "string" && serverMessage.trim().length > 0) return serverMessage;
  }
  return apiErrorMessage(error, fallback);
}
export function recordingGateName(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/^./, (first) => first.toUpperCase())
    .trim();
}
export function opportunityLifecycleOpen(status: string, stage: string): boolean {
  return status === "Open" && stage !== "Lost" && stage !== "Converted";
}
/** Status cell for a Lost row names the stored lost reason. Other statuses stay as they are. */
export function opportunityStatusLabel(status: string, lostReason: string | null | undefined): string {
  if (status !== "Lost") return status;
  const reason = typeof lostReason === "string" ? lostReason.trim() : "";
  return reason.length > 0 ? `Lost: ${reason}` : "Lost";
}
