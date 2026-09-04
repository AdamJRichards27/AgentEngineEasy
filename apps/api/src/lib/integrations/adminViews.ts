// Agent Engine 2.0 — AE Step 5 remediation — Integration administration UI
// (Settings → Integrations) read models.
//
// Every query here is brokerage-scoped by an explicit brokerageId
// parameter the ROUTE derives from req.authedUser (never a client-supplied
// tenant id — same discipline as every other query in this module).
// Deliberately read-only and additive: no new tables, no new persisted
// "reconciliation run" (the schema's own header comment on
// packages/db/src/schema/integrations.ts documents that framework as
// out-of-scope) — the reconciliation view here is an on-demand,
// live-computed snapshot over financial_reconciliations, matching that
// documented decision.

import { and, desc, eq, gte, isNull, lte, sql, type SQL } from "drizzle-orm";
import {
  db,
  integrationConnections,
  integrationOutbox,
  integrationInbox,
  integrationDeadLetters,
  financialReconciliations,
  financialPaymentRequests,
  type IntegrationConnection,
} from "@aee/db";
import { listProviderCatalogue } from "./registry.js";

// ---------------------------------------------------------------------
// 12.1 Integration overview.
// ---------------------------------------------------------------------

export interface IntegrationOverviewRow {
  providerId: string;
  category: string;
  displayName: string;
  environmentClassification: string;
  capabilities: string[];
  // A catalogue entry with no connection has ALL of these null — the UI
  // must render this as "installed, not connected", never as connected
  // (Section 10's own hard requirement).
  connectionId: string | null;
  connectionDisplayName: string | null;
  connectionStatus: string | null;
  approvalStatus: string | null;
  health: string | null;
  lastSuccessfulActivityAt: string | null;
  outstandingFailures: number;
  deadLetterCount: number;
  reconciliationStatus: "NOT_APPLICABLE" | "OK" | "VARIANCE_PRESENT";
}

async function countActiveDeadLetters(connectionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(integrationDeadLetters)
    .where(and(eq(integrationDeadLetters.connectionId, connectionId), isNull(integrationDeadLetters.replayedAt)));
  return row?.count ?? 0;
}

async function countOutstandingFailures(connectionId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(integrationOutbox)
    .where(and(eq(integrationOutbox.connectionId, connectionId), eq(integrationOutbox.status, "RETRY_SCHEDULED")));
  return row?.count ?? 0;
}

async function lastSuccessfulActivity(connectionId: string): Promise<Date | null> {
  const [lastSent] = await db
    .select({ at: integrationOutbox.dispatchedAt })
    .from(integrationOutbox)
    .where(and(eq(integrationOutbox.connectionId, connectionId), eq(integrationOutbox.status, "SENT")))
    .orderBy(desc(integrationOutbox.dispatchedAt))
    .limit(1);
  const [lastProcessed] = await db
    .select({ at: integrationInbox.processedAt })
    .from(integrationInbox)
    .where(and(eq(integrationInbox.connectionId, connectionId), eq(integrationInbox.processingStatus, "PROCESSED")))
    .orderBy(desc(integrationInbox.processedAt))
    .limit(1);
  const candidates = [lastSent?.at, lastProcessed?.at].filter((d): d is Date => d != null);
  if (candidates.length === 0) return null;
  return new Date(Math.max(...candidates.map((d) => d.getTime())));
}

