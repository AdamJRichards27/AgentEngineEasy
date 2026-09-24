
// Agent Engine 2.0 -- Agent Daily Command Centre (Priority 6). Read model.
//
// Composes existing AE systems into the unified ActionItem shape (Build
// Instructions Section 8). Nothing here writes anything -- it is a pure
// projection, re-evaluated on every read from the same tables every other
// screen reads from (Section 4: "not a new source of truth").
//
// The Exception & Risk Engine is authoritative for anything it already
// covers (Section 16): every WORKFLOW_OPERATIONAL rule (G36-G39) already
// turns a stuck automation task into a risk_exception, and the Launch risk
// rules already turn a blocked/overdue campaign item, failed portal or
// overdue vendor approval into one too. So this module lists open exceptions
// first, records which source records they already cover (via each
// exception's `metadata`), and skips creating a second, non-exception item
// for anything already covered -- see `coveredSourceIds` below and Build
// Instructions Section 9 (deduplication).

import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  properties,
  campaignItems,
  launchPlans,
  vendorApprovals,
  automationTasks,
  workflowSteps,
  workflows,
  transactions,
  transactionConditions,
  offers,
  type Property,
} from "@aee/db";
import { listBrokerageExceptions, type RedactedRiskException } from "../exceptions/queries.js";
import {
  resolveTimeZone,
  startOfLocalDay,
  startOfNextLocalDay,
  isOverdueLocal,
  isSameLocalDay,
  isWithinHorizon,
} from "./timezone.js";
import type {
  ActionItem,
  ActivePropertySummary,
  CommandCentreResponse,
  CommandCentreSummary,
  CommandCentreSection,
  PriorityTier,
} from "./types.js";

const COMING_UP_HORIZON_DAYS = 7;
const MAX_ITEMS_PER_SECTION = 50;

/**
 * I-14. drizzle's `inArray` is one bind parameter per id. Reusing every
 * property id in the brokerage as that list, once per fan-out query, is
 * unbounded. 500 stays far under Postgres's 65535-parameter limit. A scope
 * at or under this size is one statement per table — the same shape a
 * normal brokerage already had — except `automation_tasks`, which is one
 * read for both ACTIVE and COMPLETED instead of two.
 */
export const COMMAND_CENTRE_ID_CHUNK = 500;

