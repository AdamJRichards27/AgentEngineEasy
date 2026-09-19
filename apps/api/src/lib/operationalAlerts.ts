import { logger } from "@aee/events";
import { isProductionEnvironment } from "./env.js";

export type OperationalAlertType =
  | "UNHANDLED_API_ERROR"
  | "DB_READINESS_FAILURE"
  | "STORAGE_READINESS_FAILURE"
  | "DOCUMENT_STORAGE_INGESTION_RETRY_REQUIRED"
  | "DOCUMENT_STORAGE_PENDING_RECONCILIATION_FAILURE"
  | "CALL_TRANSCRIPTION_RECONCILIATION_FAILURE"
  | "AUTH_ANOMALY"
  | "BACKUP_FAILURE"
  | "INTEGRATION_WEBHOOK_FAILURE"
  | "FINANCIAL_RECONCILIATION_VARIANCE"
  | "TENANT_SECURITY_SIGNAL"
  | "TEST";

export interface AlertPolicy {
  severity: "critical" | "high" | "medium" | "low";
  owner: string;
  runbook: string;
}

export const OPERATIONAL_ALERT_POLICIES: Readonly<Record<OperationalAlertType, AlertPolicy>> = {
  UNHANDLED_API_ERROR: { severity: "high", owner: "api-platform", runbook: "api-unhandled-errors" },
  DB_READINESS_FAILURE: { severity: "critical", owner: "api-platform", runbook: "database-readiness" },
  STORAGE_READINESS_FAILURE: { severity: "critical", owner: "api-platform", runbook: "document-storage-readiness" },
  DOCUMENT_STORAGE_INGESTION_RETRY_REQUIRED: { severity: "high", owner: "integrations", runbook: "document-storage-ingestion-retry" },
  DOCUMENT_STORAGE_PENDING_RECONCILIATION_FAILURE: { severity: "high", owner: "operations", runbook: "document-storage-pending-reconciliation" },
  CALL_TRANSCRIPTION_RECONCILIATION_FAILURE: { severity: "high", owner: "operations", runbook: "call-transcription-reconciliation" },
  AUTH_ANOMALY: { severity: "high", owner: "security", runbook: "authentication-anomaly" },
  BACKUP_FAILURE: { severity: "critical", owner: "operations", runbook: "backup-restore" },
  INTEGRATION_WEBHOOK_FAILURE: { severity: "high", owner: "integrations", runbook: "integration-webhook-failure" },
  FINANCIAL_RECONCILIATION_VARIANCE: { severity: "high", owner: "finance-operations", runbook: "financial-reconciliation" },
  TENANT_SECURITY_SIGNAL: { severity: "critical", owner: "security", runbook: "tenant-isolation" },
  TEST: { severity: "low", owner: "operations", runbook: "alert-delivery-test" },
};

export interface OperationalAlertInput {
  type: OperationalAlertType;
  summary: string;
  dedupKey: string;
  details?: Record<string, unknown>;
}

export type OperationalAlertResult =
  | { status: "disabled" | "deduplicated" }
  | { status: "delivered"; responseStatus: number }
  | { status: "failed"; reason: string; attempts: number };

interface AlertEnvelope extends OperationalAlertInput, AlertPolicy {
  occurredAt: string;
  service: string;
  environment: string;
}

type AlertTransport = (url: string, token: string, envelope: AlertEnvelope) => Promise<number>;

const recentlyDispatched = new Map<string, number>();
let transport: AlertTransport = async (url, token, envelope) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(envelope),
      signal: controller.signal,
    });
    return response.status;
  } finally {
    clearTimeout(timeout);
  }
};

function configuredCooldownMs(): number {
  const parsed = Number(process.env.OPERATIONAL_ALERTS_COOLDOWN_SECONDS ?? 300);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 86_400 ? parsed * 1_000 : 300_000;
}

