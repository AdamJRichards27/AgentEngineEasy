// Agent Engine 2.0 — AE Step 5 remediation.
//
// A small, generic registry mapping an integrationOutbox row's
// sourceRecordType (e.g. "communication_message", "portal_destination") to
// the property/transaction it belongs to. Exists for exactly one consumer:
// lib/exceptions/rules/integrationOperational.ts (Proof D) — a dead-lettered
// integration command has no propertyId/transactionId column of its own
// (Section 4: the outbox is provider-neutral, it doesn't know what a
// "property" is), but riskExceptions.propertyId is NOT NULL, so a risk
// finding for a dead-lettered command needs a way to resolve one, generic
// across every domain proof, without integrationOperational.ts importing
// every domain's own model module directly (which would make the exceptions
// package depend on communications/financial/launch internals — the
// resolver pattern here is the inversion that avoids that).
//
// Each domain proof registers its own resolver for the sourceRecordType(s)
// it owns (commsProof.ts -> "communication_message", financialProof.ts ->
// "financial_payment_request") at the same bootstrap point it registers its
// webhook effect handler. A sourceRecordType with no registered resolver
// (or whose resolver returns null — cross-tenant/not-found) is simply
// skipped by the rule, mirroring rules/workflowOperational.ts's own G36
// "skip a row whose triggering event has no propertyId" discipline rather
// than guessing.

export interface IntegrationSourceRecordResolution {
  propertyId: number;
  transactionId: number | null;
}

export type IntegrationSourceRecordResolver = (brokerageId: number, sourceRecordId: string) => Promise<IntegrationSourceRecordResolution | null>;

const resolvers = new Map<string, IntegrationSourceRecordResolver>();

export function registerIntegrationSourceRecordResolver(sourceRecordType: string, resolver: IntegrationSourceRecordResolver): void {
  resolvers.set(sourceRecordType, resolver);
}

export async function resolveIntegrationSourceRecord(
  sourceRecordType: string,
  brokerageId: number,
  sourceRecordId: string,
): Promise<IntegrationSourceRecordResolution | null> {
  const resolver = resolvers.get(sourceRecordType);
  if (!resolver) return null;
  try {
    return await resolver(brokerageId, sourceRecordId);
  } catch (err) {
    console.error(`resolveIntegrationSourceRecord: resolver for ${sourceRecordType} threw`, err);
    return null;
  }
}

export function clearIntegrationSourceRecordResolversForTesting(): void {
  resolvers.clear();
}
