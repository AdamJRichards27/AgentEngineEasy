import { eq, and, inArray } from "drizzle-orm";
import {
  db,
  properties,
  workflows,
  workflowSteps,
  amlVerifications,
  offers,
  transactions,
  serviceOrders,
} from "@aee/db";

// AE GROW Priority 0.5 — Workstream 5 (Grow "Today" preparation: architecture only, no UX built,
// no behaviour changed here). This module is RUN's existing "what needs my attention today?"
// surface (Phase 8, documented in the JSDoc immediately below). Grow's own future "Today" view
// (Priority 1, NOT built in this phase) is a DIFFERENT product surface: it will aggregate
// relationship/activity/opportunity signals from the Grow domain (packages/db/src/schema/
// grow.ts — growRelationships, growActivities, growOpportunities), not the property-workflow
// signals this function reads (properties/workflows/amlVerifications/offers/transactions/
// serviceOrders). getHomeSummary() and getDashboardOverview() below stay exactly as they are —
// they are RUN surfaces, reused by RUN's Home page (apps/web/src/pages/Home.tsx) and, per
// Workstream 2, still reachable from RUN's own nav — and are not being merged, renamed, or
// repurposed for Grow. When Grow "Today" is built, it should follow the same shape established
// here (a flat list of concrete, actionable items, "Exception" vs "NextAction", each linking
// back to the record it concerns — never a BI dashboard of counts/charts/trends), but as its own
// function reading Grow's own tables, gated by "grow.access" rather than RUN's entitlement keys.
// This comment records that boundary; it changes no behaviour in Priority 0.5.

/**
 * Home screen aggregation (Phase 8, ARCHITECTURE.md §10 / Build Brief
 * §13, §26 — "what needs my attention today?", one or two decisions, not a
 * menu of modules). This is deliberately NOT a BI dashboard: no counts,
 * charts, or trends — just a flat list of concrete, actionable items
 * derived from live domain state across every non-Closed property in the
 * brokerage, each one linking straight back to the Property Workspace
 * where it's resolved. Scoped by brokerageId only, matching every other
 * list endpoint in this app (GET /properties) — there's no per-agent
 * "mine only" filter anywhere else, so Home doesn't invent one.
 *
 * "Exception" = something stuck or requiring a deliberate human decision
 * (a compliance/financial exception, a blocked workflow step, an overdue
 * settlement). "NextAction" = the normal next step to keep things moving
 * (an offer awaiting a response, a milestone ready to be actioned). The
 * distinction mirrors the AML "exception" language already used since
 * Phase 4, extended to the rest of the app.
 */

export type HomeItemCategory = "Exception" | "NextAction";

export interface HomeSummaryItem {
  propertyId: number;
  propertyAddress: string;
  workflowStage: string;
  category: HomeItemCategory;
  label: string;
  detail?: string;
}