export function chunkIds<T>(ids: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

/**
 * Production always uses {@link COMMAND_CENTRE_ID_CHUNK}. A test may pass a
 * smaller positive integer so a handful of rows crosses a chunk boundary.
 * The cap cannot be raised, and the override is ignored outside tests.
 */
export function resolveCommandCentreIdChunkSize(requested: number | undefined): number {
  if (process.env.NODE_ENV !== "test" || requested === undefined) return COMMAND_CENTRE_ID_CHUNK;
  if (!Number.isInteger(requested) || requested < 1) return COMMAND_CENTRE_ID_CHUNK;
  return Math.min(requested, COMMAND_CENTRE_ID_CHUNK);
}

async function selectInChunks<T>(
  ids: readonly number[],
  chunkSize: number,
  run: (chunk: number[]) => Promise<T[]>,
): Promise<T[]> {
  if (ids.length === 0) return [];
  const rows: T[] = [];
  for (const chunk of chunkIds(ids, chunkSize)) {
    rows.push(...(await run(chunk)));
  }
  return rows;
}

async function loadCommandCentreProperties(
  brokerageId: number,
  restrictToPropertyIds: number[] | null,
  chunkSize: number,
): Promise<Property[]> {
  if (restrictToPropertyIds === null) {
    return db.select().from(properties).where(eq(properties.brokerageId, brokerageId));
  }
  // Set keeps first-seen order. A repeated id is one bind slot and cannot
  // by itself open another chunk. The rows are still this brokerage's.
  const ids = [...new Set(restrictToPropertyIds)];
  return selectInChunks(ids, chunkSize, (chunk) =>
    db
      .select()
      .from(properties)
      .where(and(eq(properties.brokerageId, brokerageId), inArray(properties.id, chunk))),
  );
}

type ExceptionListFilters = Parameters<typeof listBrokerageExceptions>[3];

function exceptionPageRank(severity: string): number {
  switch (severity) {
    case "CRITICAL":
      return 4;
    case "AT_RISK":
      return 3;
    case "ATTENTION":
      return 2;
    default:
      return 1;
  }
}

/**
 * Administrators pass null and this is one brokerage-scoped read, with no
 * property-id bind list. A restrict list at or under the chunk size is the
 * same single call as before. A longer list is partitioned, and each chunk
 * keeps the page's severity-then-id order so the merged page is the same
 * top slice.
 */
async function listCommandCentreExceptions(
  brokerageId: number,
  canViewFinancials: boolean,
  restrictToPropertyIds: number[] | null,
  filters: ExceptionListFilters,
  chunkSize: number,
): Promise<Awaited<ReturnType<typeof listBrokerageExceptions>>> {
  if (restrictToPropertyIds === null || restrictToPropertyIds.length <= chunkSize) {
    return listBrokerageExceptions(brokerageId, canViewFinancials, restrictToPropertyIds, filters);
  }
  const ids = [...new Set(restrictToPropertyIds)];
  if (ids.length <= chunkSize) {
    return listBrokerageExceptions(brokerageId, canViewFinancials, ids, filters);
  }
  const window = filters.limit + filters.offset;
  const pages = [];
  for (const chunk of chunkIds(ids, chunkSize)) {
    pages.push(
      await listBrokerageExceptions(brokerageId, canViewFinancials, chunk, {
        ...filters,
        limit: window,
        offset: 0,
      }),
    );
  }
  const merged = pages.flatMap((page) => page.exceptions).sort((a, b) => {
    const bySeverity = exceptionPageRank(b.severity) - exceptionPageRank(a.severity);
    if (bySeverity !== 0) return bySeverity;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
  return {
    exceptions: merged.slice(filters.offset, filters.offset + filters.limit),
    total: pages.reduce((sum, page) => sum + page.total, 0),
    limit: filters.limit,
    offset: filters.offset,
  };
}

export interface CommandCentreActor {
  id: number;
  role: string;
  brokerageId: number;
  firstName: string;
}

export interface GetCommandCentreOptions {
  now?: Date;
  canViewFinancials: boolean;
  restrictToPropertyIds: number[] | null; // null = whole brokerage (Brokerage Administrator)
  /**
   * Test-only smaller bind chunk. Ignored outside NODE_ENV=test and cannot
   * exceed COMMAND_CENTRE_ID_CHUNK. The HTTP route does not set this.
   */
  idChunkSize?: number;
}

export async function getCommandCentre(
  actor: CommandCentreActor,
  opts: GetCommandCentreOptions,
): Promise<CommandCentreResponse> {
  const now = opts.now ?? new Date();
  const { timeZone, source: timeZoneSource } = resolveTimeZone(actor);

  if (opts.restrictToPropertyIds !== null && opts.restrictToPropertyIds.length === 0) {
    return emptyResponse(now, timeZone, timeZoneSource, actor);
  }

  const chunkSize = resolveCommandCentreIdChunkSize(opts.idChunkSize);
  const propertyRows = await loadCommandCentreProperties(actor.brokerageId, opts.restrictToPropertyIds, chunkSize);
  if (propertyRows.length === 0) return emptyResponse(now, timeZone, timeZoneSource, actor);

  const propertyIds = propertyRows.map((p) => p.id);
  const propertyById = new Map(propertyRows.map((p) => [p.id, p]));
  const addressOf = (id: number) => propertyById.get(id)?.formattedAddress ?? `Property ${id}`;

  // 1. Exception & Risk Engine -- authoritative (Section 16).
  const exceptionPage = await listCommandCentreExceptions(
    actor.brokerageId,
    opts.canViewFinancials,
    opts.restrictToPropertyIds,
    { status: ["OPEN", "ACKNOWLEDGED", "IN_PROGRESS", "AWAITING_EXTERNAL", "REOPENED"], limit: 200, offset: 0 },
    chunkSize,
  );
  const coveredSourceIds = new Set<string>();
  for (const exc of exceptionPage.exceptions) {
    const metadata = exc.metadata as Record<string, unknown> | null | undefined;
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
      for (const value of Object.values(metadata)) {
        if (typeof value === "number" || typeof value === "string") coveredSourceIds.add(String(value));
      }
    }
  }

  const items: ActionItem[] = exceptionPage.exceptions.map((exc) => exceptionToActionItem(exc, addressOf, now, timeZone));

  // Recently resolved exceptions feed Completed Today -- listBrokerageExceptions
  // above only returned open statuses by design.
  const resolvedPage = await listCommandCentreExceptions(
    actor.brokerageId,
    opts.canViewFinancials,
    opts.restrictToPropertyIds,
    { status: ["RESOLVED"], limit: 100, offset: 0 },
    chunkSize,
  );
  for (const exc of resolvedPage.exceptions) {
    if (exc.resolvedAt && isSameLocalDay(new Date(exc.resolvedAt), now, timeZone)) {
      items.push(exceptionToActionItem(exc, addressOf, now, timeZone));
    }
  }

  // 2. Launch: campaign items, vendor approvals, launch plan target dates.
  // I-14: each property-id (and, below, transaction-id) list is one chunk.
  // Chunks run serially. Under COMMAND_CENTRE_ID_CHUNK this is one statement,
  // identical to the previous single inArray.
  const campaignRows = await selectInChunks(propertyIds, chunkSize, (chunk) =>
    db.select().from(campaignItems).where(inArray(campaignItems.propertyId, chunk)),
  );
  for (const c of campaignRows) {
    if (coveredSourceIds.has(String(c.id))) continue;
    if (c.status === "COMPLETE") {
      if (c.completedAt && isSameLocalDay(c.completedAt, now, timeZone)) {
        items.push(campaignItemToActionItem(c, addressOf, now, timeZone, "completedToday"));
      }
      continue;
    }
    if (!c.dueAt) continue;
    if (isOverdueLocal(c.dueAt, now, timeZone)) {
      items.push(campaignItemToActionItem(c, addressOf, now, timeZone, "overdue"));
    } else if (isSameLocalDay(c.dueAt, now, timeZone)) {
      items.push(campaignItemToActionItem(c, addressOf, now, timeZone, "today"));
    } else if (isWithinHorizon(c.dueAt, now, timeZone, COMING_UP_HORIZON_DAYS)) {
      items.push(campaignItemToActionItem(c, addressOf, now, timeZone, "comingUp"));
    }
  }

  const launchPlanRows = await selectInChunks(propertyIds, chunkSize, (chunk) =>
    db.select().from(launchPlans).where(inArray(launchPlans.propertyId, chunk)),
  );
  for (const plan of launchPlanRows) {
    if (coveredSourceIds.has(String(plan.id))) continue;
    if (plan.targetLaunchDate && !plan.actualLaunchDate) {
      if (isOverdueLocal(plan.targetLaunchDate, now, timeZone)) {
        items.push(launchPlanToActionItem(plan, addressOf, now, timeZone, "overdue"));
      } else if (isSameLocalDay(plan.targetLaunchDate, now, timeZone)) {
        items.push(launchPlanToActionItem(plan, addressOf, now, timeZone, "today"));
      } else if (isWithinHorizon(plan.targetLaunchDate, now, timeZone, COMING_UP_HORIZON_DAYS)) {
        items.push(launchPlanToActionItem(plan, addressOf, now, timeZone, "comingUp"));
      }
    }
    if (plan.actualLaunchDate && isSameLocalDay(plan.actualLaunchDate, now, timeZone)) {
      items.push(launchPlanToActionItem(plan, addressOf, now, timeZone, "completedToday"));
    }
  }

  const vendorApprovalRows = await selectInChunks(propertyIds, chunkSize, (chunk) =>
    db
      .select()
      .from(vendorApprovals)
      .where(and(inArray(vendorApprovals.propertyId, chunk), eq(vendorApprovals.status, "PENDING"))),
  );
  for (const va of vendorApprovalRows) {
    if (coveredSourceIds.has(String(va.id))) continue;
    items.push(vendorApprovalToActionItem(va, addressOf, now, timeZone));
  }

  // 3. Transactions: settlement dates, contract conditions, accepted offers.
  const transactionRows = await selectInChunks(propertyIds, chunkSize, (chunk) =>
    db.select().from(transactions).where(inArray(transactions.propertyId, chunk)),
  );
  const transactionById = new Map(transactionRows.map((t) => [t.id, t]));
  for (const t of transactionRows) {
    if (coveredSourceIds.has(String(t.id))) continue;
    if (t.settlementDate && !t.settlementCompletedAt) {
      if (isOverdueLocal(t.settlementDate, now, timeZone)) {
        items.push(transactionToActionItem(t, addressOf, now, timeZone, "overdue", actor.brokerageId));
      } else if (isSameLocalDay(t.settlementDate, now, timeZone)) {
        items.push(transactionToActionItem(t, addressOf, now, timeZone, "today", actor.brokerageId));
      } else if (isWithinHorizon(t.settlementDate, now, timeZone, COMING_UP_HORIZON_DAYS)) {
        items.push(transactionToActionItem(t, addressOf, now, timeZone, "comingUp", actor.brokerageId));
      }
    }
    if (t.settlementCompletedAt && isSameLocalDay(t.settlementCompletedAt, now, timeZone)) {
      items.push(transactionToActionItem(t, addressOf, now, timeZone, "completedToday", actor.brokerageId));
    }
  }

  if (transactionRows.length > 0) {
    const conditionRows = await selectInChunks(
      transactionRows.map((t) => t.id),
      chunkSize,
      (chunk) => db.select().from(transactionConditions).where(inArray(transactionConditions.transactionId, chunk)),
    );
    for (const cond of conditionRows) {
      if (coveredSourceIds.has(String(cond.id))) continue;
      const txn = transactionById.get(cond.transactionId);
      if (!txn) continue;
      if (cond.status !== "Pending") continue; // Satisfied/Waived/NotApplicable are done; Failed is a CONTRACT_CONDITIONS exception already
      if (!cond.dueDate) continue;
      if (isOverdueLocal(cond.dueDate, now, timeZone)) {
        items.push(conditionToActionItem(cond, txn, addressOf, now, timeZone, "overdue", actor.brokerageId));
      } else if (isSameLocalDay(cond.dueDate, now, timeZone)) {
        items.push(conditionToActionItem(cond, txn, addressOf, now, timeZone, "today", actor.brokerageId));
      } else if (isWithinHorizon(cond.dueDate, now, timeZone, COMING_UP_HORIZON_DAYS)) {
        items.push(conditionToActionItem(cond, txn, addressOf, now, timeZone, "comingUp", actor.brokerageId));
      }
    }
  }

  const offerRows = await selectInChunks(propertyIds, chunkSize, (chunk) =>
    db.select().from(offers).where(inArray(offers.propertyId, chunk)),
  );
  for (const o of offerRows) {
    if (coveredSourceIds.has(String(o.id))) continue;
    if (o.status === "Accepted" && isSameLocalDay(o.createdAt, now, timeZone)) {
      items.push(offerToActionItem(o, addressOf, now, timeZone, actor.brokerageId));
    }
  }

  // 4. Workflow Automation Engine: non-overdue active tasks (overdue ones
  // already became WORKFLOW_OPERATIONAL exceptions via rule G39) and tasks
  // completed today. One read covers both statuses. COMPLETED rows are not
  // dropped by coveredSourceIds; ACTIVE rows still are. SUPERSEDED and
  // CANCELLED stay out of the read.
  const taskRows = await selectInChunks(propertyIds, chunkSize, (chunk) =>
    db
      .select()
      .from(automationTasks)
      .where(
        and(
          inArray(automationTasks.propertyId, chunk),
          inArray(automationTasks.status, ["ACTIVE", "COMPLETED"]),
        ),
      ),
  );
  for (const t of taskRows) {
    if (t.status === "COMPLETED") {
      if (t.completedAt && isSameLocalDay(t.completedAt, now, timeZone)) {
        items.push(automationTaskToActionItem(t, addressOf, now, timeZone, "completedToday"));
      }
      continue;
    }
    if (t.status !== "ACTIVE") continue;
    if (coveredSourceIds.has(String(t.id))) continue;
    if (!t.dueAt) continue;
    if (isOverdueLocal(t.dueAt, now, timeZone)) continue;
    if (isSameLocalDay(t.dueAt, now, timeZone)) {
      items.push(automationTaskToActionItem(t, addressOf, now, timeZone, "today"));
    } else if (isWithinHorizon(t.dueAt, now, timeZone, COMING_UP_HORIZON_DAYS)) {
      items.push(automationTaskToActionItem(t, addressOf, now, timeZone, "comingUp"));
    }
  }

  // 5. Generic ready-to-act workflow steps -- no due date, capped (Section 25).
  // The cap is across the whole load. A single chunk (the normal case) is
  // one statement with limit 50, matching the previous query. Further chunks
  // are read only while the cap still has room.
  const readySteps: Array<{ step: typeof workflowSteps.$inferSelect; workflow: typeof workflows.$inferSelect }> = [];
  for (const chunk of chunkIds(propertyIds, chunkSize)) {
    const remaining = MAX_ITEMS_PER_SECTION - readySteps.length;
    if (remaining <= 0) break;
    const part = await db
      .select({ step: workflowSteps, workflow: workflows })
      .from(workflowSteps)
      .innerJoin(workflows, eq(workflowSteps.workflowId, workflows.id))
      .where(and(inArray(workflows.propertyId, chunk), eq(workflowSteps.status, "Ready")))
      .limit(remaining);
    readySteps.push(...part);
  }
  for (const row of readySteps) {
    items.push(workflowStepToActionItem(row.step, row.workflow, addressOf, now, timeZone, actor.brokerageId));
  }

  // -- Assemble sections (Build Instructions Section 9: one row, never duplicated) --
  const seen = new Set<string>();
  const deduped = items.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));

  for (const item of deduped) item.priority = priorityFor(item);
  deduped.sort(compareItems);

  const nowSection = deduped
    .filter((i) => i.priority === "P0" || i.priority === "P1")
    .slice(0, MAX_ITEMS_PER_SECTION);
  const today = deduped.filter((i) => i.sections.includes("today")).slice(0, MAX_ITEMS_PER_SECTION);
  const overdue = deduped.filter((i) => i.sections.includes("overdue")).slice(0, MAX_ITEMS_PER_SECTION);
  const waitingOn = deduped.filter((i) => i.sections.includes("waitingOn")).slice(0, MAX_ITEMS_PER_SECTION);
  const comingUp = deduped.filter((i) => i.sections.includes("comingUp")).slice(0, MAX_ITEMS_PER_SECTION);
  const completedToday = deduped
    .filter((i) => i.sections.includes("completedToday"))
    .slice(0, MAX_ITEMS_PER_SECTION);
  const pitCrew = deduped
    .filter((i) => i.accountableOwnerType === "PIT_CREW" || i.performingParty === "Pit Crew")
    .slice(0, MAX_ITEMS_PER_SECTION);

  const activeProperties = buildActivePropertySummaries(propertyRows, deduped);

  const summary: CommandCentreSummary = {
    critical: deduped.filter((i) => i.severity === "CRITICAL").length,
    attention: deduped.filter((i) => i.severity === "ATTENTION" || i.severity === "AT_RISK").length,
    dueToday: today.length,
    overdue: overdue.length,
    waitingOn: waitingOn.length,
    comingUp: comingUp.length,
    pcActive: pitCrew.length,
  };

  return {
    generatedAt: now.toISOString(),
    timeZone,
    timeZoneSource,
    agent: { id: actor.id, firstName: actor.firstName, role: actor.role },
    summary,
    now: nowSection,
    today,
    overdue,
    waitingOn,
    comingUp,
    activeProperties,
    pitCrew,
    completedToday,
  };
}

