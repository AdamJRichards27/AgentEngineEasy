import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  auditLogs,
  domainEvents,
  parties,
  amlVerifications,
  offers,
  properties,
  type AuditLogRow,
  type DomainEventRow,
} from "@aee/db";

// Property Timeline (#131 design doc). Originally specified (ARCHITECTURE.md
// §2) as "a read projection over [AuditLog] + Event, exactly as Agent
// Engine already does it" — never actually built that way until now; the
// Phase 1-9 version of this file only ever read auditLogs. This version
// fulfils that original intent: every milestone type has exactly one
// authoritative source (a canonical domain event where one reliably exists
// and fires, auditLogs.action for the confirmed gaps — see
// TIMELINE_ENTRY_TYPES below), so no milestone can ever appear twice and no
// dedup logic is needed. Financial figures (commission/funds/agent-paid,
// plus their audit-log-sourced siblings service_order_charged/
// payment_refunded) are redacted server-side for any caller who isn't a
// Brokerage Administrator — the first real use of the
// financial-entitlement-boundary concept this app didn't previously have a
// read-side precedent for (see #130 source map §9).
export type TimelineCategory =
  | "Property"
  | "Party"
  | "AML"
  | "Appraisal"
  | "Listing"
  | "Document"
  | "Offer"
  | "Transaction"
  | "Task"
  | "Compliance";

export interface TimelineItem {
  id: string;
  propertyId: number;
  entryType: string;
  category: TimelineCategory;
  occurredAt: string; // ISO timestamp
  actor: { type: string; userId: number | null; label: string } | null;
  label: string; // already redacted server-side if sensitive + unauthorized
  sensitivity: "STANDARD" | "SENSITIVE";
  detail?: Record<string, unknown>;
  refs: Array<{ recordType: string; recordId: string | number }>;
  source: "domain_event" | "audit_log";
}

// Backward-compatible shape — apps/api/src/lib/ai/tools/registry.ts's
// get_property_timeline tool (and anything else that only needs a flat
// label/timestamp) still gets exactly this from every TimelineItem.
export interface TimelineEntry {
  id: string;
  at: string;
  label: string;
}

interface EntryTypeConfig {
  source: "domain_event" | "audit_log";
  category: TimelineCategory;
  sensitive: boolean;
}

// Single source of truth (#131 design doc §2): which table an entry type
// reads from, what category it groups under, and whether it carries a
// dollar figure that must be redacted for a non-Brokerage-Administrator
// viewer. Both the query layer and the label/redaction layer read this.
const TIMELINE_ENTRY_TYPES: Record<string, EntryTypeConfig> = {
  PROPERTY_CREATED: { source: "domain_event", category: "Property", sensitive: false },
  party_added: { source: "audit_log", category: "Party", sensitive: false },
  party_link_removed: { source: "audit_log", category: "Party", sensitive: false },

  AML_REQUESTED: { source: "domain_event", category: "AML", sensitive: false },
  AML_COMPLETED: { source: "domain_event", category: "AML", sensitive: false },
  aml_exception_resolved: { source: "audit_log", category: "AML", sensitive: false },
  aml_verification_retried: { source: "audit_log", category: "AML", sensitive: false },

  APPRAISAL_CREATED: { source: "domain_event", category: "Appraisal", sensitive: false },
  APPRAISAL_COMPLETED: { source: "domain_event", category: "Appraisal", sensitive: false },

  ownership_review_resolved: { source: "audit_log", category: "Property", sensitive: false },

  READY_TO_LIST: { source: "domain_event", category: "Listing", sensitive: false },
  DOCUMENT_PACKAGE_CREATED: { source: "domain_event", category: "Document", sensitive: false },
  LISTING_LIVE: { source: "domain_event", category: "Listing", sensitive: false },
  agency_agreement_terms_updated: { source: "audit_log", category: "Document", sensitive: false },
  AGENCY_AGREEMENT_SENT: { source: "domain_event", category: "Document", sensitive: false },
  AGENCY_AGREEMENT_SIGNED: { source: "domain_event", category: "Document", sensitive: false },
  document_package_sent_for_signature: { source: "audit_log", category: "Document", sensitive: false },

  OFFER_RECEIVED: { source: "domain_event", category: "Offer", sensitive: false },
  OFFER_ACCEPTED: { source: "domain_event", category: "Offer", sensitive: false },
  offer_declined: { source: "audit_log", category: "Offer", sensitive: false },
  offer_withdrawn: { source: "audit_log", category: "Offer", sensitive: false },
  offer_auto_declined: { source: "audit_log", category: "Offer", sensitive: false },

  CONTRACT_SIGNED: { source: "domain_event", category: "Transaction", sensitive: false },
  CONTRACT_EXCHANGED: { source: "domain_event", category: "Transaction", sensitive: false },
  TRANSACTION_UNCONDITIONAL: { source: "domain_event", category: "Transaction", sensitive: false },
  FINANCE_APPROVED: { source: "domain_event", category: "Transaction", sensitive: false },
  SETTLEMENT_SCHEDULED: { source: "domain_event", category: "Transaction", sensitive: false },
  SETTLEMENT_COMPLETED: { source: "domain_event", category: "Transaction", sensitive: false },
  COMMISSION_CALCULATED: { source: "domain_event", category: "Transaction", sensitive: true },
  FUNDS_RECEIVED: { source: "domain_event", category: "Transaction", sensitive: true },
  AGENT_PAID: { source: "domain_event", category: "Transaction", sensitive: true },
  TRANSACTION_CLOSED: { source: "domain_event", category: "Transaction", sensitive: false },
  transaction_closed_forced: { source: "audit_log", category: "Compliance", sensitive: false },

  payment_method_added: { source: "audit_log", category: "Compliance", sensitive: false },
  payment_method_removed: { source: "audit_log", category: "Compliance", sensitive: false },
  service_order_charged: { source: "audit_log", category: "Compliance", sensitive: true },
  payment_refunded: { source: "audit_log", category: "Compliance", sensitive: true },

  automation_task_created: { source: "audit_log", category: "Task", sensitive: false },
  automation_reminder_created: { source: "audit_log", category: "Task", sensitive: false },
  automation_task_superseded: { source: "audit_log", category: "Task", sensitive: false },
  automation_reminder_superseded: { source: "audit_log", category: "Task", sensitive: false },
  // TASK_COMPLETED exists in the canonical event registry but has zero
  // publishers (completeAutomationTask() only calls logAudit — verified at
  // #132 build time, #131 design doc §5) — sourced from auditLogs instead
  // rather than adding an unrelated publish call to automation/tasks.ts.
  automation_task_completed: { source: "audit_log", category: "Task", sensitive: false },
  automation_attention_item_raised: { source: "audit_log", category: "Task", sensitive: false },
  automation_attention_item_resolved: { source: "audit_log", category: "Task", sensitive: false },
};

