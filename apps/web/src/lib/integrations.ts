// Agent Engine 2.0 — AE Step 5 remediation — Integration administration UI
// (Settings → Integrations).
//
// Types + fetchers + display helpers for the six required admin views
// (overview, connection detail, activity, dead-letter/recovery,
// reconciliation, connection controls — the last two live inside the
// Connections tab alongside connection detail, the same "one card renders
// detail + every available action" convention lib/pitCrew.ts's PcItemCard
// already established, rather than a separate detail screen that could
// drift out of sync). No shared package with the backend (mirrors every
// other lib/*.ts file's own header comment on this) — these types are
// hand-mirrored from packages/db/src/schema/integrations.ts and
// apps/api/src/lib/integrations/adminViews.ts and kept in sync by hand.
//
// Section 10's hard requirement — "never imply a catalogue entry is
// connected" — is the organizing rule for this whole file: every catalogue
// row the API returns with connectionId === null renders as a distinct
// "Not Connected" state, never reusing any real lifecycle status's pill.

import { apiFetch } from "./api";

// ---------------------------------------------------------------------
// Provider catalogue.
// ---------------------------------------------------------------------

export interface IntegrationProvider {
  id: string;
  category: string;
  displayName: string;
  description: string;
  capabilities: string[];
  environmentClassification: string;
  isBuiltIn: boolean;
  active: boolean;
}

// ---------------------------------------------------------------------
// Connection lifecycle — mirrors INTEGRATION_CONNECTION_STATUSES exactly
// (packages/db/src/schema/integrations.ts).
// ---------------------------------------------------------------------

export type IntegrationConnectionStatus =
  | "DRAFT"
  | "PENDING_APPROVAL"
  | "REJECTED"
  | "APPROVED"
  | "CONFIGURING"
  | "VALIDATING"
  | "VALIDATION_FAILED"
  | "ACTIVE"
  | "SUSPENDED"
  | "REVOKED"
  | "EXPIRED";

export interface IntegrationConnection {
  id: string;
  brokerageId: number;
  providerId: string;
  displayName: string;
  status: IntegrationConnectionStatus;
  purpose: string;
  environmentClassification: string;
  requestedScopes: string[];
  approvedScopes: string[];
  requestedBy: number;
  requestedAt: string | null;
  approvedBy: number | null;
  approvedAt: string | null;
  rejectedBy: number | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  authorityUserId: number | null;
  lastValidatedAt: string | null;
  lastValidationResult: { ok: boolean; detail: string; at: string } | null;
  activatedAt: string | null;
  activatedBy: number | null;
  suspendedAt: string | null;
  suspendedBy: number | null;
  suspendReason: string | null;
  revokedAt: string | null;
  revokedBy: number | null;
  revokeReason: string | null;
  expiredAt: string | null;
  healthStatus: string;
  healthCheckedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationConnectionTransition {
  id: string;
  connectionId: string;
  transitionType: string;
  fromValue: string | null;
  toValue: string | null;
  reason: string | null;
  actorType: string;
  actorUserId: number | null;
  occurredAt: string;
}

// ---------------------------------------------------------------------
// Settings.
// ---------------------------------------------------------------------

export interface IntegrationSettings {
  id: number;
  brokerageId: number;
  enabled: boolean;
  maxActiveConnections: number;
}

// ---------------------------------------------------------------------
// 12.1 Overview read model.
// ---------------------------------------------------------------------

export interface IntegrationOverviewRow {
  providerId: string;
  category: string;
  displayName: string;
  environmentClassification: string;
  capabilities: string[];
  connectionId: string | null;
  connectionDisplayName: string | null;
  connectionStatus: IntegrationConnectionStatus | null;
  approvalStatus: "NOT_REQUESTED" | "PENDING" | "REJECTED" | "APPROVED" | null;
  health: string | null;
  lastSuccessfulActivityAt: string | null;
  outstandingFailures: number;
  deadLetterCount: number;
  reconciliationStatus: "NOT_APPLICABLE" | "OK" | "VARIANCE_PRESENT";
}

// ---------------------------------------------------------------------
// 12.3 Activity read model.
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
}

// ---------------------------------------------------------------------
// Dead letters.
// ---------------------------------------------------------------------

export interface IntegrationDeadLetter {
  id: string;
  brokerageId: number;
  connectionId: string;
  sourceType: "OUTBOX" | "INBOX";
  sourceId: string;
  reason: string;
  occurredAt: string;
  replayedAt: string | null;
  replayedBy: number | null;
  replayResult: "SUCCESS" | "FAILED" | null;
  replayError: string | null;
}

// ---------------------------------------------------------------------
// 12.5 Reconciliation snapshot.
// ---------------------------------------------------------------------

export interface ReconciliationSnapshot {
  computedAt: string;
  scope: string;
  aeRecordCount: number;
  providerRecordCount: number;
  matchedCount: number;
  missingCount: number;
  fieldMismatchCount: number;
  unresolvedMappingCount: number;
}

// ---------------------------------------------------------------------
// Fetchers.
// ---------------------------------------------------------------------

