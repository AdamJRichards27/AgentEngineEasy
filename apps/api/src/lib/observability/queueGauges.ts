// Agent Engine 2.0 — Step 2: Security & Observability Hardening (Part B).
//
// Samples the current, true state of every background-processing queue
// this app has, plus the current count of open CRITICAL risk exceptions,
// and publishes them as gauges (packages/events/src/metrics.ts) — the
// correct Prometheus pattern for a "current value" metric is to sample it
// fresh at scrape time (see routes/metrics.ts, which calls
// sampleQueueGauges() immediately before rendering), never to try to
// track it incrementally as items are enqueued/dequeued, which drifts the
// moment any code path updates a row without going through a single
// tracked function.
//
// Every query here is a COUNT/MIN aggregate, never a per-row SELECT — this
// runs on every metrics scrape, so it must stay cheap regardless of queue
// depth, and existing (status, next_attempt_at) indexes on these tables
// (see their own schema files) make each of these a fast index scan.

import { sql, and, inArray } from "drizzle-orm";
import {
  db,
  integrationOutbox,
  financialPaymentOutbox,
  communicationMessages,
  riskExceptions,
  OPEN_RISK_EXCEPTION_STATUSES,
} from "@aee/db";
import { setGauge, logger } from "@aee/events";

function publishBacklogGauges(queue: "integration_outbox" | "financial_payment_outbox" | "communications_outbox", count: number, oldest: Date | string | null): void {
  setGauge("queue_backlog_size", count, { queue });
  setGauge("queue_oldest_item_age_ms", oldest ? Date.now() - new Date(oldest).getTime() : 0, { queue });
}

async function sampleIntegrationOutbox(): Promise<void> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${integrationOutbox.createdAt})` })
    .from(integrationOutbox)
    .where(inArray(integrationOutbox.status, ["PENDING", "RETRY_SCHEDULED"]));
  publishBacklogGauges("integration_outbox", row?.count ?? 0, row?.oldest ?? null);
}

async function sampleFinancialPaymentOutbox(): Promise<void> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${financialPaymentOutbox.createdAt})` })
    .from(financialPaymentOutbox)
    .where(inArray(financialPaymentOutbox.status, ["PENDING"]));
  publishBacklogGauges("financial_payment_outbox", row?.count ?? 0, row?.oldest ?? null);
}

async function sampleCommunicationsOutbox(): Promise<void> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${communicationMessages.createdAt})` })
    .from(communicationMessages)
    .where(inArray(communicationMessages.status, ["QUEUED", "RETRY_SCHEDULED"]));
  publishBacklogGauges("communications_outbox", row?.count ?? 0, row?.oldest ?? null);
}

/** Called once, immediately before each GET /api/internal/metrics render — see routes/metrics.ts. Never call from a request/background path other than the metrics scrape itself (a gauge is meant to reflect "right now", not be sampled speculatively). */
export async function sampleQueueGauges(): Promise<void> {
  try {
    await sampleIntegrationOutbox();
    await sampleFinancialPaymentOutbox();
    await sampleCommunicationsOutbox();

    const [criticalRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(riskExceptions)
      .where(and(inArray(riskExceptions.status, OPEN_RISK_EXCEPTION_STATUSES), inArray(riskExceptions.severity, ["CRITICAL"])));
    setGauge("unresolved_critical_risk_gauge", criticalRow?.count ?? 0, { status: "open" });
  } catch (err) {
    // Fail-open for the SCRAPE itself (never 500 the metrics endpoint over
    // a gauge query) — but this is exactly the kind of failure an operator
    // needs to know about, so it goes to the structured logger, never
    // silently swallowed.
    logger.error("sample_queue_gauges_failed", { error: err });
  }
}
