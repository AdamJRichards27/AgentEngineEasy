// Agent Engine 2.0 — Exception & Risk Engine (Priority 4).
// Category C — Offers (Build Instructions §10.C, rules 10-14). #11 is
// deferred: no field in workflow.ts's offers table (or anywhere else in the
// merged domain model) tracks an offer's expiry/withdrawal deadline or a
// vendor's instruction to accept/reject — the table only records the offer
// itself and its terminal status, not the negotiation timeline around it.
// Implementing #11 would mean inventing a deadline concept the schema does
// not expose (Build Instructions §10: "record exact missing dependency
// rather than approximating"), so it is left for a future build once that
// field exists.

import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, properties, offers, transactions, parties, type Offer, type Property } from "@aee/db";
import type { RiskRule } from "../registry.js";
import type { RiskFinding } from "../types.js";
import { dedupKey, escalatesAtFor, resolveDefaultOwner, severityForDeadline } from "./shared.js";

const ACTIVE_OFFER_STATUSES = ["Received", "Accepted"] as const;

const C10_OFFER_MISSING_BUYER_CONTACT: RiskRule = {
  ruleId: "C10_OFFER_MISSING_BUYER_CONTACT_DETAILS",
  version: 1,
  category: "OFFERS",
  name: "Offer missing buyer or required contact details",
  description: "An active (Received or Accepted) offer has no buyer party recorded, or the recorded buyer has neither an email nor a mobile number.",
  triggerEventTypes: ["OFFER_RECEIVED", "OFFER_ACCEPTED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ offer: offers, property: properties })
      .from(offers)
      .innerJoin(properties, eq(offers.propertyId, properties.id))
      .where(and(eq(properties.brokerageId, brokerageId), inArray(offers.status, [...ACTIVE_OFFER_STATUSES])));
    const buyerPartyIds = rows.map((r) => r.offer.buyerPartyId).filter((id): id is number => id !== null);
    const buyerParties = buyerPartyIds.length ? await db.select().from(parties).where(inArray(parties.id, buyerPartyIds)) : [];

    const findings: RiskFinding[] = [];
    for (const { offer, property } of rows) {
      const missingBuyer = !offer.buyerPartyId;
      const buyer = offer.buyerPartyId ? buyerParties.find((p) => p.id === offer.buyerPartyId) : undefined;
      const missingContact = !missingBuyer && buyer !== undefined && !buyer.email && !buyer.mobile;
      if (!missingBuyer && !missingContact) continue;
      const owner = resolveDefaultOwner(property, false);
      const severity = offer.status === "Accepted" ? "AT_RISK" : "ATTENTION";
      findings.push({
        ruleId: C10_OFFER_MISSING_BUYER_CONTACT.ruleId,
        ruleVersion: C10_OFFER_MISSING_BUYER_CONTACT.version,
        category: "OFFERS",
        severity,
        title: missingBuyer ? "Offer has no buyer recorded" : "Offer's buyer has no contact details recorded",
        problemDescription: missingBuyer
          ? `Offer #${offer.id} (${offer.status}) has no buyer party recorded.`
          : `Offer #${offer.id}'s buyer has neither an email nor a mobile number recorded.`,
        businessImpact: "Without buyer contact details, the offer cannot be progressed to a transaction and the buyer cannot be reached for AML/CTF or contract correspondence.",
        detectedCause: missingBuyer ? "offers.buyerPartyId is null." : "parties.email and parties.mobile are both null for the offer's buyer.",
        ...owner,
        propertyId: property.id,
        transactionId: null,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Record the buyer's party and at least one contact method for this offer.",
        resolutionRequirements: "offers.buyerPartyId is set and the buyer party has an email or mobile recorded.",
        dismissible: false,
        sourceRecordType: "offer",
        sourceRecordId: String(offer.id),
        dedupKey: dedupKey(C10_OFFER_MISSING_BUYER_CONTACT.ruleId, brokerageId, offer.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { offerId: offer.id },
      });
    }
    return findings;
  },
};

const C12_ACCEPTED_OFFER_NOT_LINKED: RiskRule = {
  ruleId: "C12_ACCEPTED_OFFER_NOT_LINKED_TO_TRANSACTION",
  version: 1,
  category: "OFFERS",
  name: "Accepted offer has not created or linked a transaction",
  description: "An offer reached status Accepted but no transaction references it as its acceptedOfferId.",
  triggerEventTypes: ["OFFER_ACCEPTED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ offer: offers, property: properties })
      .from(offers)
      .innerJoin(properties, eq(offers.propertyId, properties.id))
      .where(and(eq(properties.brokerageId, brokerageId), eq(offers.status, "Accepted")));
    if (rows.length === 0) return [];

    const offerIds = rows.map((r) => r.offer.id);
    const linkedTransactions = await db.select().from(transactions).where(inArray(transactions.acceptedOfferId, offerIds));
    const linkedOfferIds = new Set(linkedTransactions.map((t) => t.acceptedOfferId));

    const findings: RiskFinding[] = [];
    for (const { offer, property } of rows) {
      if (linkedOfferIds.has(offer.id)) continue;
      const dueDate = new Date(offer.createdAt.getTime() + 3 * 24 * 60 * 60 * 1000);
      const severity = severityForDeadline(now, dueDate, 0, 7);
      if (severity === "INFORMATION") continue; // still within the normal handoff window
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: C12_ACCEPTED_OFFER_NOT_LINKED.ruleId,
        ruleVersion: C12_ACCEPTED_OFFER_NOT_LINKED.version,
        category: "OFFERS",
        severity,
        title: "Accepted offer has no linked transaction",
        problemDescription: `Offer #${offer.id} was accepted on ${offer.createdAt.toDateString()} but no transaction has been created for it.`,
        businessImpact: "Without a linked transaction, contract preparation, conditions, AML/CTF, and settlement tracking cannot begin.",
        detectedCause: "offers.status = Accepted and no transactions row has acceptedOfferId = this offer.",
        ...owner,
        propertyId: property.id,
        transactionId: null,
        dueAt: dueDate,
        escalatesAt: escalatesAtFor(dueDate, 7),
        recommendedAction: "Create the transaction for this accepted offer through the authorised pathway.",
        resolutionRequirements: "A transactions row exists with acceptedOfferId equal to this offer's id.",
        dismissible: false,
        sourceRecordType: "offer",
        sourceRecordId: String(offer.id),
        dedupKey: dedupKey(C12_ACCEPTED_OFFER_NOT_LINKED.ruleId, brokerageId, offer.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { offerId: offer.id },
      });
    }
    return findings;
  },
};

