// Specifier is "../lib/api" (not "./api") on purpose: the behaviour tests mock that exact specifier.
import { apiErrorMessage } from "../lib/api";
import { ACTIVITY_TYPE_NOT_MANUAL } from "@aee/domain";

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