export const fetchIntegrationSettings = () => apiFetch<{ settings: IntegrationSettings }>("/integrations/settings").then((r) => r.settings);

export const updateIntegrationSettingsCall = (patch: { enabled?: boolean; maxActiveConnections?: number }) =>
  apiFetch<{ settings: IntegrationSettings }>("/integrations/settings", { method: "PUT", body: JSON.stringify(patch) }).then((r) => r.settings);

export const fetchIntegrationProviders = () => apiFetch<{ providers: IntegrationProvider[] }>("/integrations/providers").then((r) => r.providers);

export const fetchIntegrationOverview = () => apiFetch<{ overview: IntegrationOverviewRow[] }>("/integrations/overview").then((r) => r.overview);

function activityQueryString(filter: IntegrationActivityFilter): string {
  const params = new URLSearchParams();
  if (filter.connectionId) params.set("connectionId", filter.connectionId);
  if (filter.direction) params.set("direction", filter.direction);
  if (filter.status) params.set("status", filter.status);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const fetchIntegrationActivity = (filter: IntegrationActivityFilter = {}) =>
  apiFetch<{ activity: IntegrationActivityRow[] }>(`/integrations/activity${activityQueryString(filter)}`).then((r) => r.activity);

export const fetchReconciliationSnapshot = () => apiFetch<{ snapshot: ReconciliationSnapshot }>("/integrations/reconciliation").then((r) => r.snapshot);

export const fetchIntegrationConnections = () => apiFetch<{ connections: IntegrationConnection[] }>("/integrations/connections").then((r) => r.connections);

export const fetchIntegrationConnectionDetail = (id: string) =>
  apiFetch<{ connection: IntegrationConnection; transitions: IntegrationConnectionTransition[] }>(`/integrations/connections/${id}`);

export const createIntegrationConnection = (input: { providerId: string; displayName: string; purpose: string; requestedScopes: string[] }) =>
  apiFetch<{ connection: IntegrationConnection }>("/integrations/connections", { method: "POST", body: JSON.stringify(input) }).then((r) => r.connection);

export const requestConnectionApproval = (args: { id: string; expectedVersion: number }) =>
  apiFetch<{ connection: IntegrationConnection }>(`/integrations/connections/${args.id}/request-approval`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion: args.expectedVersion }),
  }).then((r) => r.connection);

export const decideConnectionApproval = (args: {
  id: string;
  expectedVersion: number;
  decision: "APPROVED" | "REJECTED";
  approvedScopes?: string[] | null;
  reason?: string | null;
}) =>
  apiFetch<{ connection: IntegrationConnection }>(`/integrations/connections/${args.id}/decide-approval`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion: args.expectedVersion, decision: args.decision, approvedScopes: args.approvedScopes ?? null, reason: args.reason ?? null }),
  }).then((r) => r.connection);

export const mintConnectionCredential = (args: { id: string }) =>
  apiFetch<{ credential: { id: string; referenceType: string; status: string; createdAt: string } }>(`/integrations/connections/${args.id}/mint-credential`, { method: "POST" }).then(
    (r) => r.credential,
  );

export const configureConnection = (args: { id: string; expectedVersion: number }) =>
  apiFetch<{ connection: IntegrationConnection }>(`/integrations/connections/${args.id}/configure`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion: args.expectedVersion }),
  }).then((r) => r.connection);

export const validateConnectionCall = (args: { id: string; expectedVersion: number }) =>
  apiFetch<{ connection: IntegrationConnection }>(`/integrations/connections/${args.id}/validate`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion: args.expectedVersion }),
  }).then((r) => r.connection);

export const suspendConnectionCall = (args: { id: string; expectedVersion: number; reason: string }) =>
  apiFetch<{ connection: IntegrationConnection }>(`/integrations/connections/${args.id}/suspend`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion: args.expectedVersion, reason: args.reason }),
  }).then((r) => r.connection);

export const resumeConnectionCall = (args: { id: string; expectedVersion: number }) =>
  apiFetch<{ connection: IntegrationConnection }>(`/integrations/connections/${args.id}/resume`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion: args.expectedVersion }),
  }).then((r) => r.connection);

export const revokeConnectionCall = (args: { id: string; expectedVersion: number; reason: string }) =>
  apiFetch<{ connection: IntegrationConnection }>(`/integrations/connections/${args.id}/revoke`, {
    method: "POST",
    body: JSON.stringify({ expectedVersion: args.expectedVersion, reason: args.reason }),
  }).then((r) => r.connection);

export const fetchDeadLetters = () => apiFetch<{ deadLetters: IntegrationDeadLetter[] }>("/integrations/dead-letters").then((r) => r.deadLetters);

export const replayDeadLetter = (args: { id: string }) =>
  apiFetch<{ replayed: boolean; sourceType: string; outboxStatus?: string; detail?: string | null }>(`/integrations/dead-letters/${args.id}/replay`, { method: "POST" });

