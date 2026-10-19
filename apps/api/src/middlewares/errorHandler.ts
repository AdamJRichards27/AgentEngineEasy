// Agent Engine 2.0 — Step 2: Security & Observability Hardening (Part C —
// typed-error-handling audit).
//
// The one gap that audit surfaced above every individual route/boundary
// finding: this application had NO global Express error-handling
// middleware at all. Two concrete consequences, both real and both closed
// by this file:
//
// 1. A synchronous throw (or an error explicitly passed to `next(err)`,
//    which every route in this codebase already does correctly wherever it
//    re-throws an unrecognised error — see e.g. routes/integrations.ts's
//    `if (handleIntegrationError(err, res)) return; ... throw err;`
//    pattern) that reaches Express's own DEFAULT error handler, with
//    NODE_ENV anything other than the literal string "production" (which is
//    how this repository's own `.replit` "Dev" workflow — `pnpm run
//    dev:api`, i.e. `tsx watch src/index.ts` — actually runs today, and how
//    a plain `node dist/index.mjs` run behaves unless an operator sets
//    NODE_ENV=production themselves), returns the error's message AND full
//    stack trace directly in the HTTP response body. That is a real,
//    currently-live information-disclosure gap in the deployed "staging"
//    environment, not a hypothetical one — confirmed by reading Express's
//    own finalhandler behaviour, not assumed.
// 2. No uniform, tested shape for "something truly unexpected happened" —
//    every route that forgot its own try/catch was one uncaught throw away
//    from leaking whatever that error's message happened to be, rather than
//    a deliberately generic message.
//
// This middleware is a SAFETY NET, not a replacement for per-route/
// per-domain error handling. Every dedicated typed error class this
// codebase already has (IntegrationError, CommunicationTenancyError/
// CommunicationTransitionError, PitCrewPropertyMismatchError/
// PitCrewAssigneeMismatchError, RiskExceptionError, MockPaymentStatusSyncError,
// MappingConflictError, and the rest named in
// docs/TYPED_ERROR_HANDLING_AUDIT.md) is still caught and mapped to its own
// correct status code at its own call site — this handler is deliberately
// generic and does NOT attempt to special-case any of them, because doing
// so here would create backward coupling from this shared middleware to
// every domain's error module. It exists for the residual case: an error
// NO route-level catch recognised.
//
// What it does, in order:
//   1. If a response has already started streaming (`res.headersSent`),
//      delegates to Express's own default handler via `next(err)` — the one
//      case Express itself requires (see the Express error-handling guide:
//      "you must delegate to the default Express error handler" once
//      headers are sent, since a second response can never be sent).
//   2. Logs the FULL error (message, stack, and any enumerable properties)
//      via the structured logger (`@aee/events`'s `logger.error`), which
//      already redacts secret/PII-shaped values before writing a single
//      line of JSON — see packages/events/src/redaction.ts. This is the
//      "redacted diagnostic log" half of Part C's requirement: complete
//      detail for whoever operates this service, never truncated or
//      silently dropped, but with the same never-log-key/value-shape
//      guarantees every other log line in this app already gets.
//   3. Returns a SAFE, GENERIC client response — never the error's own
//      `.message` or `.stack` — with one of three status codes: two
//      narrowly-scoped, well-known body-parser failure shapes this app's
//      own `express.json()` limit (app.ts, 1 MB) can throw (oversized body,
//      malformed JSON), which are safe to disclose precisely because they
//      describe the CALLER'S OWN request shape, not this server's internals;
//      and 500 for everything else.

import type { NextFunction, Request, Response } from "express";
import { logger } from "@aee/events";
import { dispatchOperationalAlert } from "../lib/operationalAlerts.js";
import { isRestoredEnvironmentOutboundBlockedError } from "../lib/outboundGuard.js";

const GENERIC_SERVER_ERROR_MESSAGE = "An unexpected error occurred. Please try again or contact support if the problem persists.";

interface BodyParserLikeError extends Error {
  type?: string;
  status?: number;
  statusCode?: number;
}

function isEntityTooLarge(err: BodyParserLikeError): boolean {
  return err.type === "entity.too.large" || err.status === 413 || err.statusCode === 413;
}

function isMalformedBody(err: BodyParserLikeError): boolean {
  // body-parser's JSON middleware (mounted in app.ts as express.json())
  // throws a SyntaxError with .status/.type set this way for invalid JSON —
  // see https://github.com/expressjs/body-parser's own error shapes. Safe
  // to disclose narrowly: this describes the caller's own malformed
  // request body, not any server-side detail.
  return err.type === "entity.parse.failed" || (err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400));
}

/**
 * Global Express error-handling middleware — mounted LAST in app.ts, after
 * every route. Never throws itself; the one thing an error handler must
 * never do is fail in a way that leaves the request hanging exactly like
 * the bug this file exists to stop.
 */
export function globalErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  // WS4-09: a restored environment refused an outbound seam (lib/outboundGuard.ts). Expected, not a fault: no
  // error log, no operational alert (which the same switch blocks anyway); a stable code and 503 for the caller.
  if (isRestoredEnvironmentOutboundBlockedError(err)) {
    logger.warn("restored_environment_outbound_blocked_response", { channel: err.channel, method: req.method, path: req.path });
    res.status(err.httpStatus).json({ error: err.message, code: err.code, channel: err.channel });
    return;
  }

  logger.error("unhandled_route_error", {
    error: err,
    method: req.method,
    path: req.path,
  });
  void dispatchOperationalAlert({
    type: "UNHANDLED_API_ERROR",
    summary: "Unhandled API route error",
    dedupKey: `api:${req.method}:${req.route?.path ?? req.path}`,
    details: { method: req.method, path: req.path },
  });

  const asError = err as BodyParserLikeError;
  if (err instanceof Error && isEntityTooLarge(asError)) {
    res.status(413).json({ error: "Request body is too large." });
    return;
  }
  if (err instanceof Error && isMalformedBody(asError)) {
    res.status(400).json({ error: "Malformed request body." });
    return;
  }

  res.status(500).json({ error: GENERIC_SERVER_ERROR_MESSAGE });
}
