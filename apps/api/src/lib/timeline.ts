import { and, eq, inArray } from "drizzle-orm";
import { db, auditLogs, parties, amlVerifications, offers, type AuditLogRow } from "@aee/db";

// Property Timeline (ARCHITECTURE.md §4 originally specified this as part
// of the workspace response; never actually built until now). A read
// projection over auditLogs — every route that mutates something already
// calls logAudit() (apps/api/src/lib/audit.ts), so this adds no new writes,
// only a human-readable formatting pass over what's already recorded.
export interface TimelineEntry {
  id: number;
  at: string; // ISO timestamp — the frontend formats it for display
  label: string;
}

function partyDisplayName(p: { firstName: string | null; lastName: string | null; organisationName: string | null } | undefined): string {
  if (!p) return "A party";
  return p.organisationName || `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "A party";
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Static labels for actions that don't need any related-record lookup to
// read cleanly on their own.
const SIMPLE_LABELS: Record<string, string> = {
  property_created: "Property created",
  ownership_review_resolved: "Ownership review cleared",
  listing_live: "Listing went live",
  party_link_removed: "A party was removed from this property",
  agency_agreement_terms_updated: "Agency agreement terms updated",
  document_package_sent_for_signature: "Documents sent for signature",
  payment_method_added: "Payment method added",
  payment_method_removed: "Payment method removed",
  service_order_charged: "Payment charged",
  payment_refunded: "Payment refunded",
  contract_signed: "Contract signed",
  finance_approved: "Finance approved",
  settlement_scheduled: "Settlement scheduled",
  commission_calculated: "Commission calculated",
  settlement_completed: "Settlement completed",
  agent_paid: "Agent paid",
  transaction_closed: "Transaction closed",
};

export async function getPropertyTimeline(propertyId: number): Promise<TimelineEntry[]> {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.propertyId, propertyId))
    .orderBy(auditLogs.createdAt);

  if (rows.length === 0) return [];

  const partyIds = rows.filter((r) => r.recordType === "party").map((r) => Number(r.recordId));
  const amlIds = rows.filter((r) => r.recordType === "aml_verification").map((r) => Number(r.recordId));
  const offerIds = rows.filter((r) => r.recordType === "offer").map((r) => Number(r.recordId));

  const [partyRows, amlRows, offerRows] = await Promise.all([
    partyIds.length ? db.select().from(parties).where(inArray(parties.id, partyIds)) : Promise.resolve([]),
    amlIds.length ? db.select().from(amlVerifications).where(inArray(amlVerifications.id, amlIds)) : Promise.resolve([]),
    offerIds.length ? db.select().from(offers).where(inArray(offers.id, offerIds)) : Promise.resolve([]),
  ]);

  const offerBuyerIds = offerRows.map((o) => o.buyerPartyId).filter((id): id is number => id != null);
  const offerBuyers = offerBuyerIds.length
    ? await db.select().from(parties).where(inArray(parties.id, offerBuyerIds))
    : [];

  const amlPartyIds = amlRows.map((a) => a.partyId);
  const amlParties = amlPartyIds.length ? await db.select().from(parties).where(inArray(parties.id, amlPartyIds)) : [];

  const label = (row: AuditLogRow): string => {
    if (row.recordType === "party") {
      const party = partyRows.find((p) => p.id === Number(row.recordId));
      const name = partyDisplayName(party);
      return row.action === "party_added" ? `${name} added` : `${name} updated`;
    }
    if (row.recordType === "aml_verification") {
      const verification = amlRows.find((v) => v.id === Number(row.recordId));
      const party = amlParties.find((p) => p.id === verification?.partyId);
      const name = partyDisplayName(party);
      if (row.action === "aml_exception_resolved") return `${name}'s AML review resolved`;
      if (row.action === "aml_verification_retried") return `${name}'s AML verification re-checked`;
      return `${name}'s AML verification updated`;
    }
    if (row.recordType === "offer") {
      const offer = offerRows.find((o) => o.id === Number(row.recordId));
      const buyer = offerBuyers.find((p) => p.id === offer?.buyerPartyId);
      const buyerName = buyer ? partyDisplayName(buyer) : "Buyer";
      const price = offer ? ` (${formatCents(offer.offerPriceCents)})` : "";
      if (row.action === "offer_received") return `Offer received from ${buyerName}${price}`;
      if (row.action === "offer_accepted") return `Offer from ${buyerName} accepted${price}`;
      if (row.action === "offer_declined") return `Offer from ${buyerName} declined`;
      if (row.action === "offer_withdrawn") return `Offer from ${buyerName} withdrawn`;
      if (row.action === "offer_auto_declined") return `Offer from ${buyerName} auto-declined (another offer was accepted)`;
      return `Offer from ${buyerName} updated`;
    }
    if (row.recordType === "transaction" && row.action === "funds_received" && row.updatedValue) {
      return `Funds received (${formatCents(Number(row.updatedValue))})`;
    }
    return SIMPLE_LABELS[row.action] ?? row.action.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  };

  return rows.map((row) => ({ id: row.id, at: row.createdAt.toISOString(), label: label(row) }));
}