// ---------------------------------------------------------------------
// Display helpers — the established convention (lib/financial.ts,
// lib/riskExceptions.ts): only pill/pill-success/pill-warning/pill-danger
// exist, so distinct states are told apart primarily by label text, never
// by inventing a new colour. "Not Connected" is deliberately its own state,
// visually and textually distinct from every real connection status —
// never rendered with the same tone+text combination any real status uses.
// ---------------------------------------------------------------------

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

export function connectionStatusLabel(status: IntegrationConnectionStatus): string {
  switch (status) {
    case "PENDING_APPROVAL":
      return "Pending Approval";
    case "VALIDATION_FAILED":
      return "Validation Failed";
    default:
      return titleCase(status);
  }
}

export function connectionStatusPillClass(status: IntegrationConnectionStatus): string {
  switch (status) {
    case "ACTIVE":
      return "pill pill-success";
    case "PENDING_APPROVAL":
    case "VALIDATING":
    case "SUSPENDED":
      return "pill pill-warning";
    case "REJECTED":
    case "VALIDATION_FAILED":
    case "REVOKED":
    case "EXPIRED":
      return "pill pill-danger";
    default:
      return "pill"; // DRAFT / APPROVED / CONFIGURING — in progress, neither a success nor a problem yet
  }
}

/** The "not connected" pseudo-state (adminViews.ts: connectionId === null) — deliberately never reuses a real status's label or tone. */
export const NOT_CONNECTED_LABEL = "Not Connected";
export const NOT_CONNECTED_PILL_CLASS = "pill";

export function healthStatusLabel(health: string): string {
  return titleCase(health);
}

export function healthStatusPillClass(health: string): string {
  switch (health) {
    case "HEALTHY":
      return "pill pill-success";
    case "DEGRADED":
      return "pill pill-warning";
    case "UNHEALTHY":
      return "pill pill-danger";
    default:
      return "pill"; // UNKNOWN
  }
}

export function approvalStatusLabel(status: string): string {
  switch (status) {
    case "NOT_REQUESTED":
      return "Not Requested";
    default:
      return titleCase(status);
  }
}

export function approvalStatusPillClass(status: string): string {
  switch (status) {
    case "APPROVED":
      return "pill pill-success";
    case "PENDING":
      return "pill pill-warning";
    case "REJECTED":
      return "pill pill-danger";
    default:
      return "pill"; // NOT_REQUESTED
  }
}

// Outbox statuses (INTEGRATION_OUTBOX_STATUSES) — the outbound half of the
// activity feed.
export function outboxStatusLabel(status: string): string {
  switch (status) {
    case "RETRY_SCHEDULED":
      return "Retry Scheduled";
    case "DEAD_LETTERED":
      return "Dead-Lettered";
    case "MANUAL_REVIEW":
      return "Needs review";
    default:
      return titleCase(status);
  }
}

export function outboxStatusPillClass(status: string): string {
  switch (status) {
    case "SENT":
      return "pill pill-success";
    case "RETRY_SCHEDULED":
    case "DISPATCHING":
    case "PENDING":
      return "pill pill-warning";
    case "FAILED":
    case "DEAD_LETTERED":
    case "MANUAL_REVIEW":
      return "pill pill-danger";
    default:
      return "pill"; // CANCELLED
  }
}

// Inbound processing statuses — the inbound half of the activity feed.
export function inboundStatusLabel(status: string): string {
  return titleCase(status);
}

export function inboundStatusPillClass(status: string): string {
  switch (status) {
    case "PROCESSED":
      return "pill pill-success";
    case "PENDING":
      return "pill pill-warning";
    case "REJECTED":
    case "FAILED":
      return "pill pill-danger";
    default:
      return "pill"; // DUPLICATE — a correctly-caught duplicate, not itself a problem
  }
}

export function activityStatusLabel(row: Pick<IntegrationActivityRow, "direction" | "status">): string {
  return row.direction === "OUTBOUND" ? outboxStatusLabel(row.status) : inboundStatusLabel(row.status);
}

export function activityStatusPillClass(row: Pick<IntegrationActivityRow, "direction" | "status">): string {
  return row.direction === "OUTBOUND" ? outboxStatusPillClass(row.status) : inboundStatusPillClass(row.status);
}

export function reconciliationStatusLabel(status: string): string {
  switch (status) {
    case "NOT_APPLICABLE":
      return "Not Applicable";
    case "VARIANCE_PRESENT":
      return "Variance Present";
    default:
      return titleCase(status);
  }
}

export function reconciliationStatusPillClass(status: string): string {
  switch (status) {
    case "OK":
      return "pill pill-success";
    case "VARIANCE_PRESENT":
      return "pill pill-danger";
    default:
      return "pill"; // NOT_APPLICABLE
  }
}

export function categoryLabel(category: string): string {
  return titleCase(category);
}

export function capabilityLabel(capability: string): string {
  // Capability verbs are dotted (e.g. "portal.publishListing") — split on
  // the dot and title-case each half so they read as words, not raw code.
  return capability
    .split(".")
    .map((part) => part.replace(/([a-z])([A-Z])/g, "$1 $2"))
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" — ");
}