function validateWebhookUrl(value: string | undefined, production: boolean): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (production && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Production fails closed only when the deployment explicitly declares that
 * external alert delivery is required. Unselected providers remain disabled.
 */
export function assertOperationalAlertsConfigured(): void {
  if (!isProductionEnvironment()) return;
  if (process.env.OPERATIONAL_ALERTS_ENABLED !== "true") {
    throw new Error("Production operational alerts require OPERATIONAL_ALERTS_ENABLED=true.");
  }
  if (process.env.OPERATIONAL_ALERTS_PROVIDER !== "webhook") {
    throw new Error("Production operational alerts require OPERATIONAL_ALERTS_PROVIDER=webhook.");
  }
  if (!validateWebhookUrl(process.env.OPERATIONAL_ALERTS_WEBHOOK_URL, true)) {
    throw new Error("Operational alerts require a valid HTTPS OPERATIONAL_ALERTS_WEBHOOK_URL in production.");
  }
  if (!process.env.OPERATIONAL_ALERTS_TOKEN || process.env.OPERATIONAL_ALERTS_TOKEN.length < 16) {
    throw new Error("Operational alerts require OPERATIONAL_ALERTS_TOKEN with at least 16 characters.");
  }
}

export async function dispatchOperationalAlert(input: OperationalAlertInput): Promise<OperationalAlertResult> {
  if (process.env.OPERATIONAL_ALERTS_ENABLED !== "true" || process.env.OPERATIONAL_ALERTS_PROVIDER !== "webhook") {
    return { status: "disabled" };
  }
  const url = validateWebhookUrl(process.env.OPERATIONAL_ALERTS_WEBHOOK_URL, isProductionEnvironment());
  const token = process.env.OPERATIONAL_ALERTS_TOKEN;
  if (!url || !token || token.length < 16) {
    logger.error("operational_alert_delivery_failed", { alertType: input.type, dedupKey: input.dedupKey, reason: "invalid_configuration" });
    return { status: "failed", reason: "invalid_configuration", attempts: 0 };
  }

  const now = Date.now();
  const previous = recentlyDispatched.get(input.dedupKey);
  if (previous !== undefined && now - previous < configuredCooldownMs()) {
    return { status: "deduplicated" };
  }
  // Reserve before awaiting the transport, so concurrent identical signals
  // cannot both escape. A failed delivery removes the reservation for retry.
  recentlyDispatched.set(input.dedupKey, now);
  const policy = OPERATIONAL_ALERT_POLICIES[input.type];
  const envelope: AlertEnvelope = {
    ...input,
    ...policy,
    occurredAt: new Date(now).toISOString(),
    service: "agent-engine-easy-api",
    environment: process.env.NODE_ENV ?? "unknown",
  };
  let lastReason = "unknown_failure";
  // This is deliberately only an in-process best-effort retry. There is no
  // durable outbox/migration behind alert delivery; callers receive the final
  // structured failure and may retry on their own safe boundary.
  for (let attempts = 1; attempts <= 3; attempts++) {
    try {
      const responseStatus = await transport(url, token, envelope);
      if (responseStatus >= 200 && responseStatus < 300) {
        logger.info("operational_alert_delivered", { alertType: input.type, severity: policy.severity, owner: policy.owner, dedupKey: input.dedupKey, responseStatus, attempts });
        return { status: "delivered", responseStatus };
      }
      lastReason = `response_status_${responseStatus}`;
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
    }
    if (attempts < 3) await new Promise<void>((resolve) => setTimeout(resolve, attempts * 100));
  }
  recentlyDispatched.delete(input.dedupKey);
  logger.error("operational_alert_delivery_failed", { alertType: input.type, dedupKey: input.dedupKey, reason: lastReason, attempts: 3, retryable: true });
  return { status: "failed", reason: lastReason, attempts: 3 };
}

/** Backup jobs call this boundary; the API does not own or fabricate a backup scheduler. */
export function reportBackupFailure(input: { job: string; failureId: string; details?: Record<string, unknown> }): Promise<OperationalAlertResult> {
  return dispatchOperationalAlert({
    type: "BACKUP_FAILURE",
    summary: `Backup job failed: ${input.job}`,
    dedupKey: `backup:${input.job}:${input.failureId}`,
    details: input.details,
  });
}

/**
 * Safe test mechanism: no HTTP route and no caller-controlled payload. It is
 * available only after an operator explicitly enables test alerts.
 */
export function dispatchTestOperationalAlert(): Promise<OperationalAlertResult> {
  if (process.env.OPERATIONAL_ALERTS_ALLOW_TEST !== "true") return Promise.resolve({ status: "disabled" });
  return dispatchOperationalAlert({ type: "TEST", summary: "Operational alert delivery test", dedupKey: "operational-alert:test" });
}

export function __setOperationalAlertTransportForTesting(value: AlertTransport): void {
  transport = value;
}

export function __resetOperationalAlertsForTesting(): void {
  recentlyDispatched.clear();
}