interface AcceptedOfferRow {
  offer: Offer;
  property: Property;
}

const C13_MULTIPLE_OFFERS_ACCEPTED: RiskRule = {
  ruleId: "C13_MULTIPLE_OFFERS_ACCEPTED_FOR_PROPERTY",
  version: 1,
  category: "OFFERS",
  name: "Multiple offers accepted for one property",
  description: "More than one offer for the same property is currently status Accepted.",
  triggerEventTypes: ["OFFER_ACCEPTED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ offer: offers, property: properties })
      .from(offers)
      .innerJoin(properties, eq(offers.propertyId, properties.id))
      .where(and(eq(properties.brokerageId, brokerageId), eq(offers.status, "Accepted")));

    const byProperty = new Map<number, AcceptedOfferRow[]>();
    for (const row of rows) {
      const list = byProperty.get(row.property.id) ?? [];
      list.push(row);
      byProperty.set(row.property.id, list);
    }

    const findings: RiskFinding[] = [];
    for (const [propertyId, group] of byProperty) {
      if (group.length < 2) continue;
      const property = group[0].property;
      const owner = resolveDefaultOwner(property, false);
      findings.push({
        ruleId: C13_MULTIPLE_OFFERS_ACCEPTED.ruleId,
        ruleVersion: C13_MULTIPLE_OFFERS_ACCEPTED.version,
        category: "OFFERS",
        severity: "CRITICAL",
        title: "Multiple offers accepted for this property",
        problemDescription: `${group.length} offers are currently status Accepted for this property: ${group.map((r) => `#${r.offer.id}`).join(", ")}.`,
        businessImpact: "Only one offer can validly proceed to a transaction — this conflict must be resolved before contract preparation continues.",
        detectedCause: "More than one offers row for this property has status = Accepted.",
        ...owner,
        propertyId: property.id,
        transactionId: null,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Confirm which offer is actually proceeding and withdraw or decline the others through the authorised pathway.",
        resolutionRequirements: "No more than one offers row for this property remains status Accepted.",
        dismissible: false,
        sourceRecordType: "property",
        sourceRecordId: String(propertyId),
        dedupKey: dedupKey(C13_MULTIPLE_OFFERS_ACCEPTED.ruleId, brokerageId, propertyId),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { offerId: group.map((r) => String(r.offer.id)).join(",") },
      });
    }
    return findings;
  },
};

