// Agent Engine 2.0 — Step 2: Security & Observability Hardening.
//
// GET /api/internal/metrics — Prometheus text-format exposition of this
// process's in-memory metrics registry (@aee/events's metrics.ts).
// Secured by requireMetricsAuth (lib/metricsAuth.ts, bearer token,
// fail-closed in production — see that file's own comment). Mounted
// outside requireAuth's session-cookie scheme deliberately: a metrics
// scraper is a machine-to-machine caller with its own token, not a signed
// in user.

import { Router } from "express";
import { renderMetricsText } from "@aee/events";
import { requireMetricsAuth } from "../lib/metricsAuth.js";
import { sampleQueueGauges } from "../lib/observability/queueGauges.js";

export const metricsRouter = Router();

metricsRouter.get("/", requireMetricsAuth, async (_req, res) => {
  // AE Step 2 closure — Part B: gauges are sampled fresh at scrape time
  // (see queueGauges.ts's own module comment for why), immediately before
  // rendering — every other metric here is already up to date, having
  // been incremented/observed as its own event happened.
  await sampleQueueGauges();
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(renderMetricsText());
});