export async function getHomeSummary(brokerageId: number): Promise<HomeSummaryItem[]> {
  const propertyRows = await db.select().from(properties).where(eq(properties.brokerageId, brokerageId));
  // A Closed property has nothing left to action — exclude it up front so
  // none of the checks below need to repeat that condition.
  const activeProperties = propertyRows.filter((p) => p.workflowStage !== "Closed");
  if (activeProperties.length === 0) return [];

  const propertyIds = activeProperties.map((p) => p.id);
  const propertyById = new Map(activeProperties.map((p) => [p.id, p]));
  const addressOf = (propertyId: number) => propertyById.get(propertyId)?.formattedAddress ?? `Property ${propertyId}`;
  const stageOf = (propertyId: number) => propertyById.get(propertyId)?.workflowStage ?? "";

  const items: HomeSummaryItem[] = [];

  // 1. Ownership mismatch (Build Brief §8) — a review prompt, never a hard
  // block on the property itself, but it is something a human needs to see.
  for (const p of activeProperties) {
    if (p.ownershipReviewRequired) {
      items.push({
        propertyId: p.id,
        propertyAddress: p.formattedAddress,
        workflowStage: p.workflowStage,
        category: "Exception",
        label: "Ownership mismatch needs review",
        detail: p.ownershipReviewNotes ?? undefined,
      });
    }
  }

  // 2. AML exceptions. resolveAmlException() always moves status away from
  // Review Required/Failed to Complete, so filtering on status alone (no
  // separate "already resolved" check) is sufficient — an unresolved
  // exception is exactly what's left in these two statuses.
  const amlRows = await db
    .select()
    .from(amlVerifications)
    .where(and(inArray(amlVerifications.propertyId, propertyIds), inArray(amlVerifications.status, ["Review Required", "Failed"])));
  for (const v of amlRows) {
    items.push({
      propertyId: v.propertyId,
      propertyAddress: addressOf(v.propertyId),
      workflowStage: stageOf(v.propertyId),
      category: "Exception",
      label: v.status === "Failed" ? "AML check failed" : "AML review required",
      detail: v.outcome ?? undefined,
    });
  }

  // 3. Failed service charges (paymentStatus stays "Failed" until a retry
  // succeeds — see chargeServiceOrder in lib/payments.ts).
  const failedServiceOrders = await db
    .select()
    .from(serviceOrders)
    .where(and(inArray(serviceOrders.propertyId, propertyIds), eq(serviceOrders.paymentStatus, "Failed")));
  for (const so of failedServiceOrders) {
    items.push({
      propertyId: so.propertyId,
      propertyAddress: addressOf(so.propertyId),
      workflowStage: stageOf(so.propertyId),
      category: "Exception",
      label: `Payment failed — ${so.serviceType}`,
    });
  }

  // 4. Workflow steps: a Blocked step is an exception (something's stuck);
  // a fully-Complete Ready to List workflow that hasn't gone live yet is a
  // routine next action. In-progress/pending steps are the normal flow of
  // work and deliberately not surfaced here — this list is for things that
  // need a decision, not a full status board (that's the BI dashboard this
  // phase explicitly doesn't build).
  const workflowRows = await db.select().from(workflows).where(inArray(workflows.propertyId, propertyIds));
  if (workflowRows.length > 0) {
    const workflowById = new Map(workflowRows.map((w) => [w.id, w]));
    const stepRows = await db
      .select()
      .from(workflowSteps)
      .where(inArray(workflowSteps.workflowId, workflowRows.map((w) => w.id)));

    const stepsByWorkflow = new Map<number, typeof stepRows>();
    for (const step of stepRows) {
      const list = stepsByWorkflow.get(step.workflowId) ?? [];
      list.push(step);
      stepsByWorkflow.set(step.workflowId, list);
    }

    for (const workflow of workflowRows) {
      const steps = stepsByWorkflow.get(workflow.id) ?? [];
      const blocked = steps.filter((s) => s.status === "Blocked");
      for (const step of blocked) {
        items.push({
          propertyId: workflow.propertyId,
          propertyAddress: addressOf(workflow.propertyId),
          workflowStage: stageOf(workflow.propertyId),
          category: "Exception",
          label: `${step.label} is blocked`,
          detail: step.blockedReason ?? undefined,
        });
      }

      if (workflow.workflowType === "ReadyToList" && steps.length > 0 && blocked.length === 0) {
        const allComplete = steps.every((s) => s.status === "Complete");
        const property = propertyById.get(workflow.propertyId);
        if (allComplete && property && property.listingStatus !== "Listed") {
          items.push({
            propertyId: workflow.propertyId,
            propertyAddress: addressOf(workflow.propertyId),
            workflowStage: stageOf(workflow.propertyId),
            category: "NextAction",
            label: "Ready to go live",
          });
        }
      }
    }
  }

  // 5. Offers awaiting a response.
  const receivedOffers = await db
    .select()
    .from(offers)
    .where(and(inArray(offers.propertyId, propertyIds), eq(offers.status, "Received")));
  for (const offer of receivedOffers) {
    items.push({
      propertyId: offer.propertyId,
      propertyAddress: addressOf(offer.propertyId),
      workflowStage: stageOf(offer.propertyId),
      category: "NextAction",
      label: `Offer received — $${(offer.offerPriceCents / 100).toLocaleString()}`,
      detail: "Accept or decline in the workspace.",
    });
  }

  // 6. Transaction milestones. Each Transaction is at most one live row per
  // property (this build's "one active Transaction at a time" rule — see
  // lib/transactions.ts acceptOffer), so there's no fan-out to worry about.
  const transactionRows = await db.select().from(transactions).where(inArray(transactions.propertyId, propertyIds));
  const now = new Date();
  for (const t of transactionRows) {
    if (t.status === "ContractPreparation") {
      items.push({
        propertyId: t.propertyId,
        propertyAddress: addressOf(t.propertyId),
        workflowStage: stageOf(t.propertyId),
        category: "NextAction",
        label: "Prepare contract for signing",
      });
    } else if (t.status === "UnderContract" && !t.settlementDate) {
      items.push({
        propertyId: t.propertyId,
        propertyAddress: addressOf(t.propertyId),
        workflowStage: stageOf(t.propertyId),
        category: "NextAction",
        label: "Schedule settlement",
      });
    } else if (t.status === "SettlementScheduled" && t.settlementDate && t.settlementDate < now && !t.settlementCompletedAt) {
      items.push({
        propertyId: t.propertyId,
        propertyAddress: addressOf(t.propertyId),
        workflowStage: stageOf(t.propertyId),
        category: "Exception",
        label: "Settlement date has passed",
        detail: "Mark settlement complete or reschedule.",
      });
    } else if (t.status === "Settled" && !t.agentPaidAt) {
      items.push({
        propertyId: t.propertyId,
        propertyAddress: addressOf(t.propertyId),
        workflowStage: stageOf(t.propertyId),
        category: "NextAction",
        label: t.fundsReceivedCents > 0 ? "Confirm agent paid" : "Record funds received",
      });
    } else if (t.status === "Settled" && t.agentPaidAt && !t.closedAt) {
      items.push({
        propertyId: t.propertyId,
        propertyAddress: addressOf(t.propertyId),
        workflowStage: stageOf(t.propertyId),
        category: "NextAction",
        label: "Close transaction",
      });
    }
  }

  // Exceptions first — they're the ones a person is most likely to be
  // missing something on — then next actions, each alphabetised by address
  // so the same property's items stay together.
  items.sort((a, b) => {
    if (a.category !== b.category) return a.category === "Exception" ? -1 : 1;
    return a.propertyAddress.localeCompare(b.propertyAddress);
  });

  return items;
}

