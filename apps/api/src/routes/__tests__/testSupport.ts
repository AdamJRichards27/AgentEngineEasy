import { eq, inArray, and } from "drizzle-orm";
import { createHmac } from "node:crypto";
import {
  db,
  users,
  brokerages,
  parties,
  properties,
  propertyParties,
  workflows,
  workflowSteps,
  amlVerifications,
  serviceOrders,
  payments,
  paymentMethods,
  documentPackages,
  documents,
  documentObjectVersions,
  signatureRequests,
  agencyAgreementTerms,
  offers,
  transactions,
  transactionConditions,
  appraisals,
  automationTasks,
  automationAttentionItems,
  auditLogs,
  domainEvents,
  entitlementGrants,
  aiActionRequests,
  growRelationships,
  growActivities,
  growOpportunities,
  importJobs,
  importRecords,
  riskExceptions,
  riskExceptionTransitions,
  launchPlans,
  campaignItems,
  portalDestinations,
  vendorApprovals,
  launchPlanTransitions,
  pitCrewAssignments,
  communicationThreads,
  communicationParticipants,
  communicationMessages,
  communicationDeliveryAttempts,
  communicationTemplates,
  communicationConsent,
  communicationCostLedger,
  communicationSettings,
  communicationWebhookEvents,
  commissionAgreements,
  commissionCalculations,
  pcFeeAuthorities,
  pcFeeCalculations,
  financialPaymentRequests,
  financialPaymentProviderEvents,
  financialPaymentOutbox,
  financialDisputes,
  marketingPaymentRecords,
  financialDeposits,
  financialReconciliations,
  financialLedgerEvents,
  auditReturnReminders,
  financialSettings,
  integrationConnections,
  integrationConnectionTransitions,
  integrationOutbox,
  integrationOutboxAttempts,
  integrationInbox,
  integrationExternalMappings,
  integrationDeadLetters,
  integrationCredentials,
  integrationSettings,
} from "@aee/db";

// Foundation Remediation Stage 4: shared helpers for the new lifecycle test
// suites (properties/offers/transactions/aml/documents/home). Not itself a
// *.test.ts file, so tsx --test's glob does not pick it up as a test.

export function extractSessionCookie(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const match = raw.match(/aee_session=[^;]+/);
  if (!match) {
    throw new Error(`No aee_session cookie found in response headers: ${JSON.stringify(raw)}`);
  }
  return match[0];
}

export interface DevLoginUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  brokerageId: number;
  brokerageName: string | null;
}

export interface DevLoginResult {
  cookie: string;
  user: DevLoginUser;
}

export async function devLogin(
  baseUrl: string,
  input: { email: string; firstName: string; lastName: string; brokerageName: string },
): Promise<DevLoginResult> {
  const res = await fetch(`${baseUrl}/api/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`dev-login failed for ${input.email}: ${res.status} ${await res.text()}`);
  }
  const cookie = extractSessionCookie(res);
  const body = (await res.json()) as { user: DevLoginUser };
  return { cookie, user: body.user };
}

/** Two signed-in identities in the same fresh brokerage: the first (Brokerage Administrator) and second (Agent) dev-login. */
export async function createBrokerageWithUsers(
  baseUrl: string,
  brokerageName: string,
): Promise<{ admin: DevLoginResult; agent: DevLoginResult; brokerageId: number }> {
  const admin = await devLogin(baseUrl, {
    email: `admin-${brokerageName.replace(/\s+/g, "-").toLowerCase()}@example.com`,
    firstName: "Admin",
    lastName: "User",
    brokerageName,
  });
  const agent = await devLogin(baseUrl, {
    email: `agent-${brokerageName.replace(/\s+/g, "-").toLowerCase()}@example.com`,
    firstName: "Agent",
    lastName: "User",
    brokerageName,
  });
  return { admin, agent, brokerageId: admin.user.brokerageId };
}

/**
 * A second, independent Brokerage Administrator inside an ALREADY-EXISTING
 * brokerage. dev-login's own rule (routes/auth.ts) makes only the FIRST
 * ever sign-in to a given brokerage name a "Brokerage Administrator" --
 * every later sign-in to that same name becomes an "Agent" instead (see
 * createBrokerageWithUsers above, whose own doc comment names this exact
 * behaviour). Real separation-of-duties scenarios (Agent Engine 2.0 --
 * Financial Transaction Engine, Section 32/33: the same person cannot
 * both draft and approve/activate a financial authorisation) need a
 * second genuine admin account inside the SAME brokerage as an existing
 * admin, so this dev-logs the new user into a brand-new brokerage of
 * their own (making them that brokerage's first user, and therefore its
 * admin) and then moves them into the target brokerage directly in the
 * database, preserving their "Brokerage Administrator" role.
 * middlewares/auth.ts's loadSession re-derives req.authedUser from a
 * fresh per-request DB lookup rather than from anything cached in the
 * session cookie, so the move takes effect starting with this user's very
 * next request.
 */
export async function addSecondBrokerageAdmin(
  baseUrl: string,
  targetBrokerageId: number,
  input: { email: string; firstName: string; lastName: string; ownBrokerageName: string },
): Promise<DevLoginResult> {
  const result = await devLogin(baseUrl, {
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    brokerageName: input.ownBrokerageName,
  });
  await db.update(users).set({ brokerageId: targetBrokerageId }).where(eq(users.id, result.user.id));
  return { cookie: result.cookie, user: { ...result.user, brokerageId: targetBrokerageId } };
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON, got: ${res.status} ${text}`);
  }
}

