import type { NextFunction, Request, Response } from "express";
import { newCorrelationId, runWithCorrelationId, logger } from "@aee/events";

export const CORRELATION_ID_HEADER = "X-Correlation-Id";

/**
 * Attaches a per-HTTP-request correlation id (req.correlationId), echoes
 * it back as the X-Correlation-Id response header on every response —
 * including ones later short-circuited by CORS, rate limiting, or an
 * oversized body — and (Step 2 hardening) establishes it as the ambient
 * AsyncLocalStorage context (see @aee/events's context.ts) for the entire
 * rest of the request's lifetime. Mounted first in app.ts (right after
 * helmet), ahead of every other middleware and route, so nothing that can
 * reject a request runs before this stamps one on, and every route
 * handler / model-layer function / domain-event publish downstream can
 * read the same id back via currentCorrelationId() without it being
 * threaded through every function signature by hand.
 *
 * This closes the gap this comment used to flag: previously each
 * newCorrelationId() call site (lib/communications/outbox.ts,
 * lib/transactions.ts, lib/offers.ts, lib/integrations/webhooks.ts, and
 * others) minted a fresh, unrelated id per domain event even when it was
 * running inside an HTTP request that already had one. Call sites that
 * have been migrated to currentCorrelationId() now inherit this request's
 * id automatically; see docs/OBSERVABILITY_STANDARD.md for the full list
 * and the six proof flows.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = newCorrelationId();
  req.correlationId = id;
  res.setHeader(CORRELATION_ID_HEADER, id);
  runWithCorrelationId(id, () => {
    logger.info("http_request_received", { method: req.method, path: req.path });
    next();
  });
}
