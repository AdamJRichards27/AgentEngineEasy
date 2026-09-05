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

export const metricsRouter = Router();

metricsRouter.get("/", requireMetricsAuth, (_req, res) => {
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(renderMetricsText());
});
