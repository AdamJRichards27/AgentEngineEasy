// Agent Engine 2.0 — Step 2: Security & Observability Hardening.
//
// Records http_requests_total and http_request_duration_ms (@aee/events's
// metrics.ts) for every request, by method and response status class
// (2xx/3xx/4xx/5xx — never the raw path or status code, which would blow
// out cardinality with every :id-bearing route). Mounted right after
// requestId in app.ts so it wraps every route, including ones later
// rejected by CORS/rate-limiting/body-size — the same "every response,
// however it ends" guarantee requestId.ts already documents for itself.

import type { NextFunction, Request, Response } from "express";
import { incrementCounter, observeHistogram, httpStatusClass } from "@aee/events";

const KNOWN_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function httpMetrics(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  const method = KNOWN_METHODS.has(req.method) ? req.method : "other";

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    const statusClass = httpStatusClass(res.statusCode);
    incrementCounter("http_requests_total", { method, status_class: statusClass });
    observeHistogram("http_request_duration_ms", durationMs, { method, status_class: statusClass });
  });

  next();
}
