// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
//
// Read model over risk_exceptions — the property-level exception panel
// (§17) and the cross-property operational view (§18). Both routes go
// through here rather than querying the table directly, so financial
// redaction (Build Instructions §20/§21) and tenant scoping are enforced
// in exactly one place, mirroring timeline.ts's own precedent.

import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { db, riskExceptions, riskExceptionTransitions, users, type RiskException } from "@aee/db";
import { assertPropertyInBrokerage } from "./model.js";

export interface RedactedRiskException extends Omit<RiskException, "resolutionEvidence" | "metadata"> {
  resolutionEvidence: unknown;
  metadata: unknown;
  redacted: boolean;
}

// Financial/commission exceptions are hidden entirely from a non-entitled
// viewer, not merely relabelled — unlike the Timeline's redactedLabel()
// approach (a figure swapped for a placeholder), because an exception's
// title/problemDescription/recommendedAction can themselves reference a
// commission or funds figure in free text; the safest boundary is not
// returning the row at all to a viewer without financial visibility
// (Build Instructions §20: "must stay hidden unless ... evidence is
// authoritative" — the safest reading of "hidden" for free-text fields).
// There is no substitute title string in this read.
function hidesFromNonFinancialViewer(
  row: { requiresFinancialEntitlement: boolean },
  canViewFinancials: boolean,
): boolean {
  return row.requiresFinancialEntitlement && !canViewFinancials;
}

/**
 * Title `listBrokerageExceptions` contributes for this row.
 * When `canViewFinancials` is false and the row requires financial
 * entitlement, `redact()` drops the row, so this returns null. It does
 * not invent a placeholder. Callers that still list another record (the
 * Pit Crew responsibility inbox) copy this result instead of the raw title.
 */
export function listedExceptionTitle(
  row: { title: string; requiresFinancialEntitlement: boolean },
  canViewFinancials: boolean,
): string | null {
  if (hidesFromNonFinancialViewer(row, canViewFinancials)) return null;
  return row.title;
}

function redact(row: RiskException, canViewFinancials: boolean): RedactedRiskException | null {
  if (hidesFromNonFinancialViewer(row, canViewFinancials)) return null;
  return { ...row, redacted: false };
}

export interface PropertyExceptionSummary {
  openCount: number;
  highestSeverity: string | null;
  byStatus: Record<string, number>;
}