const C14_ACCEPTED_OFFER_TRANSACTION_MISMATCH: RiskRule = {
  ruleId: "C14_ACCEPTED_OFFER_TRANSACTION_DETAILS_CONFLICT",
  version: 1,
  category: "OFFERS",
  name: "Accepted offer details conflict with the linked transaction",
  description: "A transaction's purchase price or buyer does not match the accepted offer it was created from.",
  triggerEventTypes: ["CONTRACT_PREPARATION_STARTED", "OFFER_ACCEPTED"],
  async scanBrokerage(brokerageId, now) {
    const rows = await db
      .select({ transaction: transactions, property: properties })
      .from(transactions)
      .innerJoin(properties, eq(transactions.propertyId, properties.id))
      .where(and(eq(properties.brokerageId, brokerageId), isNotNull(transactions.acceptedOfferId)));
    if (rows.length === 0) return [];

    const offerIds = rows.map((r) => r.transaction.acceptedOfferId).filter((id): id is number => id !== null);
    const offerRows = offerIds.length ? await db.select().from(offers).where(inArray(offers.id, offerIds)) : [];

    const findings: RiskFinding[] = [];
    for (const { transaction, property } of rows) {
      const offer = offerRows.find((o) => o.id === transaction.acceptedOfferId);
      if (!offer) continue; // data-integrity gap outside this rule's scope — acceptedOfferId points nowhere

      const reasons: string[] = [];
      if (offer.offerPriceCents !== transaction.purchasePriceCents) reasons.push("purchase price differs from the accepted offer price");
      const buyerIds = (transaction.buyerPartyIds as number[] | null) ?? [];
      if (offer.buyerPartyId && !buyerIds.includes(offer.buyerPartyId)) reasons.push("the offer's buyer is not among the transaction's buyer parties");
      if (reasons.length === 0) continue;

      const owner = resolveDefaultOwner(property, true);
      findings.push({
        ruleId: C14_ACCEPTED_OFFER_TRANSACTION_MISMATCH.ruleId,
        ruleVersion: C14_ACCEPTED_OFFER_TRANSACTION_MISMATCH.version,
        category: "OFFERS",
        severity: "AT_RISK",
        title: "Transaction details conflict with the accepted offer",
        problemDescription: `Transaction #${transaction.id} conflicts with accepted offer #${offer.id}: ${reasons.join("; ")}.`,
        businessImpact: "A transaction that drifts from the offer it was created from risks an inaccurate contract and commission calculation.",
        detectedCause: "transactions row linked via acceptedOfferId does not match the offer's price and/or buyer.",
        ...owner,
        propertyId: property.id,
        transactionId: transaction.id,
        dueAt: null,
        escalatesAt: null,
        recommendedAction: "Reconcile the transaction's purchase price and buyer parties against the accepted offer, correcting whichever is wrong.",
        resolutionRequirements: "The transaction's purchasePriceCents matches the offer's offerPriceCents and the offer's buyer is included in buyerPartyIds.",
        dismissible: false,
        sourceRecordType: "transaction",
        sourceRecordId: String(transaction.id),
        dedupKey: dedupKey(C14_ACCEPTED_OFFER_TRANSACTION_MISMATCH.ruleId, brokerageId, transaction.id),
        recurrenceMode: "REOPEN",
        requiresFinancialEntitlement: false,
        metadata: { offerId: offer.id },
      });
    }
    return findings;
  },
};

export const OFFERS_RULES: RiskRule[] = [
  C10_OFFER_MISSING_BUYER_CONTACT,
  C12_ACCEPTED_OFFER_NOT_LINKED,
  C13_MULTIPLE_OFFERS_ACCEPTED,
  C14_ACCEPTED_OFFER_TRANSACTION_MISMATCH,
];
