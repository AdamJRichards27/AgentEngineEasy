import { logger } from "@aee/events";
import { isProductionEnvironment } from "./env.js";
import { outboundBlocked, RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED } from "./outboundGuard.js";
import type { RestoredEnvironmentReason } from "./restoredEnvironment.js";

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
  // AE GROW Signal Sweep operability. logger.error is never bridged to this
  // module — lib/logger.ts only writes JSON to stderr — so these types are
  // the only way a sweep failure pages.
  //
  // H-1: GROW_SIGNAL_SWEEP_UNHEALTHY. Exactly two call sites: the suspected
  // lock leak in lib/propertyIntelligence/sweep.ts and the scheduled-run
  // catch in lib/propertyIntelligence/sweepBootstrap.ts. Those mean the sweep
  // as a whole is not running.
  //
  // H-4: GROW_SIGNAL_SWEEP_BROKERAGE_FAILED and
  // GROW_SIGNAL_SWEEP_CURSOR_TOUCH_FAILED, both raised from considerBrokerage
  // in sweep.ts. A single brokerage's pass used to stop at
  // property_signal_sweep_brokerage_failure_total, so a tenant that fails on
  // every scheduled pass — and a cursor-touch failure that pins that tenant
  // at the front of the durable ordering — never paged. Same policy shape as
  // H-1 (severity high, owner operations, runbook grow-signal-sweep), own
  // types so an operator can tell "one tenant failed" from "the sweep is dead".
  | "GROW_SIGNAL_SWEEP_UNHEALTHY"
  | "GROW_SIGNAL_SWEEP_BROKERAGE_FAILED"
  | "GROW_SIGNAL_SWEEP_CURSOR_TOUCH_FAILED"
  // R-F6: PIT_CREW_WAITING_ON_SWEEP_UNHEALTHY and
  // PIT_CREW_WAITING_ON_SWEEP_BROKERAGE_FAILED. Both call sites are in
  // lib/pitCrew/waitingOnSweepBootstrap.ts's runScheduledWaitingOnSweep:
  // the unhealthy branch (a tick that threw, or a tick where every
  // considered brokerage failed) and the brokerage-failure branch (a
  // completed tick that still had some brokerage failures). Each fires only
  // after 3 consecutive ticks of that kind. These alerts fire on sweep
  // health only, never for an overdue item.
  | "PIT_CREW_WAITING_ON_SWEEP_UNHEALTHY"
  | "PIT_CREW_WAITING_ON_SWEEP_BROKERAGE_FAILED"
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
  GROW_SIGNAL_SWEEP_UNHEALTHY: { severity: "high", owner: "operations", runbook: "grow-signal-sweep" },
  GROW_SIGNAL_SWEEP_BROKERAGE_FAILED: { severity: "high", owner: "operations", runbook: "grow-signal-sweep" },
  GROW_SIGNAL_SWEEP_CURSOR_TOUCH_FAILED: { severity: "high", owner: "operations", runbook: "grow-signal-sweep" },
  PIT_CREW_WAITING_ON_SWEEP_UNHEALTHY: { severity: "high", owner: "operations", runbook: "pit-crew-waiting-on-sweep" },
  PIT_CREW_WAITING_ON_SWEEP_BROKERAGE_FAILED: { severity: "high", owner: "operations", runbook: "pit-crew-waiting-on-sweep" },
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
  | { status: "failed"; reason: string; attempts: number }
  // WS4-09: restored environment — nothing sent. A result, not a throw: most callers are fire-and-forget.
  | { status: "blocked"; code: typeof RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED; reason: RestoredEnvironmentReason };

interface AlertEnvelope extends OperationalAlertInput, AlertPolicy {
  occurredAt: string;
  service: string;
  environment: string;
}

type AlertTransport = (url: string, token: string, envelope: AlertEnvelope) => Promise<number>;

const recentlyDispatched = new Map<string, number>();
let transport: AlertTransport = async (url, token, envelope) => {
  // WS4-09: AEE_RESTORED_ENVIRONMENT refuses this outbound seam (lib/outboundGuard.ts).
  if (outboundBlocked("operational_alerts")) throw new Error(RESTORED_ENVIRONMENT_OUTBOUND_BLOCKED);
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
  // WS4-09: AEE_RESTORED_ENVIRONMENT refuses this outbound seam (lib/outboundGuard.ts).
  const blocked = outboundBlocked("operational_alerts");
  if (blocked) return { status: "blocked", code: blocked.code, reason: blocked.reason };
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