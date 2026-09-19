import { formatSupportReference } from "./api";

// AE GROW Pilot Readiness WP5 — pure state logic behind
// components/ErrorBoundary.tsx, kept here so it can be unit-tested without a
// DOM. The fallback never shows the error's message or stack (those can
// carry technical detail); it shows only a short support reference.

export interface ErrorBoundaryState {
  hasError: boolean;
  // "Reference: 1a2b3c4d" — the server's correlation id when the failure
  // came from an API response (ApiError.correlationId), otherwise a
  // client-generated id that is logged to the console alongside the error.
  reference?: string;
}

export const INITIAL_ERROR_BOUNDARY_STATE: ErrorBoundaryState = { hasError: false, reference: undefined };

export function correlationIdOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const id = (error as { correlationId?: unknown }).correlationId;
  return typeof id === "string" && id.trim() ? id : undefined;
}

export function makeClientReferenceId(random: () => number = Math.random): string {
  let id = "";
  for (let i = 0; i < 8; i++) id += Math.floor(random() * 16).toString(16);
  return id;
}

export function deriveErrorBoundaryState(error: unknown, makeId: () => string = () => makeClientReferenceId()): ErrorBoundaryState {
  return { hasError: true, reference: formatSupportReference(correlationIdOf(error) ?? makeId()) };
}

// Whether a boundary showing its fallback should reset because the region it
// guards has moved on (route change, different tab, different contact).
export function shouldResetOnKeyChange(state: ErrorBoundaryState, previousKey: unknown, nextKey: unknown): boolean {
  return state.hasError && !Object.is(previousKey, nextKey);
}