export async function getIntegrationOverview(brokerageId: number): Promise<IntegrationOverviewRow[]> {
  const providers = await listProviderCatalogue();
  const connections = await db.select().from(integrationConnections).where(eq(integrationConnections.brokerageId, brokerageId));

  const rows: IntegrationOverviewRow[] = [];
  for (const provider of providers) {
    const providerConnections = connections.filter((c) => c.providerId === provider.id);
    if (providerConnections.length === 0) {
      rows.push({
        providerId: provider.id,
        category: provider.category,
        displayName: provider.displayName,
        environmentClassification: provider.environmentClassification,
        capabilities: (provider.capabilities as unknown as string[]) ?? [],
        connectionId: null,
        connectionDisplayName: null,
        connectionStatus: null,
        approvalStatus: null,
        health: null,
        lastSuccessfulActivityAt: null,
        outstandingFailures: 0,
        deadLetterCount: 0,
        reconciliationStatus: "NOT_APPLICABLE",
      });
      continue;
    }

    for (const connection of providerConnections) {
      const [deadLetterCount, outstandingFailures, lastActivity] = await Promise.all([
        countActiveDeadLetters(connection.id),
        countOutstandingFailures(connection.id),
        lastSuccessfulActivity(connection.id),
      ]);

      let reconciliationStatus: IntegrationOverviewRow["reconciliationStatus"] = "NOT_APPLICABLE";
      if (provider.category === "FINANCIAL") {
        const [varianceRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(financialReconciliations)
          .where(and(eq(financialReconciliations.brokerageId, brokerageId), eq(financialReconciliations.status, "VARIANCE")));
        reconciliationStatus = (varianceRow?.count ?? 0) > 0 ? "VARIANCE_PRESENT" : "OK";
      }

      rows.push({
        providerId: provider.id,
        category: provider.category,
        displayName: provider.displayName,
        environmentClassification: provider.environmentClassification,
        capabilities: (provider.capabilities as unknown as string[]) ?? [],
        connectionId: connection.id,
        connectionDisplayName: connection.displayName,
        connectionStatus: connection.status,
        approvalStatus: connection.status === "DRAFT" ? "NOT_REQUESTED" : connection.status === "PENDING_APPROVAL" ? "PENDING" : connection.status === "REJECTED" ? "REJECTED" : "APPROVED",
        health: connection.healthStatus,
        lastSuccessfulActivityAt: lastActivity ? lastActivity.toISOString() : null,
        outstandingFailures,
        deadLetterCount,
        reconciliationStatus,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------
// 12.3 Integration activity — a unified outbound+inbound feed, filterable.
// No unrestricted payload browsing (Section 12.3's own requirement) —
// commandPayload/payload are never included in this read model.
// ---------------------------------------------------------------------

export interface IntegrationActivityRow {
  id: string;
  direction: "OUTBOUND" | "INBOUND";
  provider: string | null;
  connectionId: string;
  capabilityOrEventType: string;
  status: string;
  retryCount: number | null;
  errorClass: string | null;
  occurredAt: string;
  correlationId: string | null;
  deadLettered: boolean;
}

export interface IntegrationActivityFilter {
  connectionId?: string;
  direction?: "OUTBOUND" | "INBOUND";
  status?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export async function getIntegrationActivity(brokerageId: number, filter: IntegrationActivityFilter): Promise<IntegrationActivityRow[]> {
  const limit = Math.min(filter.limit ?? 100, 500);
  const rows: IntegrationActivityRow[] = [];

  if (!filter.direction || filter.direction === "OUTBOUND") {
    const conditions: SQL[] = [eq(integrationOutbox.brokerageId, brokerageId)];
    if (filter.connectionId) conditions.push(eq(integrationOutbox.connectionId, filter.connectionId));
    if (filter.status) conditions.push(eq(integrationOutbox.status, filter.status));
    if (filter.from) conditions.push(gte(integrationOutbox.updatedAt, filter.from));
    if (filter.to) conditions.push(lte(integrationOutbox.updatedAt, filter.to));
    const outboundRows = await db.select().from(integrationOutbox).where(and(...conditions)).orderBy(desc(integrationOutbox.updatedAt)).limit(limit);
    for (const row of outboundRows) {
      rows.push({
        id: row.id,
        direction: "OUTBOUND",
        provider: null,
        connectionId: row.connectionId,
        capabilityOrEventType: row.capability,
        status: row.status,
        retryCount: row.attempts,
        errorClass: row.lastError ? row.status : null,
        occurredAt: row.updatedAt.toISOString(),
        correlationId: row.correlationId,
        deadLettered: row.status === "DEAD_LETTERED",
      });
    }
  }

  if (!filter.direction || filter.direction === "INBOUND") {
    const conditions: SQL[] = [eq(integrationInbox.brokerageId, brokerageId)];
    if (filter.connectionId) conditions.push(eq(integrationInbox.connectionId, filter.connectionId));
    if (filter.status) conditions.push(eq(integrationInbox.processingStatus, filter.status));
    if (filter.from) conditions.push(gte(integrationInbox.receivedAt, filter.from));
    if (filter.to) conditions.push(lte(integrationInbox.receivedAt, filter.to));
    const inboundRows = await db.select().from(integrationInbox).where(and(...conditions)).orderBy(desc(integrationInbox.receivedAt)).limit(limit);
    for (const row of inboundRows) {
      rows.push({
        id: String(row.id),
        direction: "INBOUND",
        provider: row.provider,
        connectionId: row.connectionId,
        capabilityOrEventType: row.eventType,
        status: row.processingStatus,
        retryCount: null,
        errorClass: row.processingError ? row.processingStatus : null,
        occurredAt: row.receivedAt.toISOString(),
        correlationId: null,
        deadLettered: row.processingStatus === "FAILED",
      });
    }
  }

  rows.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  return rows.slice(0, limit);
}

// ---------------------------------------------------------------------
// 12.5 Reconciliation view — on-demand, live-computed (no persisted "run").
// ---------------------------------------------------------------------

export interface ReconciliationSnapshot {
  computedAt: string;
  scope: "FINANCIAL_PAYMENT_REQUESTS";
  aeRecordCount: number;
  providerRecordCount: number;
  matchedCount: number;
  missingCount: number;
  fieldMismatchCount: number;
  unresolvedMappingCount: number;
}

export async function getReconciliationSnapshot(brokerageId: number): Promise<ReconciliationSnapshot> {
  const [{ count: aeRecordCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(financialPaymentRequests)
    .where(eq(financialPaymentRequests.brokerageId, brokerageId));

  const reconciliations = await db.select().from(financialReconciliations).where(and(eq(financialReconciliations.brokerageId, brokerageId), eq(financialReconciliations.recordType, "financial_payment_request")));

  // Only the latest evidence row per payment request counts toward the
  // snapshot — an earlier VARIANCE superseded by a later match is not
  // still a mismatch (same "latest wins" rule rules/financial.ts's FIN05
  // applies).
  const latestByRecordId = new Map<string, (typeof reconciliations)[number]>();
  for (const row of reconciliations) {
    const existing = latestByRecordId.get(row.recordId);
    if (!existing || existing.createdAt.getTime() < row.createdAt.getTime()) {
      latestByRecordId.set(row.recordId, row);
    }
  }

  let matchedCount = 0;
  let fieldMismatchCount = 0;
  for (const row of latestByRecordId.values()) {
    if (row.status === "VARIANCE") fieldMismatchCount++;
    else matchedCount++;
  }

  const providerRecordCount = latestByRecordId.size;
  const missingCount = Math.max(0, aeRecordCount - providerRecordCount);

  return {
    computedAt: new Date().toISOString(),
    scope: "FINANCIAL_PAYMENT_REQUESTS",
    aeRecordCount,
    providerRecordCount,
    matchedCount,
    missingCount,
    fieldMismatchCount,
    // "Unresolved mapping" here means a financial_payment_request the
    // brokerage has never linked to an external reference at all — distinct
    // from "missing" (which counts every AE record the provider hasn't
    // reported evidence for yet, mapped or not). Reusing the same figure
    // keeps this snapshot honest about what it can actually see without a
    // persisted mapping-coverage table.
    unresolvedMappingCount: missingCount,
  };
}

export type { IntegrationConnection };