/**
 * The mock AML provider is still authenticated exactly like a real
 * timestamped webhook.  Test suites which use this shared lifecycle helper
 * may not otherwise need AML configuration, so establish a sandbox-only
 * secret before constructing the signed request (without replacing an
 * explicitly configured test secret).
 */
function signedSandboxAmlWebhookHeaders(body: string): Record<string, string> {
  const secret = process.env.AML_WEBHOOK_SECRET ?? "test-only-aml-webhook-secret";
  process.env.AML_WEBHOOK_SECRET = secret;
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    "content-type": "application/json",
    "x-aml-timestamp": timestamp,
    "x-aml-signature": createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex"),
  };
}

/**
 * Drives a brand-new property all the way to `Listed` through the real
 * routes (Start Property -> add Seller -> Ready to List -> capture agency
 * terms -> populate -> send for signature -> simulate the e-sign webhook
 * completing -> simulate the AML webhook completing -> Go Live). Reused by
 * multiple test files so each one doesn't have to re-derive this sequence.
 */
export async function createListedProperty(
  baseUrl: string,
  cookie: string,
  opts?: { address?: string; sellerEmail?: string; state?: string },
): Promise<{ propertyId: number; sellerPartyId: number; packageId: number }> {
  const address = opts?.address ?? `${Math.floor(Math.random() * 100000)} Test Street, Testville`;
  const sellerEmail = opts?.sellerEmail ?? `seller-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`;
  const state = opts?.state ?? "NSW";

  const headers = { "content-type": "application/json", cookie };

  const propRes = await fetch(`${baseUrl}/api/properties`, {
    method: "POST",
    headers,
    body: JSON.stringify({ formattedAddress: address, state, suburb: "Testville", postcode: "2000" }),
  });
  if (propRes.status !== 201) throw new Error(`create property failed: ${propRes.status} ${await propRes.text()}`);
  const { property } = await json<{ property: { id: number } }>(propRes);
  const propertyId = property.id;

  const partyRes = await fetch(`${baseUrl}/api/parties`, {
    method: "POST",
    headers,
    body: JSON.stringify({ propertyId, role: "Seller", firstName: "Sam", lastName: "Seller", email: sellerEmail }),
  });
  if (partyRes.status !== 201) throw new Error(`add seller failed: ${partyRes.status} ${await partyRes.text()}`);
  const { party: sellerParty } = await json<{ party: { id: number } }>(partyRes);

  const rtlRes = await fetch(`${baseUrl}/api/properties/${propertyId}/ready-to-list`, { method: "POST", headers });
  if (rtlRes.status !== 200) throw new Error(`ready-to-list failed: ${rtlRes.status} ${await rtlRes.text()}`);
  const { documentPackage } = await json<{ documentPackage: { id: number } }>(rtlRes);
  const packageId = documentPackage.id;

  const termsRes = await fetch(`${baseUrl}/api/documents/agency-agreement-terms/${propertyId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ commissionType: "Percentage", commissionRateBps: 220, agreementTermDays: 90 }),
  });
  if (termsRes.status !== 200) throw new Error(`agency terms failed: ${termsRes.status} ${await termsRes.text()}`);

  const populateRes = await fetch(`${baseUrl}/api/documents/packages/${packageId}/populate`, { method: "POST", headers });
  if (populateRes.status !== 200) throw new Error(`populate failed: ${populateRes.status} ${await populateRes.text()}`);

  const sendRes = await fetch(`${baseUrl}/api/documents/packages/${packageId}/send-for-signature`, { method: "POST", headers });
  if (sendRes.status !== 201) throw new Error(`send-for-signature failed: ${sendRes.status} ${await sendRes.text()}`);
  const { signatureRequest } = await json<{ signatureRequest: { providerReference: string } }>(sendRes);
  const packageRes = await fetch(`${baseUrl}/api/documents/packages/by-property/${propertyId}`, { headers: { cookie } });
  if (packageRes.status !== 200) throw new Error(`get package documents failed: ${packageRes.status} ${await packageRes.text()}`);
  const { documents: packageDocuments } = await json<{ documents: Array<{ id: number; title: string }> }>(packageRes);
  const completedDocuments = packageDocuments.map((document) => ({
    documentId: document.id,
    contentBase64: Buffer.from(`Signed document: ${document.title}\n`, "utf8").toString("base64"),
    filename: `${document.title.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`,
    contentType: "text/plain",
  }));

  const esignWebhookRes = await fetch(`${baseUrl}/api/documents/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ providerReference: signatureRequest.providerReference, status: "Completed", completedDocuments }),
  });
  if (esignWebhookRes.status !== 200) throw new Error(`esign webhook failed: ${esignWebhookRes.status} ${await esignWebhookRes.text()}`);

  const amlListRes = await fetch(`${baseUrl}/api/aml/by-property/${propertyId}`, { headers: { cookie } });
  const { verifications } = await json<{ verifications: Array<{ providerReference: string }> }>(amlListRes);
  if (verifications.length === 0) throw new Error("expected at least one AML verification");

  for (const v of verifications) {
    const amlWebhookBody = JSON.stringify({ providerReference: v.providerReference, outcome: "VERIFIED", reviewRequired: false });
    const amlWebhookRes = await fetch(`${baseUrl}/api/aml/webhook`, {
      method: "POST",
      headers: signedSandboxAmlWebhookHeaders(amlWebhookBody),
      body: amlWebhookBody,
    });
    if (amlWebhookRes.status !== 200) throw new Error(`aml webhook failed: ${amlWebhookRes.status} ${await amlWebhookRes.text()}`);
  }

  const goLiveRes = await fetch(`${baseUrl}/api/properties/${propertyId}/go-live`, { method: "POST", headers });
  if (goLiveRes.status !== 200) throw new Error(`go-live failed: ${goLiveRes.status} ${await goLiveRes.text()}`);
  const { property: listed } = await json<{ property: { listingStatus: string } }>(goLiveRes);
  if (listed.listingStatus !== "Listed") throw new Error(`expected Listed, got ${listed.listingStatus}`);

  return { propertyId, sellerPartyId: sellerParty.id, packageId };
}