export async function getPropertyExceptions(
  propertyId: number,
  brokerageId: number,
  canViewFinancials: boolean,
  filters?: { status?: string[]; severity?: string[]; category?: string[] },
): Promise<{ exceptions: RedactedRiskException[]; summary: PropertyExceptionSummary }> {
  await assertPropertyInBrokerage(propertyId, brokerageId);

  const conditions = [eq(riskExceptions.propertyId, propertyId), eq(riskExceptions.brokerageId, brokerageId)];
  if (filters?.status?.length) conditions.push(inArray(riskExceptions.status, filters.status));
  if (filters?.severity?.length) conditions.push(inArray(riskExceptions.severity, filters.severity));
  if (filters?.category?.length) conditions.push(inArray(riskExceptions.category, filters.category));

  const rows = await db
    .select()
    .from(riskExceptions)
    .where(and(...conditions))
    // Highest severity first (a real rank, not the text column's alphabetical
    // order — "AT_RISK" would otherwise sort ahead of "CRITICAL"), then
    // soonest due date.
    .orderBy(sql`case ${riskExceptions.severity} when 'CRITICAL' then 4 when 'AT_RISK' then 3 when 'ATTENTION' then 2 else 1 end desc`, asc(riskExceptions.dueAt));

  const visible = rows.map((r) => redact(r, canViewFinancials)).filter((r): r is RedactedRiskException => r !== null);

  const severityRank: Record<string, number> = { CRITICAL: 4, AT_RISK: 3, ATTENTION: 2, INFORMATION: 1 };
  const openRows = visible.filter((r) => ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_EXTERNAL", "REOPENED"].includes(r.status));
  const highestSeverity = openRows.reduce<string | null>((acc, r) => {
    if (!acc) return r.severity;
    return (severityRank[r.severity] ?? 0) > (severityRank[acc] ?? 0) ? r.severity : acc;
  }, null);
  const byStatus: Record<string, number> = {};
  for (const r of visible) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  return {
    exceptions: visible,
    summary: { openCount: openRows.length, highestSeverity, byStatus },
  };
}

export interface CrossPropertyExceptionFilters {
  status?: string[];
  severity?: string[];
  category?: string[];
  ownerUserId?: number;
  propertyId?: number;
  overdueOnly?: boolean;
  search?: string;
  limit: number;
  offset: number;
}

export interface CrossPropertyExceptionPage {
  exceptions: Array<RedactedRiskException & { propertyAddress: string | null; ownerName: string | null }>;
  total: number;
  limit: number;
  offset: number;
}

/**
 * Foundation for the future Agent Daily Command Centre / Brokerage
 * Dashboard (Build Instructions §18: "this view is a foundation for those
 * later", explicitly NOT those dashboards themselves). An Agent sees only
 * exceptions on their own properties (propertyId IN their assigned
 * properties, enforced by the caller passing agentPropertyIds); a
 * Brokerage Administrator sees the whole tenant.
 */
export async function listBrokerageExceptions(
  brokerageId: number,
  canViewFinancials: boolean,
  restrictToPropertyIds: number[] | null,
  filters: CrossPropertyExceptionFilters,
): Promise<CrossPropertyExceptionPage> {
  const conditions = [eq(riskExceptions.brokerageId, brokerageId)];
  if (restrictToPropertyIds) {
    if (restrictToPropertyIds.length === 0) {
      return { exceptions: [], total: 0, limit: filters.limit, offset: filters.offset };
    }
    conditions.push(inArray(riskExceptions.propertyId, restrictToPropertyIds));
  }
  if (filters.status?.length) conditions.push(inArray(riskExceptions.status, filters.status));
  if (filters.severity?.length) conditions.push(inArray(riskExceptions.severity, filters.severity));
  if (filters.category?.length) conditions.push(inArray(riskExceptions.category, filters.category));
  if (filters.ownerUserId !== undefined) conditions.push(eq(riskExceptions.ownerUserId, filters.ownerUserId));
  if (filters.propertyId !== undefined) conditions.push(eq(riskExceptions.propertyId, filters.propertyId));
  if (filters.overdueOnly) conditions.push(lte(riskExceptions.dueAt, new Date()));
  if (filters.search) {
    conditions.push(sql`(${riskExceptions.title} ilike ${"%" + filters.search + "%"} or ${riskExceptions.problemDescription} ilike ${"%" + filters.search + "%"})`);
  }

  const whereClause = and(...conditions);

  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(riskExceptions).where(whereClause);

  const rows = await db
    .select()
    .from(riskExceptions)
    .where(whereClause)
    // Stable pagination (Build Instructions §18/§23): severity desc, then a
    // strictly-increasing tiebreaker (id) rather than createdAt alone,
    // which is not guaranteed unique to the microsecond under concurrent
    // inserts and would otherwise let a page boundary skip or repeat a row.
    .orderBy(sql`case ${riskExceptions.severity} when 'CRITICAL' then 4 when 'AT_RISK' then 3 when 'ATTENTION' then 2 else 1 end desc`, asc(riskExceptions.id))
    .limit(filters.limit)
    .offset(filters.offset);

  if (rows.length === 0) {
    return { exceptions: [], total: count, limit: filters.limit, offset: filters.offset };
  }

  const { properties } = await import("@aee/db");
  const propertyIds = [...new Set(rows.map((r) => r.propertyId))];
  const ownerIds = [...new Set(rows.map((r) => r.ownerUserId).filter((id): id is number => id != null))];
  const [propertyRows, ownerRows] = await Promise.all([
    propertyIds.length ? db.select().from(properties).where(inArray(properties.id, propertyIds)) : Promise.resolve([]),
    ownerIds.length ? db.select().from(users).where(inArray(users.id, ownerIds)) : Promise.resolve([]),
  ]);

  const exceptions = rows
    .map((r) => {
      const visible = redact(r, canViewFinancials);
      if (!visible) return null;
      const property = propertyRows.find((p) => p.id === r.propertyId);
      const owner = ownerRows.find((u) => u.id === r.ownerUserId);
      return {
        ...visible,
        propertyAddress: property?.formattedAddress ?? null,
        ownerName: owner ? `${owner.firstName} ${owner.lastName}`.trim() : null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return { exceptions, total: count, limit: filters.limit, offset: filters.offset };
}

export async function getExceptionDetail(
  exceptionId: string,
  brokerageId: number,
  canViewFinancials: boolean,
): Promise<{ exception: RedactedRiskException; history: (typeof riskExceptionTransitions.$inferSelect)[] } | null> {
  const [row] = await db.select().from(riskExceptions).where(and(eq(riskExceptions.id, exceptionId), eq(riskExceptions.brokerageId, brokerageId)));
  if (!row) return null;
  const visible = redact(row, canViewFinancials);
  if (!visible) return null;
  const history = await db
    .select()
    .from(riskExceptionTransitions)
    .where(eq(riskExceptionTransitions.exceptionId, exceptionId))
    .orderBy(asc(riskExceptionTransitions.occurredAt));
  return { exception: visible, history };
}
