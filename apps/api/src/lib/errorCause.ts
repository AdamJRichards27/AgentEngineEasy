/**
 * AE GROW Pilot Readiness WP2a — safe summary of a swallowed error's cause.
 *
 * Several fail-closed paths deliberately replace an underlying failure with
 * a typed, user-safe error (e.g. a strict audit write failing becomes
 * AUDIT_FAILURE). The replacement is right for the caller, but without
 * logging the original cause operators cannot tell a constraint violation
 * from a lost connection. This returns only the error's class, code and
 * message (plus the pg constraint name when present) — never the error
 * object itself, whose enumerable fields (e.g. pg's `detail`, `parameters`)
 * can echo row values, transcript text or other PII. The structured logger
 * still applies its own redaction on top.
 */
export interface ErrorCauseSummary {
  causeName: string;
  causeCode?: string;
  causeMessage: string;
  causeConstraint?: string;
}

const MAX_MESSAGE_LENGTH = 300;

export function summarizeErrorCause(err: unknown): ErrorCauseSummary {
  if (err instanceof Error) {
    const withExtras = err as Error & { code?: unknown; constraint?: unknown };
    return {
      causeName: err.name,
      causeCode: typeof withExtras.code === "string" ? withExtras.code : undefined,
      causeMessage: err.message.slice(0, MAX_MESSAGE_LENGTH),
      causeConstraint: typeof withExtras.constraint === "string" ? withExtras.constraint : undefined,
    };
  }
  return { causeName: typeof err, causeMessage: "non-Error value thrown" };
}