function emptyResponse(
  now: Date,
  timeZone: string,
  timeZoneSource: "user" | "brokerage" | "fallback",
  actor: CommandCentreActor,
): CommandCentreResponse {
  return {
    generatedAt: now.toISOString(),
    timeZone,
    timeZoneSource,
    agent: { id: actor.id, firstName: actor.firstName, role: actor.role },
    summary: { critical: 0, attention: 0, dueToday: 0, overdue: 0, waitingOn: 0, comingUp: 0, pcActive: 0 },
    now: [],
    today: [],
    overdue: [],
    waitingOn: [],
    comingUp: [],
    activeProperties: [],
    pitCrew: [],
    completedToday: [],
  };
}

const OWNER_LABELS: Record<string, string> = {
  LISTING_AGENT: "Agent",
  TRANSACTION_OWNER: "Agent",
  BROKERAGE_ADMINISTRATOR: "Brokerage Administrator",
  PIT_CREW: "Pit Crew",
  UNASSIGNED_QUEUE: "Unassigned",
};
export function ownerLabel(ownerType: string): string {
  return OWNER_LABELS[ownerType] ?? ownerType;
}

// P0-P4, explicit factors only (Build Instructions Section 10) -- never an
// opaque AI/productivity score.
export function priorityFor(item: ActionItem): PriorityTier {
  if (item.sections.includes("completedToday") && item.sections.length === 1) return "P4";
  if (item.severity === "CRITICAL") return "P0";
  if (item.sections.includes("overdue") && item.severity !== null) return "P0";
  if (item.severity === "AT_RISK") return "P1";
  if (item.sections.includes("overdue")) return "P1";
  if (item.sections.includes("waitingOn")) return "P1";
  if (item.sections.includes("today")) return "P2";
  if (item.sections.includes("comingUp")) return "P3";
  return "P4";
}

