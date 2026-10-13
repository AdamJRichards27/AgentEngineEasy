// Agent Engine 2.0 — Exception & Risk Engine (Priority 4), frontend §16-18.
//
// Shared types + display helpers for the two exception UI surfaces
// (the property-level panel in PropertyWorkspace.tsx and the
// cross-property view in pages/Exceptions.tsx), so both read the same
// severity/status vocabulary from one place rather than re-deriving it.
// Mirrors apps/api/src/lib/exceptions/types.ts's own enum re-export
// convention, and packages/db/src/schema/exceptions.ts's actual enum
// values (RISK_EXCEPTION_SEVERITIES / _STATUSES / _CATEGORIES /
// _OWNER_TYPES) — kept in sync with those by hand, since the frontend
// doesn't share a package with the backend.

export const BLOCKS_CLOSE_LABEL = "Blocks close";

/**
 * Read-only label. True only for an exception the server marked, or for a
 * row with no source type that carries the same flag. Launch items never
 * qualify, even if a flag is copied onto them.
 */
export function showBlocksClosePill(item: { sourceType?: string; blocksClose?: boolean | null }): boolean {
  if (item.sourceType != null && item.sourceType !== "EXCEPTION") return false;
  return item.blocksClose === true;
}

export interface RiskExceptionRow {
  id: string;
  brokerageId: number;
  propertyId: number;
  transactionId: number | null;
  ruleId: string;
  ruleVersion: number;
  category: string;
  severity: string;
  title: string;
  problemDescription: string;
  businessImpact: string;
  detectedCause: string;
  ownerType: string;
  ownerUserId: number | null;
  reassignmentCount: number;
  detectedAt: string;
  dueAt: string | null;
  escalatesAt: string | null;
  status: string;
  recommendedAction: string;
  resolutionRequirements: string;
  dismissible: boolean;
  resolvedAt: string | null;
  resolvedByUserId: number | null;
  resolutionMethod: string | null;
  dismissalReason: string | null;
  occurrenceCount: number;
  lastDetectedAt: string;
  requiresFinancialEntitlement: boolean;
  redacted: boolean;
  /** Set on the cross-property list. Absent means this row was not checked. */
  blocksClose?: boolean;
}

export interface CrossPropertyRiskExceptionRow extends RiskExceptionRow {
  propertyAddress: string | null;
  ownerName: string | null;
}

export interface PropertyExceptionsSummary {
  openCount: number;
  highestSeverity: string | null;
  byStatus: Record<string, number>;
}

export interface PropertyExceptionsResponse {
  exceptions: RiskExceptionRow[];
  summary: PropertyExceptionsSummary;
}

export interface CrossPropertyExceptionsResponse {
  exceptions: CrossPropertyRiskExceptionRow[];
  total: number;
  limit: number;
  offset: number;
}

// Statuses that count as "still open" for filtering/summary purposes —
// mirrors apps/api/src/lib/exceptions/queries.ts's own open-status list
// exactly (OPEN_RISK_EXCEPTION_STATUSES in @aee/db).
export const OPEN_EXCEPTION_STATUSES = ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_EXTERNAL", "REOPENED"];

export const EXCEPTION_OWNER_TYPES = [
  "LISTING_AGENT",
  "TRANSACTION_OWNER",
  "BROKERAGE_ADMINISTRATOR",
  "PIT_CREW",
  "UNASSIGNED_QUEUE",
] as const;

export function severityLabel(severity: string): string {
  switch (severity) {
    case "CRITICAL":
      return "Critical";
    case "AT_RISK":
      return "At Risk";
    case "ATTENTION":
      return "Attention";
    case "INFORMATION":
      return "Information";
    default:
      return severity;
  }
}

// Only three status tones exist in this app's design system (pill /
// pill-warning / pill-danger — see styles.css). Critical and At Risk both
// read as pill-danger, same as how AML risk levels and attention items
// already share these three tones across unrelated features; they're
// told apart by the label text, not by inventing a fourth colour.
export function severityPillClass(severity: string): string {
  if (severity === "CRITICAL" || severity === "AT_RISK") return "pill pill-danger";
  if (severity === "ATTENTION") return "pill pill-warning";
  return "pill";
}

export function statusLabel(status: string): string {
  switch (status) {
    case "OPEN":
      return "Open";
    case "ACKNOWLEDGED":
      return "Acknowledged";
    case "IN_PROGRESS":
      return "In Remediation";
    case "AWAITING_EXTERNAL":
      return "Awaiting External";
    case "RESOLVED":
      return "Resolved";
    case "DISMISSED":
      return "Dismissed";
    case "REOPENED":
      return "Reopened";
    default:
      return status;
  }
}

export function categoryLabel(category: string): string {
  return category
    .toLowerCase()
    .split("_")
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

export function ownerTypeLabel(ownerType: string): string {
  switch (ownerType) {
    case "LISTING_AGENT":
      return "Listing Agent";
    case "TRANSACTION_OWNER":
      return "Transaction Owner";
    case "BROKERAGE_ADMINISTRATOR":
      return "Brokerage Administrator";
    case "PIT_CREW":
      return "Pit Crew";
    case "UNASSIGNED_QUEUE":
      return "Unassigned";
    default:
      return ownerType;
  }
}

export function formatDueDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function isOverdue(dueAt: string | null): boolean {
  if (!dueAt) return false;
  return new Date(dueAt).getTime() < Date.now();
}
