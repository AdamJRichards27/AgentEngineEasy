import type { NextFunction, Request, Response } from "express";
import { newCorrelationId } from "@aee/events";

export const CORRELATION_ID_HEADER = "X-Correlation-Id";

/**
 * Attaches a per-HTTP-request correlation id (req.correlationId) and
 * echoes it back as the X-Correlation-Id response header on every
 * response — including ones later short-circuited by CORS, rate limiting,
 * or an oversized body — so any request can be tied to server-side logs
 * and reported back by a client for support correlation. Mounted first in
 * app.ts (right after helmet), ahead of every other middleware and route,
 * so nothing that can reject a request runs before this stamps one on.
 *
 * Reuses @aee/events's newCorrelationId() (a thin randomUUID() wrapper —
 * see packages/events/src/publisher.ts) for consistency with the ids
 * already generated ad hoc across this codebase's domain-engine functions
 * (lib/communications/outbox.ts, lib/transactions.ts, lib/offers.ts, and
 * others) when they publish domain events. This middleware only closes
 * the gap of giving every *HTTP request* an id up front — threading this
 * exact id through each of those per-event newCorrelationId() call sites
 * is a separate, larger change and out of scope here.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = newCorrelationId();
  req.correlationId = id;
  res.setHeader(CORRELATION_ID_HEADER, id);
  next();
}