const DOMAIN_EVENT_ENTRY_TYPES = Object.entries(TIMELINE_ENTRY_TYPES)
  .filter(([, c]) => c.source === "domain_event")
  .map(([k]) => k);
const AUDIT_LOG_ENTRY_TYPES = Object.entries(TIMELINE_ENTRY_TYPES)
  .filter(([, c]) => c.source === "audit_log")
  .map(([k]) => k);

function partyDisplayName(
  p: { firstName: string | null; lastName: string | null; organisationName: string | null } | undefined,
): string {
  if (!p) return "A party";
  return p.organisationName || `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "A party";
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

// Static labels for entry types that read cleanly on their own, no
// related-record lookup needed (mirrors this file's pre-existing
// SIMPLE_LABELS convention, split by source since domain events and audit
// rows key on different vocabularies — canonical event type vs. free-text
// action).
const SIMPLE_DOMAIN_EVENT_LABELS: Record<string, string> = {
  PROPERTY_CREATED: "Property created",
  APPRAISAL_CREATED: "Appraisal started",
  APPRAISAL_COMPLETED: "Appraisal finalised",
  READY_TO_LIST: "Ready to List started",
  DOCUMENT_PACKAGE_CREATED: "Document package created",
  LISTING_LIVE: "Listing went live",
  AGENCY_AGREEMENT_SENT: "Agency agreement sent for signature",
  AGENCY_AGREEMENT_SIGNED: "Agency agreement signed",
  CONTRACT_SIGNED: "Contract signed",
  CONTRACT_EXCHANGED: "Contracts exchanged",
  TRANSACTION_UNCONDITIONAL: "Transaction became unconditional",
  FINANCE_APPROVED: "Finance approved",
  SETTLEMENT_COMPLETED: "Settlement completed",
  TRANSACTION_CLOSED: "Transaction closed",
};

const SIMPLE_AUDIT_LABELS: Record<string, string> = {
  party_link_removed: "A party was removed from this property",
  ownership_review_resolved: "Ownership review cleared",
  agency_agreement_terms_updated: "Agency agreement terms updated",
  document_package_sent_for_signature: "Documents sent for signature",
  payment_method_added: "Payment method added",
  payment_method_removed: "Payment method removed",
  service_order_charged: "Payment charged",
  payment_refunded: "Payment refunded",
  transaction_closed_forced: "Transaction closed (with overrides)",
  aml_exception_resolved: "AML review resolved",
  aml_verification_retried: "AML verification re-checked",
  automation_task_created: "Task created",
  automation_reminder_created: "Reminder created",
  automation_task_superseded: "Task rescheduled",
  automation_reminder_superseded: "Reminder rescheduled",
  automation_task_completed: "Task completed",
  automation_attention_item_raised: "Attention item raised",
  automation_attention_item_resolved: "Attention item resolved",
};

// Figure-free version of a SENSITIVE entry's label, used whenever the
// viewer isn't a Brokerage Administrator. Never derived by stripping the
// real label at render time — computed independently so a redacted label
// can never accidentally leak a figure through a formatting edge case.
function redactedLabel(entryType: string): string {
  switch (entryType) {
    case "COMMISSION_CALCULATED":
      return "Commission calculated";
    case "FUNDS_RECEIVED":
      return "Funds received";
    case "AGENT_PAID":
      return "Agent paid";
    case "service_order_charged":
      return "Payment charged";
    case "payment_refunded":
      return "Payment refunded";
    default:
      return SIMPLE_DOMAIN_EVENT_LABELS[entryType] ?? SIMPLE_AUDIT_LABELS[entryType] ?? entryType;
  }
}

// #123-precedent tenant chokepoint for the Timeline query — resolves
// propertyId -> brokerageId once, uniform "not found" on mismatch, before
// either source query below ever runs.
export async function assertPropertyInBrokerage(propertyId: number, brokerageId: number): Promise<void> {
  const [property] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.brokerageId, brokerageId)));
  if (!property) throw new Error(`Property ${propertyId} not found`);
}

export async function getPropertyTimeline(
  propertyId: number,
  brokerageId: number,
  canViewFinancials: boolean,
): Promise<TimelineItem[]> {
  await assertPropertyInBrokerage(propertyId, brokerageId);

  const [eventRows, auditRows] = await Promise.all([
    db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.propertyId, propertyId),
          eq(domainEvents.brokerageId, brokerageId),
          inArray(domainEvents.eventType, DOMAIN_EVENT_ENTRY_TYPES),
        ),
      ),
    // auditLogs has no brokerageId column of its own — the tenant check
    // above already confirmed this propertyId belongs to the caller's
    // brokerage, so a plain propertyId filter here cannot return another
    // tenant's rows for the same property (#131 design doc §3/§5).
    db.select().from(auditLogs).where(and(eq(auditLogs.propertyId, propertyId), inArray(auditLogs.action, AUDIT_LOG_ENTRY_TYPES))),
  ]);

  if (eventRows.length === 0 && auditRows.length === 0) return [];

  // Batch-fetch related rows purely for display names, same pattern this
  // file used before.
  const eventPartyIds = eventRows.map((r) => r.partyId).filter((id): id is number => id != null);
  const auditPartyAddedIds = auditRows.filter((r) => r.recordType === "party").map((r) => Number(r.recordId));
  const amlIds = auditRows.filter((r) => r.recordType === "aml_verification").map((r) => Number(r.recordId));
  const offerIds = auditRows.filter((r) => r.recordType === "offer").map((r) => Number(r.recordId));

  const [eventPartyRows, auditPartyRows, amlRows, offerRows] = await Promise.all([
    eventPartyIds.length ? db.select().from(parties).where(inArray(parties.id, eventPartyIds)) : Promise.resolve([]),
    auditPartyAddedIds.length ? db.select().from(parties).where(inArray(parties.id, auditPartyAddedIds)) : Promise.resolve([]),
    amlIds.length ? db.select().from(amlVerifications).where(inArray(amlVerifications.id, amlIds)) : Promise.resolve([]),
    offerIds.length ? db.select().from(offers).where(inArray(offers.id, offerIds)) : Promise.resolve([]),
  ]);

  const offerBuyerIds = offerRows.map((o) => o.buyerPartyId).filter((id): id is number => id != null);
  const amlPartyIds = amlRows.map((a) => a.partyId);
  const extraPartyIds = [...offerBuyerIds, ...amlPartyIds].filter((id) => !auditPartyAddedIds.includes(id));
  const extraPartyRows = extraPartyIds.length ? await db.select().from(parties).where(inArray(parties.id, extraPartyIds)) : [];
  const auditParties = [...auditPartyRows, ...extraPartyRows];

  function domainEventLabel(row: DomainEventRow): string {
    if (row.eventType === "AML_REQUESTED" || row.eventType === "AML_COMPLETED") {
      const party = eventPartyRows.find((p) => p.id === row.partyId);
      const name = partyDisplayName(party);
      return row.eventType === "AML_REQUESTED" ? `AML verification requested for ${name}` : `AML verification completed for ${name}`;
    }
    if (row.eventType === "OFFER_RECEIVED" || row.eventType === "OFFER_ACCEPTED") {
      const party = eventPartyRows.find((p) => p.id === row.partyId);
      const name = party ? partyDisplayName(party) : "a buyer";
      const payload = (row.payload ?? {}) as { offerPriceCents?: number; purchasePriceCents?: number };
      const cents = payload.offerPriceCents ?? payload.purchasePriceCents;
      const price = typeof cents === "number" ? ` (${formatCents(cents)})` : "";
      return row.eventType === "OFFER_RECEIVED" ? `Offer received from ${name}${price}` : `Offer from ${name} accepted${price}`;
    }
    if (row.eventType === "SETTLEMENT_SCHEDULED") {
      const payload = (row.payload ?? {}) as { settlementDate?: string };
      return payload.settlementDate ? `Settlement scheduled for ${formatDate(payload.settlementDate)}` : "Settlement scheduled";
    }
    if (row.eventType === "COMMISSION_CALCULATED") {
      const payload = (row.payload ?? {}) as { grossCommissionCents?: number; gstCents?: number };
      if (typeof payload.grossCommissionCents === "number") {
        const gst = typeof payload.gstCents === "number" ? ` (+ ${formatCents(payload.gstCents)} GST)` : "";
        return `Commission calculated: ${formatCents(payload.grossCommissionCents)}${gst}`;
      }
      return "Commission calculated";
    }
    if (row.eventType === "FUNDS_RECEIVED") {
      const payload = (row.payload ?? {}) as { amountCents?: number };
      return typeof payload.amountCents === "number" ? `Funds received (${formatCents(payload.amountCents)})` : "Funds received";
    }
    return (
      SIMPLE_DOMAIN_EVENT_LABELS[row.eventType] ??
      row.eventType.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase())
    );
  }

  function auditLabel(row: AuditLogRow): string {
    if (row.recordType === "party" && row.action === "party_added") {
      const party = auditParties.find((p) => p.id === Number(row.recordId));
      return `${partyDisplayName(party)} added`;
    }
    if (row.recordType === "aml_verification") {
      const verification = amlRows.find((v) => v.id === Number(row.recordId));
      const party = auditParties.find((p) => p.id === verification?.partyId);
      const name = partyDisplayName(party);
      return row.action === "aml_exception_resolved" ? `${name}'s AML review resolved` : `${name}'s AML verification re-checked`;
    }
    if (row.recordType === "offer") {
      const offer = offerRows.find((o) => o.id === Number(row.recordId));
      const buyer = auditParties.find((p) => p.id === offer?.buyerPartyId);
      const buyerName = buyer ? partyDisplayName(buyer) : "Buyer";
      if (row.action === "offer_declined") return `Offer from ${buyerName} declined`;
      if (row.action === "offer_withdrawn") return `Offer from ${buyerName} withdrawn`;
      if (row.action === "offer_auto_declined") return `Offer from ${buyerName} auto-declined (another offer was accepted)`;
    }
    return SIMPLE_AUDIT_LABELS[row.action] ?? row.action.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  }

  const eventItems: TimelineItem[] = eventRows.map((row) => {
    const config = TIMELINE_ENTRY_TYPES[row.eventType];
    const sensitive = config?.sensitive ?? false;
    const redact = sensitive && !canViewFinancials;
    return {
      id: `domain_event:${row.id}`,
      propertyId,
      entryType: row.eventType,
      category: config?.category ?? "Property",
      occurredAt: row.occurredAt.toISOString(),
      actor: {
        type: row.actorType,
        userId: row.actorId,
        label: row.actorType === "USER" ? "Agent" : row.actorType === "INTEGRATION" ? "System" : row.actorType,
      },
      label: redact ? redactedLabel(row.eventType) : domainEventLabel(row),
      sensitivity: sensitive ? "SENSITIVE" : "STANDARD",
      detail: redact ? undefined : ((row.payload as Record<string, unknown> | null) ?? undefined),
      refs: [],
      source: "domain_event",
    };
  });

  const auditItems: TimelineItem[] = auditRows.map((row) => {
    const config = TIMELINE_ENTRY_TYPES[row.action];
    const sensitive = config?.sensitive ?? false;
    const redact = sensitive && !canViewFinancials;
    return {
      id: `audit_log:${row.id}`,
      propertyId,
      entryType: row.action,
      category: config?.category ?? "Property",
      occurredAt: row.createdAt.toISOString(),
      actor: row.userId
        ? { type: "USER", userId: row.userId, label: row.userEmail ?? "A user" }
        : { type: "SYSTEM", userId: null, label: "System" },
      label: redact ? redactedLabel(row.action) : auditLabel(row),
      sensitivity: sensitive ? "SENSITIVE" : "STANDARD",
      detail: redact ? undefined : row.updatedValue ? { updatedValue: row.updatedValue } : undefined,
      refs: [{ recordType: row.recordType, recordId: row.recordId }],
      source: "audit_log",
    };
  });

  return [...eventItems, ...auditItems].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}