const PRIORITY_RANK: Record<PriorityTier, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };
const SEVERITY_RANK: Record<string, number> = { CRITICAL: 0, AT_RISK: 1, ATTENTION: 2, INFORMATION: 3 };
export function compareItems(a: ActionItem, b: ActionItem): number {
  if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  const sa = a.severity ? SEVERITY_RANK[a.severity] : 4;
  const sb = b.severity ? SEVERITY_RANK[b.severity] : 4;
  if (sa !== sb) return sa - sb;
  const da = a.dueAt ? new Date(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const dbb = b.dueAt ? new Date(b.dueAt).getTime() : Number.POSITIVE_INFINITY;
  if (da !== dbb) return da - dbb;
  return a.id.localeCompare(b.id);
}

function exceptionToActionItem(
  exc: RedactedRiskException & { propertyAddress: string | null; ownerName: string | null },
  addressOf: (id: number) => string,
  now: Date,
  timeZone: string,
): ActionItem {
  const dueAt = exc.dueAt as Date | null;
  const sections: CommandCentreSection[] = [];
  if (exc.status === "RESOLVED") {
    sections.push("completedToday");
  } else {
    const overdue = isOverdueLocal(dueAt, now, timeZone);
    if (overdue) sections.push("overdue");
    if (exc.status === "AWAITING_EXTERNAL") sections.push("waitingOn");
    if (!overdue && dueAt && isSameLocalDay(dueAt, now, timeZone)) sections.push("today");
    if (sections.length === 0) sections.push("today");
  }
  const detectedAt = exc.detectedAt as Date;
  const lastDetectedAt = exc.lastDetectedAt as Date | undefined;
  const resolvedAt = exc.resolvedAt as Date | null | undefined;
  return {
    id: `EXCEPTION:${exc.id}`,
    sourceType: "EXCEPTION",
    sourceRecordId: String(exc.id),
    propertyId: exc.propertyId,
    propertyAddress: exc.propertyAddress ?? addressOf(exc.propertyId),
    brokerageId: exc.brokerageId,
    agentId: null,
    title: exc.title,
    description: exc.problemDescription,
    category: exc.category,
    severity: exc.severity as ActionItem["severity"],
    status: exc.status,
    accountableOwnerType: exc.ownerType,
    accountableOwnerUserId: exc.ownerUserId,
    performingParty: ownerLabel(exc.ownerType),
    waitingOnParty: exc.status === "AWAITING_EXTERNAL" ? "External party" : null,
    dueAt: dueAt ? dueAt.toISOString() : null,
    timeZone,
    overdue: isOverdueLocal(dueAt, now, timeZone),
    recommendedAction: exc.recommendedAction,
    deepLink: `/properties/${exc.propertyId}`,
    createdAt: detectedAt ? detectedAt.toISOString() : now.toISOString(),
    updatedAt: lastDetectedAt ? lastDetectedAt.toISOString() : now.toISOString(),
    completedAt: resolvedAt ? resolvedAt.toISOString() : null,
    priority: "P4",
    sections,
  };
}

export function sectionsFor(kind: "today" | "overdue" | "comingUp" | "completedToday" | "waitingOn"): CommandCentreSection[] {
  return [kind];
}

function campaignItemToActionItem(
  c: typeof campaignItems.$inferSelect,
  addressOf: (id: number) => string,
  now: Date,
  timeZone: string,
  section: "today" | "overdue" | "comingUp" | "completedToday",
): ActionItem {
  const dueAt = c.dueAt as Date | null;
  return {
    id: `LAUNCH_ITEM:${c.id}`,
    sourceType: "LAUNCH_ITEM",
    sourceRecordId: String(c.id),
    propertyId: c.propertyId,
    propertyAddress: addressOf(c.propertyId),
    brokerageId: c.brokerageId,
    agentId: null,
    title: c.title,
    description: c.description ?? `${c.itemType} campaign item`,
    category: "LAUNCH_CAMPAIGN",
    severity: null,
    status: c.status,
    accountableOwnerType: c.responsibleOwnerType,
    accountableOwnerUserId: c.responsibleUserId,
    performingParty: ownerLabel(c.responsibleOwnerType),
    waitingOnParty: null,
    dueAt: dueAt ? dueAt.toISOString() : null,
    timeZone,
    overdue: section === "overdue",
    recommendedAction: `Complete "${c.title}" or update its status in Launch.`,
    deepLink: `/properties/${c.propertyId}`,
    createdAt: c.createdAt ? (c.createdAt as Date).toISOString() : now.toISOString(),
    updatedAt: c.updatedAt ? (c.updatedAt as Date).toISOString() : now.toISOString(),
    completedAt: c.completedAt ? (c.completedAt as Date).toISOString() : null,
    priority: "P4",
    sections: sectionsFor(section),
  };
}

function launchPlanToActionItem(
  plan: typeof launchPlans.$inferSelect,
  addressOf: (id: number) => string,
  now: Date,
  timeZone: string,
  section: "today" | "overdue" | "comingUp" | "completedToday",
): ActionItem {
  const dueAt = (section === "completedToday" ? plan.actualLaunchDate : plan.targetLaunchDate) as Date | null;
  const title = section === "completedToday" ? "Listing confirmed live" : "Target launch date";
  return {
    id: `PROPERTY_MILESTONE:launch-plan:${plan.id}`,
    sourceType: "PROPERTY_MILESTONE",
    sourceRecordId: String(plan.id),
    propertyId: plan.propertyId,
    propertyAddress: addressOf(plan.propertyId),
    brokerageId: plan.brokerageId,
    agentId: null,
    title,
    description: section === "completedToday" ? "The listing went live today." : "This property's target launch date.",
    category: "LAUNCH_CAMPAIGN",
    severity: null,
    status: plan.status,
    accountableOwnerType: "LISTING_AGENT",
    accountableOwnerUserId: null,
    performingParty: "Agent",
    waitingOnParty: null,
    dueAt: dueAt ? dueAt.toISOString() : null,
    timeZone,
    overdue: section === "overdue",
    recommendedAction: "Review Launch readiness for this property.",
    deepLink: `/properties/${plan.propertyId}`,
    createdAt: plan.createdAt ? (plan.createdAt as Date).toISOString() : now.toISOString(),
    updatedAt: plan.updatedAt ? (plan.updatedAt as Date).toISOString() : now.toISOString(),
    completedAt: section === "completedToday" && dueAt ? dueAt.toISOString() : null,
    priority: "P4",
    sections: sectionsFor(section),
  };
}

function vendorApprovalToActionItem(
  va: typeof vendorApprovals.$inferSelect,
  addressOf: (id: number) => string,
  now: Date,
  timeZone: string,
): ActionItem {
  return {
    id: `VENDOR_APPROVAL:${va.id}`,
    sourceType: "VENDOR_APPROVAL",
    sourceRecordId: String(va.id),
    propertyId: va.propertyId,
    propertyAddress: addressOf(va.propertyId),
    brokerageId: va.brokerageId,
    agentId: null,
    title: `${va.approvalType} approval pending`,
    description: "Requested and awaiting a Brokerage Administrator decision.",
    category: "LAUNCH_CAMPAIGN",
    severity: null,
    status: va.status,
    accountableOwnerType: "BROKERAGE_ADMINISTRATOR",
    accountableOwnerUserId: null,
    performingParty: "Brokerage Administrator",
    waitingOnParty: "Brokerage Administrator",
    dueAt: null,
    timeZone,
    overdue: false,
    recommendedAction: "Follow up with a Brokerage Administrator for a decision.",
    deepLink: `/properties/${va.propertyId}`,
    createdAt: va.createdAt ? (va.createdAt as Date).toISOString() : now.toISOString(),
    updatedAt: va.updatedAt ? (va.updatedAt as Date).toISOString() : now.toISOString(),
    completedAt: null,
    priority: "P4",
    sections: ["waitingOn"],
  };
}

function transactionToActionItem(
  t: typeof transactions.$inferSelect,
  addressOf: (id: number) => string,
  now: Date,
  timeZone: string,
  section: "today" | "overdue" | "comingUp" | "completedToday",
  brokerageId: number,
): ActionItem {
  const dueAt = (section === "completedToday" ? t.settlementCompletedAt : t.settlementDate) as Date | null;
  return {
    id: `SETTLEMENT_MILESTONE:${t.id}`,
    sourceType: "SETTLEMENT_MILESTONE",
    sourceRecordId: String(t.id),
    propertyId: t.propertyId,
    propertyAddress: addressOf(t.propertyId),
    brokerageId,
    agentId: null,
    title: section === "completedToday" ? "Settlement completed" : "Settlement date",
    description: section === "completedToday" ? "This transaction settled today." : "Scheduled settlement for this transaction.",
    category: "SETTLEMENT_CLOSURE",
    severity: null,
    status: t.status,
    accountableOwnerType: "TRANSACTION_OWNER",
    accountableOwnerUserId: null,
    performingParty: "Agent",
    waitingOnParty: null,
    dueAt: dueAt ? dueAt.toISOString() : null,
    timeZone,
    overdue: section === "overdue",
    recommendedAction: "Review settlement readiness for this transaction.",
    deepLink: `/properties/${t.propertyId}`,
    createdAt: t.createdAt ? (t.createdAt as Date).toISOString() : now.toISOString(),
    updatedAt: t.updatedAt ? (t.updatedAt as Date).toISOString() : now.toISOString(),
    completedAt: section === "completedToday" && dueAt ? dueAt.toISOString() : null,
    priority: "P4",
    sections: sectionsFor(section),
  };
}

function conditionToActionItem(
  cond: typeof transactionConditions.$inferSelect,
  txn: typeof transactions.$inferSelect,
  addressOf: (id: number) => string,
  now: Date,
  timeZone: string,
  section: "today" | "overdue" | "comingUp",
  brokerageId: number,
): ActionItem {
  const dueAt = cond.dueDate as Date | null;
  return {
    id: `CONTRACT_MILESTONE:${cond.id}`,
    sourceType: "CONTRACT_MILESTONE",
    sourceRecordId: String(cond.id),
    propertyId: txn.propertyId,
    propertyAddress: addressOf(txn.propertyId),
    brokerageId,
    agentId: null,
    title: cond.description,
    description: `Contract condition due ${dueAt ? dueAt.toDateString() : "soon"}.`,
    category: "CONTRACT_CONDITIONS",
    severity: null,
    status: cond.status,
    accountableOwnerType: "TRANSACTION_OWNER",
    accountableOwnerUserId: null,
    performingParty: "Agent",
    waitingOnParty: null,
    dueAt: dueAt ? dueAt.toISOString() : null,
    timeZone,
    overdue: section === "overdue",
    recommendedAction: `Confirm "${cond.description}" is satisfied, waived, or update its status.`,
    deepLink: `/properties/${txn.propertyId}`,
    createdAt: cond.createdAt ? (cond.createdAt as Date).toISOString() : now.toISOString(),
    updatedAt: cond.updatedAt ? (cond.updatedAt as Date).toISOString() : now.toISOString(),
    completedAt: null,
    priority: "P4",
    sections: sectionsFor(section),
  };
}

function offerToActionItem(
  o: typeof offers.$inferSelect,
  addressOf: (id: number) => string,
  now: Date,
  timeZone: string,
  brokerageId: number,
): ActionItem {
  return {
    id: `OFFER:${o.id}`,
    sourceType: "OFFER",
    sourceRecordId: String(o.id),
    propertyId: o.propertyId,
    propertyAddress: addressOf(o.propertyId),
    brokerageId,
    agentId: null,
    title: "Offer accepted",
    description: "An offer on this property was accepted today.",
    category: "OFFERS",
    severity: null,
    status: o.status,
    accountableOwnerType: "TRANSACTION_OWNER",
    accountableOwnerUserId: null,
    performingParty: "Agent",
    waitingOnParty: null,
    dueAt: null,
    timeZone,
    overdue: false,
    recommendedAction: "Move this property into contract preparation.",
    deepLink: `/properties/${o.propertyId}`,
    createdAt: (o.createdAt as Date).toISOString(),
    updatedAt: (o.createdAt as Date).toISOString(),
    completedAt: (o.createdAt as Date).toISOString(),
    priority: "P4",
    sections: ["completedToday"],
  };
}

function automationTaskToActionItem(
  t: typeof automationTasks.$inferSelect,
  addressOf: (id: number) => string,
  now: Date,
  timeZone: string,
  section: "today" | "comingUp" | "completedToday",
): ActionItem {
  const dueAt = t.dueAt as Date | null;
  return {
    id: `AUTOMATION_TASK:${t.id}`,
    sourceType: "AUTOMATION_TASK",
    sourceRecordId: String(t.id),
    propertyId: t.propertyId,
    propertyAddress: addressOf(t.propertyId),
    brokerageId: t.brokerageId,
    agentId: null,
    title: t.title,
    description: t.detail ?? t.title,
    category: "WORKFLOW_OPERATIONAL",
    severity: null,
    status: t.status,
    accountableOwnerType: t.assignedRole ?? "UNASSIGNED_QUEUE",
    accountableOwnerUserId: null,
    performingParty: t.assignedRole ?? "Unassigned",
    waitingOnParty: null,
    dueAt: dueAt ? dueAt.toISOString() : null,
    timeZone,
    overdue: false,
    recommendedAction: `Complete "${t.title}".`,
    deepLink: `/properties/${t.propertyId}`,
    createdAt: (t.createdAt as Date).toISOString(),
    updatedAt: (t.updatedAt as Date).toISOString(),
    completedAt: t.completedAt ? (t.completedAt as Date).toISOString() : null,
    priority: "P4",
    sections: sectionsFor(section),
  };
}

function workflowStepToActionItem(
  step: typeof workflowSteps.$inferSelect,
  workflow: typeof workflows.$inferSelect,
  addressOf: (id: number) => string,
  now: Date,
  timeZone: string,
  brokerageId: number,
): ActionItem {
  return {
    id: `WORKFLOW_ACTION:${step.id}`,
    sourceType: "WORKFLOW_ACTION",
    sourceRecordId: String(step.id),
    propertyId: workflow.propertyId,
    propertyAddress: addressOf(workflow.propertyId),
    brokerageId,
    agentId: null,
    title: step.label,
    description: `Next step in this property's ${workflow.workflowType} workflow.`,
    category: "WORKFLOW_OPERATIONAL",
    severity: null,
    status: step.status,
    accountableOwnerType: "LISTING_AGENT",
    accountableOwnerUserId: null,
    performingParty: "Agent",
    waitingOnParty: null,
    dueAt: null,
    timeZone,
    overdue: false,
    recommendedAction: `Complete "${step.label}" to move this property forward.`,
    deepLink: `/properties/${workflow.propertyId}`,
    createdAt: (step.createdAt as Date).toISOString(),
    updatedAt: (step.createdAt as Date).toISOString(),
    completedAt: null,
    priority: "P4",
    sections: ["today"],
  };
}

const STAGE_GROUPS: Record<string, string> = {
  Appraisal: "Appraisal & Listing Preparation",
  "Ready to List": "Launch",
  Listed: "On Market",
  "Under Offer": "Offer & Negotiation",
  Contract: "Contract",
  Settlement: "Settlement",
};

function buildActivePropertySummaries(
  propertyRows: Property[],
  deduped: ActionItem[],
): ActivePropertySummary[] {
  const itemsByProperty = new Map<number, ActionItem[]>();
  for (const item of deduped) {
    const list = itemsByProperty.get(item.propertyId) ?? [];
    list.push(item);
    itemsByProperty.set(item.propertyId, list);
  }
  const summaries: ActivePropertySummary[] = [];
  for (const p of propertyRows) {
    if (p.workflowStage === "Closed") continue;
    const propertyItems = (itemsByProperty.get(p.id) ?? []).filter(
      (i) => i.sourceType !== "EXCEPTION" || i.severity !== null,
    );
    const risk = propertyItems.find((i) => i.severity === "CRITICAL")
      ?? propertyItems.find((i) => i.severity === "AT_RISK")
      ?? propertyItems.find((i) => i.severity === "ATTENTION");
    const upcoming = propertyItems
      .filter((i) => i.dueAt && (i.sections.includes("today") || i.sections.includes("comingUp") || i.sections.includes("overdue")))
      .sort((a, b) => new Date(a.dueAt as string).getTime() - new Date(b.dueAt as string).getTime())[0];
    const nextAction = propertyItems.find((i) => i.priority !== "P4");
    const hasPitCrewWork = propertyItems.some((i) => i.accountableOwnerType === "PIT_CREW");
    summaries.push({
      propertyId: p.id,
      address: p.formattedAddress,
      stageGroup: STAGE_GROUPS[p.workflowStage] ?? p.workflowStage,
      workflowStage: p.workflowStage,
      nextMilestone: upcoming ? upcoming.title : null,
      nextAction: nextAction ? nextAction.recommendedAction : null,
      riskIndicator: (risk?.severity as ActivePropertySummary["riskIndicator"]) ?? null,
      responsibility: hasPitCrewWork ? (nextAction ? "SHARED" : "PIT_CREW") : "AGENT",
    });
  }
  return summaries;
}