export interface DashboardProperty {
  id: number;
  address: string;
  workflowStage: string;
}

export interface DashboardSettlement {
  propertyId: number;
  address: string;
  settlementDate: string;
}

// The Dashboard's other two sections (staging brief: "Dashboard — Needs
// Attention, Active Properties, Settlements"). Needs Attention is
// getHomeSummary()'s Exception items above; these two are simple,
// unfiltered lists — not exceptions, just "what's currently open" and
// "what's coming up" — so they're kept separate rather than folded into the
// exceptions/next-actions aggregation, which is deliberately curated.
export async function getDashboardOverview(
  brokerageId: number,
): Promise<{ activeProperties: DashboardProperty[]; upcomingSettlements: DashboardSettlement[] }> {
  const propertyRows = await db.select().from(properties).where(eq(properties.brokerageId, brokerageId));
  const activeProperties = propertyRows
    .filter((p) => p.workflowStage !== "Closed")
    .sort((a, b) => a.formattedAddress.localeCompare(b.formattedAddress))
    .map((p) => ({ id: p.id, address: p.formattedAddress, workflowStage: p.workflowStage }));

  if (activeProperties.length === 0) return { activeProperties, upcomingSettlements: [] };

  const propertyIds = activeProperties.map((p) => p.id);
  const addressById = new Map(activeProperties.map((p) => [p.id, p.address]));
  const transactionRows = await db.select().from(transactions).where(inArray(transactions.propertyId, propertyIds));

  const upcomingSettlements = transactionRows
    .filter((t) => t.settlementDate && !t.settlementCompletedAt)
    .sort((a, b) => a.settlementDate!.getTime() - b.settlementDate!.getTime())
    .map((t) => ({
      propertyId: t.propertyId,
      address: addressById.get(t.propertyId) ?? `Property ${t.propertyId}`,
      settlementDate: t.settlementDate!.toISOString(),
    }));

  return { activeProperties, upcomingSettlements };
}