/**
 * Run Transaction Vertical Slice (#124) — extends createListedProperty by
 * recording a buyer offer and accepting it through the real acceptOffer
 * chokepoint (POST /offers/:id/accept), producing a real Transaction. Used
 * by every Stage D+ test (contract, conditions, exchange/unconditional,
 * settlement, closure) so each one doesn't have to re-derive the same
 * property -> offer -> accepted-transaction path.
 */
export async function createTransactionFromListedProperty(
  baseUrl: string,
  cookie: string,
  opts?: {
    address?: string;
    sellerEmail?: string;
    state?: string;
    offerPriceCents?: number;
    depositCents?: number;
    settlementDate?: string;
    conditionsText?: string;
  },
): Promise<{ propertyId: number; sellerPartyId: number; offerId: number; transactionId: number }> {
  const { propertyId, sellerPartyId } = await createListedProperty(baseUrl, cookie, opts);
  const headers = { "content-type": "application/json", cookie };

  const offerRes = await fetch(`${baseUrl}/api/offers/by-property/${propertyId}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      offerPriceCents: opts?.offerPriceCents ?? 80000000,
      conditions: {
        depositCents: opts?.depositCents ?? 4000000,
        settlementDate: opts?.settlementDate ?? "2027-01-15",
        conditions: opts?.conditionsText ?? "Subject to finance",
        additionalTerms: "Standard terms",
      },
      buyer: {
        firstName: "Bob",
        lastName: "Buyer",
        email: `buyer-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`,
      },
    }),
  });
  if (offerRes.status !== 201) throw new Error(`create offer failed: ${offerRes.status} ${await offerRes.text()}`);
  const { offer } = await json<{ offer: { id: number } }>(offerRes);

  const acceptRes = await fetch(`${baseUrl}/api/offers/${offer.id}/accept`, { method: "POST", headers });
  if (acceptRes.status !== 201) throw new Error(`accept offer failed: ${acceptRes.status} ${await acceptRes.text()}`);
  const { transaction } = await json<{ transaction: { id: number } }>(acceptRes);

  return { propertyId, sellerPartyId, offerId: offer.id, transactionId: transaction.id };
}

export async function getDomainEventsForProperty(propertyId: number, eventType?: string) {
  const rows = await db.select().from(domainEvents).where(eq(domainEvents.propertyId, propertyId));
  return eventType ? rows.filter((r) => r.eventType === eventType) : rows;
}

/**
 * Deletes every row this test suite could plausibly have created, scoped to
 * the given brokerage ids — mirrors auth.test.ts's after() hook but covers
 * every table Stage 4's new tests touch. Deletion order respects the FK
 * graph (children before parents). Never touches rows outside the given
 * brokerage ids, so the two pre-existing real users/brokerage are untouched.
 *
 * Run Transaction Vertical Slice (#124): extended to also delete
 * appraisals, transactionConditions, automationTasks, and
 * automationAttentionItems — all four carry non-cascading ("ON DELETE no
 * action") FKs onto properties/transactions (see
 * packages/db/src/schema/appraisal.ts, migration 0003, and
 * packages/db/src/schema/automation.ts), so a test that exercises any of
 * Stage A/E/#122 and then relies on this cleanup would otherwise fail with
 * a foreign key violation on the transactions/properties delete below.
 *
 * Exception & Risk Engine (Priority 4): extended again for
 * riskExceptionTransitions/riskExceptions — riskExceptionTransitions.exceptionId
 * -> riskExceptions.id and riskExceptions.propertyId/transactionId ->
 * properties.id/transactions.id are all non-cascading (see
 * packages/db/src/schema/exceptions.ts), so both must be deleted before the
 * transactions delete and the properties delete further down this block.
 *
 * Agent Engine 2.0 — Property Launch & Campaign Coordination: extended
 * again for launch_plan_transitions / vendor_approvals / campaign_items /
 * portal_destinations / launch_plans — all five carry non-cascading FKs
 * onto properties.id (launch_plans directly; the other four transitively
 * via launch_plans.id — see packages/db/src/schema/launch.ts), so all must
 * be deleted before the properties delete further down this block.
 *
 * Agent Engine 2.0 — Communications Hub (Priority 8): extended again for
 * every communications table. All of them carry brokerageId directly
 * (packages/db/src/schema/communications.ts) so this new block is scoped
 * by `ids` alone, independent of propertyIds — but the internal ordering
 * still matters: communicationWebhookEvents.relatedMessageId and
 * communicationDeliveryAttempts.messageId both reference
 * communicationMessages.id (non-cascading), and communicationMessages
 * itself references communicationParticipants.id/communicationTemplates.id
 * (also non-cascading), so both must be cleared before communicationMessages
 * is deleted, which itself must be cleared before
 * communicationParticipants/communicationThreads/communicationTemplates.
 * Placed early (before the properties/transactions block) since
 * communicationThreads.propertyId is a required, non-cascading FK onto
 * properties.id.
 *
 * Agent Engine 2.0 — Financial Transaction Engine (Priority 9): extended
 * again for every financial.ts table. All of them carry brokerageId
 * directly (packages/db/src/schema/financial.ts) so this block is scoped
 * by `ids` alone, independent of propertyIds/transactionIds — but several
 * also carry non-cascading FKs onto transactions.id/properties.id
 * (commissionAgreements, commissionCalculations, pcFeeCalculations,
 * financialPaymentRequests, financialDeposits, financialLedgerEvents), so
 * this whole block must run (like the communications block above) before
 * the properties/transactions deletes further down. Internal ordering:
 * financialPaymentProviderEvents, financialDisputes, AND (Stage D)
 * financialPaymentOutbox all reference financialPaymentRequests.id (must
 * go first); financialPaymentRequests references
 * pcFeeCalculations.id/pcFeeAuthorities.id (must go before those);
 * pcFeeCalculations references commissionCalculations.id (must go before
 * commissionCalculations); commissionCalculations references
 * commissionAgreements.id (must go before commissionAgreements); and
 * pcFeeAuthorities.agentUserId -> users.id (non-cascading), so it must be
 * cleared before the users delete near the end of this function too.
 */
export async function cleanupBrokerages(brokerageIds: number[]): Promise<void> {
  const ids = brokerageIds.filter((id): id is number => typeof id === "number" && Number.isFinite(id));
  if (ids.length === 0) return;

  // Agent Engine 2.0 — Financial Transaction Engine (Priority 9). See this
  // function's own doc comment above for the FK ordering this block
  // depends on.
  const financialPaymentRequestRows = await db
    .select({ id: financialPaymentRequests.id })
    .from(financialPaymentRequests)
    .where(inArray(financialPaymentRequests.brokerageId, ids));
  const financialPaymentRequestIds = financialPaymentRequestRows.map((r) => r.id);
  if (financialPaymentRequestIds.length > 0) {
    await db.delete(financialPaymentProviderEvents).where(inArray(financialPaymentProviderEvents.paymentRequestId, financialPaymentRequestIds));
    await db.delete(financialDisputes).where(inArray(financialDisputes.paymentRequestId, financialPaymentRequestIds));
    // Stage D (Section 31) — financial_payment_outbox.payment_request_id ->
    // financial_payment_requests.id, non-cascading. Must be cleared before
    // the financialPaymentRequests delete just below, exactly like the two
    // siblings above.
    await db.delete(financialPaymentOutbox).where(inArray(financialPaymentOutbox.paymentRequestId, financialPaymentRequestIds));
  }
  await db.delete(financialPaymentRequests).where(inArray(financialPaymentRequests.brokerageId, ids));
  await db.delete(pcFeeCalculations).where(inArray(pcFeeCalculations.brokerageId, ids));
  await db.delete(pcFeeAuthorities).where(inArray(pcFeeAuthorities.brokerageId, ids));
  await db.delete(commissionCalculations).where(inArray(commissionCalculations.brokerageId, ids));
  await db.delete(commissionAgreements).where(inArray(commissionAgreements.brokerageId, ids));
  await db.delete(marketingPaymentRecords).where(inArray(marketingPaymentRecords.brokerageId, ids));
  await db.delete(financialDeposits).where(inArray(financialDeposits.brokerageId, ids));
  await db.delete(financialReconciliations).where(inArray(financialReconciliations.brokerageId, ids));
  await db.delete(financialLedgerEvents).where(inArray(financialLedgerEvents.brokerageId, ids));
  await db.delete(auditReturnReminders).where(inArray(auditReturnReminders.brokerageId, ids));
  await db.delete(financialSettings).where(inArray(financialSettings.brokerageId, ids));

  // Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
  // Every integration_* table carries brokerageId directly EXCEPT
  // integration_outbox_attempts (only outboxId -> integration_outbox.id)
  // and integration_credentials (only connectionId -> integration_connections.id
  // — see packages/db/src/schema/integrations.ts). integration_inbox must
  // be cleared before integration_outbox (inbox.relatedOutboxId ->
  // outbox.id, non-cascading); integration_connections.requestedBy ->
  // users.id NOT NULL non-cascading, so this whole block must run (like
  // every block above) before the users delete near the end of this function.
  const integrationConnectionRows = await db.select({ id: integrationConnections.id }).from(integrationConnections).where(inArray(integrationConnections.brokerageId, ids));
  const integrationConnectionIds = integrationConnectionRows.map((c) => c.id);
  const integrationOutboxRows = await db.select({ id: integrationOutbox.id }).from(integrationOutbox).where(inArray(integrationOutbox.brokerageId, ids));
  const integrationOutboxIds = integrationOutboxRows.map((o) => o.id);
  if (integrationOutboxIds.length > 0) {
    await db.delete(integrationOutboxAttempts).where(inArray(integrationOutboxAttempts.outboxId, integrationOutboxIds));
  }
  await db.delete(integrationInbox).where(inArray(integrationInbox.brokerageId, ids));
  await db.delete(integrationDeadLetters).where(inArray(integrationDeadLetters.brokerageId, ids));
  await db.delete(integrationExternalMappings).where(inArray(integrationExternalMappings.brokerageId, ids));
  await db.delete(integrationOutbox).where(inArray(integrationOutbox.brokerageId, ids));
  if (integrationConnectionIds.length > 0) {
    await db.delete(integrationCredentials).where(inArray(integrationCredentials.connectionId, integrationConnectionIds));
  }
  await db.delete(integrationConnectionTransitions).where(inArray(integrationConnectionTransitions.brokerageId, ids));
  await db.delete(integrationConnections).where(inArray(integrationConnections.brokerageId, ids));
  await db.delete(integrationSettings).where(inArray(integrationSettings.brokerageId, ids));

  // Agent Engine 2.0 — Communications Hub (Priority 8). See this function's
  // own doc comment above for the FK ordering this block depends on.
  const communicationMessageRows = await db.select({ id: communicationMessages.id }).from(communicationMessages).where(inArray(communicationMessages.brokerageId, ids));
  const communicationMessageIds = communicationMessageRows.map((m) => m.id);
  if (communicationMessageIds.length > 0) {
    await db.delete(communicationWebhookEvents).where(inArray(communicationWebhookEvents.relatedMessageId, communicationMessageIds));
    await db.delete(communicationDeliveryAttempts).where(inArray(communicationDeliveryAttempts.messageId, communicationMessageIds));
  }
  await db.delete(communicationMessages).where(inArray(communicationMessages.brokerageId, ids));

  const communicationThreadRows = await db.select({ id: communicationThreads.id }).from(communicationThreads).where(inArray(communicationThreads.brokerageId, ids));
  const communicationThreadIds = communicationThreadRows.map((t) => t.id);
  if (communicationThreadIds.length > 0) {
    await db.delete(communicationParticipants).where(inArray(communicationParticipants.threadId, communicationThreadIds));
  }
  await db.delete(communicationThreads).where(inArray(communicationThreads.brokerageId, ids));

  await db.delete(communicationTemplates).where(inArray(communicationTemplates.brokerageId, ids));
  await db.delete(communicationConsent).where(inArray(communicationConsent.brokerageId, ids));
  await db.delete(communicationCostLedger).where(inArray(communicationCostLedger.brokerageId, ids));
  await db.delete(communicationSettings).where(inArray(communicationSettings.brokerageId, ids));

  // F-05: Import (import_records / import_jobs) rows are deleted first, ahead
  // of both the Grow tables below and the existing property cascade --
  // import_records carries non-cascading FKs onto parties/properties/
  // grow_relationships for rows the import pipeline itself created (see
  // packages/db/src/schema/import.ts), so it must run before those deletes;
  // import_jobs itself only depends on brokerages/users.
  const importJobRows = await db.select({ id: importJobs.id }).from(importJobs).where(inArray(importJobs.brokerageId, ids));
  const importJobIds = importJobRows.map((j) => j.id);
  if (importJobIds.length > 0) {
    await db.delete(importRecords).where(inArray(importRecords.importJobId, importJobIds));
  }
  await db.delete(importJobs).where(inArray(importJobs.brokerageId, ids));

  // F-05: Grow (grow_activities / grow_opportunities / grow_relationships) rows are deleted
  // first and scoped directly by brokerageId -- all three have non-cascading FKs onto
  // parties/properties (see packages/db/src/schema/grow.ts), and grow_activities additionally
  // references grow_opportunities.id, so this order (activities, then opportunities, then
  // relationships) must run before parties/properties are deleted below or the deletes there
  // fail with a foreign key violation instead of silently succeeding.
  await db.delete(growActivities).where(inArray(growActivities.brokerageId, ids));
  await db.delete(growOpportunities).where(inArray(growOpportunities.brokerageId, ids));
  await db.delete(growRelationships).where(inArray(growRelationships.brokerageId, ids));

  // #122 — both tables carry brokerageId directly, and their FKs onto
  // properties/transactions are non-cascading, so this must run before the
  // properties/transactions deletes below.
  await db.delete(automationTasks).where(inArray(automationTasks.brokerageId, ids));
  await db.delete(automationAttentionItems).where(inArray(automationAttentionItems.brokerageId, ids));

  // Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7). pit_crew_assignments
  // carries brokerageId directly and FKs onto brokerages/properties/users, all
  // non-cascading, so (like automationTasks/automationAttentionItems above) it
  // must be cleared before those tables are deleted below.
  await db.delete(pitCrewAssignments).where(inArray(pitCrewAssignments.brokerageId, ids));

  const propertyRows = await db.select().from(properties).where(inArray(properties.brokerageId, ids));
  const propertyIds = propertyRows.map((p) => p.id);

  if (propertyIds.length > 0) {
    // Exception & Risk Engine (Priority 4) — see this function's own doc
    // comment above. Scoped by propertyId alone (every riskExceptions row
    // has a non-null propertyId, per packages/db/src/schema/exceptions.ts)
    // rather than needing the transactionIds lookup further down, since
    // riskExceptions.transactionId is nullable.
    const riskExceptionRows = await db.select({ id: riskExceptions.id }).from(riskExceptions).where(inArray(riskExceptions.propertyId, propertyIds));
    const riskExceptionIds = riskExceptionRows.map((r) => r.id);
    if (riskExceptionIds.length > 0) {
      await db.delete(riskExceptionTransitions).where(inArray(riskExceptionTransitions.exceptionId, riskExceptionIds));
    }
    await db.delete(riskExceptions).where(inArray(riskExceptions.propertyId, propertyIds));

    // Agent Engine 2.0 — Property Launch & Campaign Coordination. Scoped
    // by launch_plans.id (every one of the four child tables carries
    // launch_plan_id directly) rather than by propertyId on each child
    // table, since that's the FK they actually declare — see this
    // function's own doc comment above.
    const launchPlanRows = await db.select({ id: launchPlans.id }).from(launchPlans).where(inArray(launchPlans.propertyId, propertyIds));
    const launchPlanIds = launchPlanRows.map((p) => p.id);
    if (launchPlanIds.length > 0) {
      await db.delete(launchPlanTransitions).where(inArray(launchPlanTransitions.launchPlanId, launchPlanIds));
      await db.delete(vendorApprovals).where(inArray(vendorApprovals.launchPlanId, launchPlanIds));
      await db.delete(campaignItems).where(inArray(campaignItems.launchPlanId, launchPlanIds));
      await db.delete(portalDestinations).where(inArray(portalDestinations.launchPlanId, launchPlanIds));
    }
    await db.delete(launchPlans).where(inArray(launchPlans.propertyId, propertyIds));

    // Stage A (#114) — appraisals.propertyId -> properties.id, non-cascading.
    await db.delete(appraisals).where(inArray(appraisals.propertyId, propertyIds));

    // Stage E (#118) — transaction_conditions.transaction_id ->
    // transactions.id, non-cascading (migration 0003). Must run before the
    // transactions delete further down.
    const transactionRows = await db.select({ id: transactions.id }).from(transactions).where(inArray(transactions.propertyId, propertyIds));
    const transactionIds = transactionRows.map((t) => t.id);
    if (transactionIds.length > 0) {
      await db.delete(transactionConditions).where(inArray(transactionConditions.transactionId, transactionIds));
    }

    const packageRows = await db.select().from(documentPackages).where(inArray(documentPackages.propertyId, propertyIds));
    const packageIds = packageRows.map((p) => p.id);
    if (packageIds.length > 0) {
      await db.delete(signatureRequests).where(inArray(signatureRequests.packageId, packageIds));
    }
    await db.delete(documentObjectVersions).where(inArray(documentObjectVersions.propertyId, propertyIds));
    await db.delete(documents).where(inArray(documents.propertyId, propertyIds));
    await db.delete(documentPackages).where(inArray(documentPackages.propertyId, propertyIds));
    await db.delete(amlVerifications).where(inArray(amlVerifications.propertyId, propertyIds));

    // Payments IDOR fix regression coverage (routes/payments.ts,
    // lib/payments.ts): payments.serviceOrderId -> serviceOrders.id is a
    // required, non-cascading FK (packages/db/src/schema/commerce.ts), so
    // any payment row a test created against one of this brokerage's
    // service orders must be cleared before the serviceOrders delete just
    // below, or that delete fails with a foreign key violation.
    const serviceOrderRows = await db.select({ id: serviceOrders.id }).from(serviceOrders).where(inArray(serviceOrders.propertyId, propertyIds));
    const serviceOrderIds = serviceOrderRows.map((s) => s.id);
    if (serviceOrderIds.length > 0) {
      await db.delete(payments).where(inArray(payments.serviceOrderId, serviceOrderIds));
    }
    await db.delete(serviceOrders).where(inArray(serviceOrders.propertyId, propertyIds));

    const workflowRows = await db.select().from(workflows).where(inArray(workflows.propertyId, propertyIds));
    const workflowIds = workflowRows.map((w) => w.id);
    if (workflowIds.length > 0) {
      await db.delete(workflowSteps).where(inArray(workflowSteps.workflowId, workflowIds));
    }
    await db.delete(workflows).where(inArray(workflows.propertyId, propertyIds));

    await db.delete(transactions).where(inArray(transactions.propertyId, propertyIds));
    await db.delete(offers).where(inArray(offers.propertyId, propertyIds));
    await db.delete(propertyParties).where(inArray(propertyParties.propertyId, propertyIds));
    await db.delete(agencyAgreementTerms).where(inArray(agencyAgreementTerms.propertyId, propertyIds));
    await db.delete(auditLogs).where(inArray(auditLogs.propertyId, propertyIds));
    await db.delete(domainEvents).where(inArray(domainEvents.propertyId, propertyIds));
    // A full-suite exception scan can discover these fixtures after the
    // earlier riskExceptions cleanup. Lock the parent rows, remove any late
    // scan output, and delete the properties in one transaction so a
    // concurrent FK insert cannot race between those operations.
    await db.transaction(async (tx) => {
      await tx
        .select({ id: properties.id })
        .from(properties)
        .where(inArray(properties.id, propertyIds))
        .for("update");
      const lateRiskRows = await tx
        .select({ id: riskExceptions.id })
        .from(riskExceptions)
        .where(inArray(riskExceptions.propertyId, propertyIds));
      const lateRiskIds = lateRiskRows.map((row) => row.id);
      if (lateRiskIds.length > 0) {
        await tx
          .delete(riskExceptionTransitions)
          .where(inArray(riskExceptionTransitions.exceptionId, lateRiskIds));
      }
      await tx
        .delete(riskExceptions)
        .where(inArray(riskExceptions.propertyId, propertyIds));
      await tx.delete(properties).where(inArray(properties.id, propertyIds));
    });
  }

  await db.delete(entitlementGrants).where(inArray(entitlementGrants.brokerageId, ids));
  await db.delete(aiActionRequests).where(inArray(aiActionRequests.brokerageId, ids));
  await db.delete(domainEvents).where(inArray(domainEvents.brokerageId, ids));
  await db.delete(parties).where(inArray(parties.brokerageId, ids));

  // Payments IDOR fix regression coverage: paymentMethods.payerId is
  // polymorphic (a userId for payerType "Agent", a brokerageId for
  // payerType "Brokerage" — see packages/db/src/schema/commerce.ts), not a
  // real FK, so nothing forces this cleanup before the users/brokerages
  // deletes below the way payments/serviceOrders did above. Still done here
  // (userIds captured before the users delete, right below) purely so
  // repeated local test runs don't accumulate stray rows.
  const userRows = await db.select({ id: users.id }).from(users).where(inArray(users.brokerageId, ids));
  const userIds = userRows.map((u) => u.id);
  if (userIds.length > 0) {
    await db.delete(paymentMethods).where(and(eq(paymentMethods.payerType, "Agent"), inArray(paymentMethods.payerId, userIds)));
  }
  await db.delete(paymentMethods).where(and(eq(paymentMethods.payerType, "Brokerage"), inArray(paymentMethods.payerId, ids)));

  await db.delete(users).where(inArray(users.brokerageId, ids));
  await db.delete(brokerages).where(inArray(brokerages.id, ids));
}
