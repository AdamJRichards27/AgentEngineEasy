import { and, eq } from "drizzle-orm";
import {
  db,
  properties,
  propertyParties,
  parties,
  documents,
  appraisals,
  appraisalComparableSales,
  appraisalMarketCompetition,
  users,
  brokerages,
} from "@aee/db";
import type {
  Appraisal,
  AppraisalComparableSale,
  AppraisalMarketCompetition,
} from "@aee/db";
import { logger } from "@aee/events";
import { logAudit } from "./audit.js";
import {
  noteGrowComparableSaleIsolationRejection,
  noteGrowMarketCompetitionIsolationRejection,
  noteGrowPartyIsolationRejection,
} from "./grow/isolationRejection.js";
import { enforceAppraisalPricingRule } from "./appraisalFinaliseGuard.js";
import {
  assertAppraisalInBrokerage,
  getAppraisalWorkspace,
  transitionAppraisalStatus,
  AppraisalAccessError,
} from "./growAppraisals.js";
import {
  createThread,
  createDraftMessage,
  listThreadsForParty,
  requiresApproval,
  requestApproval,
  sendMessageNow,
} from "./communications/messages.js";
import {
  getContactRecipientCandidate,
  addParticipantFromParty,
  partyDisplayName as computePartyDisplayName,
} from "./communications/recipientResolution.js";
import { askCopilot } from "./ai/orchestrator.js";
import { ingestDocumentVersion } from "./documentStorage.js";

/* ---------------------------------------------------------------------
 * AE GROW Priority 4 -- Appraisal Workspace integrations layer.
 *
 * growAppraisals.ts owns the appraisal's own lifecycle (creation,
 * editing, status transitions, outcome, follow-up, pipeline listing).
 * This file is everything that reaches OUT of the appraisal into an
 * already-canonical AE system -- Communications Hub (Sec 15), the
 * governed AI Copilot (Sec 12), the documents/document-storage
 * infrastructure (Sec 13/14), and the property/Run boundary
 * (Sec 19/20) -- so none of those systems gets a second, Grow-only
 * implementation.
 * -----------------------------------------------------------------*/

/* ---------------------------------------------------------------------
 * Sec 15 -- Send Appraisal via the canonical Communications Hub.
 * -----------------------------------------------------------------*/
export interface SendAppraisalInput {
  appraisalId: number;
  brokerageId: number;
  userId: number;
  subject?: string;
  bodyText?: string;
}

export interface SendAppraisalResult {
  threadId: number;
  messageId: number;
  status: "sent" | "pending_approval";
}

export async function sendAppraisal(input: SendAppraisalInput): Promise<SendAppraisalResult> {
  const appraisal = await assertAppraisalInBrokerage(input.appraisalId, input.brokerageId);
  if (!appraisal.partyId) {
    throw new AppraisalAccessError("This appraisal has no linked contact to send to.");
  }

  const [property] = await db.select().from(properties).where(eq(properties.id, appraisal.propertyId));

  const candidate = await getContactRecipientCandidate(appraisal.partyId, input.brokerageId);
  if (!candidate || (!candidate.email && !candidate.mobile)) {
    throw new AppraisalAccessError("The linked contact has no email or mobile on file to send the appraisal to.");
  }

  // Reuse an existing thread for this contact+property pair rather than
  // spawning a new one on every send (Sec 16 -- avoid noisy duplication).
  const existingThreads = await listThreadsForParty(appraisal.partyId, input.brokerageId);
  let thread = existingThreads.find((t) => t.propertyId === appraisal.propertyId) ?? null;
  if (!thread) {
    thread = await createThread({
      brokerageId: input.brokerageId,
      propertyId: appraisal.propertyId,
      partyId: appraisal.partyId,
      subject: input.subject ?? `Your property appraisal${property ? ` -- ${property.formattedAddress}` : ""}`,
      createdByUserId: input.userId,
    });
  }

  const participant = await addParticipantFromParty({
    threadId: thread.id,
    brokerageId: input.brokerageId,
    partyId: appraisal.partyId,
    role: "Client",
    addedByUserId: input.userId,
  });

  const channel: "EMAIL" | "SMS" = candidate.email ? "EMAIL" : "SMS";
  const bodyText = input.bodyText ?? buildAppraisalMessageBody(appraisal, property ?? null);

  const message = await createDraftMessage({
    threadId: thread.id,
    brokerageId: input.brokerageId,
    channel,
    classification: "SERVICE",
    subject: input.subject ?? "Your property appraisal",
    bodyText,
    senderUserId: input.userId,
    recipientParticipantId: participant.id,
    createdByUserId: input.userId,
  });

  let status: "sent" | "pending_approval";
  if (requiresApproval(message)) {
    await requestApproval(message.id, input.brokerageId, input.userId, message.version);
    status = "pending_approval";
  } else {
    await sendMessageNow(message.id, input.brokerageId, input.userId, message.version);
    status = "sent";
  }

  // Sec 6 -- SENT is only reachable from a subset of prior statuses; an
  // appraisal that has already moved past SENT (e.g. re-sending after
  // PRESENTED) simply keeps its current, more-advanced status rather
  // than erroring the whole send out.
  // B-5: a SERVICE appraisal message now waits for someone other than the
  // sender. Do not record the appraisal as SENT until the message itself
  // has been sent.
  if (status === "sent") {
    try {
      await transitionAppraisalStatus({
        appraisalId: appraisal.id,
        brokerageId: input.brokerageId,
        userId: input.userId,
        toStatus: "SENT",
      });
    } catch (err) {
      logger.error("appraisal_send_status_transition_skipped", { appraisalId: appraisal.id, error: err });
    }
  }

  return { threadId: thread.id, messageId: message.id, status };
}

function buildAppraisalMessageBody(
  appraisal: Appraisal,
  property: { formattedAddress: string } | null,
): string {
  const address = property?.formattedAddress ?? "your property";
  const lines = [`Hi,`, ``, `Please find your property appraisal for ${address} below.`];
  if (appraisal.priceRangeLow && appraisal.priceRangeHigh) {
    const currency = appraisal.priceRangeCurrency ?? "AUD";
    lines.push(``, `Recommended market position: ${currency} ${appraisal.priceRangeLow} - ${currency} ${appraisal.priceRangeHigh}`);
  }
  lines.push(``, `Let us know if you have any questions.`);
  return lines.join("\n");
}

/* ---------------------------------------------------------------------
 * Sec 12 -- AI-assisted Market Position drafting via the existing,
 * governed Copilot orchestrator (Level 0 read-only ceiling, full audit
 * trail, entitlement/feature-flag checks all already enforced inside
 * askCopilot()). The prompt embeds only the agent's own authorised
 * data already entered on this appraisal -- comparable sales, market
 * competition, and the agent's own price range -- and explicitly
 * instructs the model not to introduce any other fact, so this cannot
 * invent a comparable sale or a price the agent did not enter (Sec 12).
 * -----------------------------------------------------------------*/
export interface GenerateMarketPositionInput {
  appraisalId: number;
  brokerageId: number;
  userId: number;
  userRole: string;
}

export interface GenerateMarketPositionResult {
  draftNarrative: string;
  requestId: string;
}

export async function generateMarketPositionDraft(
  input: GenerateMarketPositionInput,
): Promise<GenerateMarketPositionResult> {
  const workspace = await getAppraisalWorkspace(input.appraisalId, input.brokerageId);
  const { appraisal, comparableSales, marketCompetition } = workspace;

  const [property] = await db.select().from(properties).where(eq(properties.id, appraisal.propertyId));

  const question = buildMarketPositionPrompt(appraisal, property ?? null, comparableSales, marketCompetition);

  const result = await askCopilot({
    brokerageId: input.brokerageId,
    userId: input.userId,
    userRole: input.userRole,
    question,
    contextType: "property",
    contextId: appraisal.propertyId,
  });

  const draftNarrative = [result.response.summary, ...result.response.details].filter(Boolean).join("\n\n");

  await logAudit({
    userId: input.userId,
    action: "appraisal_market_position_ai_drafted",
    recordType: "appraisal",
    recordId: String(appraisal.id),
    propertyId: appraisal.propertyId,
  });

  return { draftNarrative, requestId: result.requestId };
}

function buildMarketPositionPrompt(
  appraisal: Appraisal,
  property: { formattedAddress: string } | null,
  comparableSales: AppraisalComparableSale[],
  marketCompetition: AppraisalMarketCompetition[],
): string {
  const lines: string[] = [
    "Draft a short, professional market position summary and a one-paragraph selling strategy for a real estate appraisal, using ONLY the data listed below.",
    "Do not invent, assume, or reference any comparable sale, competing listing, price, or fact that is not explicitly listed here. If a section has no data, say so plainly instead of making something up.",
    "",
    `Property: ${property?.formattedAddress ?? "(address not on file)"}`,
  ];
  if (appraisal.priceRangeLow && appraisal.priceRangeHigh) {
    const currency = appraisal.priceRangeCurrency ?? "AUD";
    lines.push(`Agent's recommended price range: ${currency} ${appraisal.priceRangeLow} - ${currency} ${appraisal.priceRangeHigh}`);
  }
  lines.push("", "Comparable sales on file:");
  if (comparableSales.length === 0) {
    lines.push("(none entered)");
  } else {
    for (const sale of comparableSales) {
      const sold = sale.saleDate ? ` (sold ${new Date(sale.saleDate).toISOString().slice(0, 10)})` : "";
      const notes = sale.notes ? ` -- ${sale.notes}` : "";
      lines.push(`- ${sale.address}: ${sale.salePrice ?? "price n/a"}${sold}${notes}`);
    }
  }
  lines.push("", "Current market competition on file:");
  if (marketCompetition.length === 0) {
    lines.push("(none entered)");
  } else {
    for (const comp of marketCompetition) {
      const status = comp.status ? ` (${comp.status})` : "";
      lines.push(`- ${comp.address}: ${comp.askingPriceDisplay ?? "asking price n/a"}${status}`);
    }
  }
  lines.push("", "Write: 1) a short market position narrative, 2) a one-paragraph selling strategy suggestion, referencing only the above.");
  return lines.join("\n");
}

/* ---------------------------------------------------------------------
 * Sec 13/14 -- Presentation output. The generated text is a rendering
 * of the appraisal's own canonical fields -- never the other way
 * around (Sec 3: the appraisal record stays the source of truth) --
 * and is stored through the existing documents / document-storage
 * infrastructure (packages/db/src/schema/documents.ts,
 * apps/api/src/lib/documentStorage.ts) rather than a second document
 * system. No PDF-rendering dependency exists anywhere in this codebase
 * today (confirmed), so the generated artefact is a structured,
 * versioned text/plain document -- one of documentStorage's existing
 * allow-listed MIME types -- rather than a new one introduced for this
 * feature alone. The web Appraisal Workspace view is the primary
 * "web presentation" surface (Sec 13); this generated document is the
 * durable, versioned, downloadable snapshot of it.
 * -----------------------------------------------------------------*/
export interface GeneratePresentationInput {
  appraisalId: number;
  brokerageId: number;
  userId: number;
}

export interface GeneratePresentationResult {
  documentId: number;
  version: number;
}

export async function generateAppraisalPresentation(
  input: GeneratePresentationInput,
): Promise<GeneratePresentationResult> {
  const workspace = await getAppraisalWorkspace(input.appraisalId, input.brokerageId);
  const { appraisal, comparableSales, marketCompetition } = workspace;

  const [property] = await db.select().from(properties).where(eq(properties.id, appraisal.propertyId));
  const [party] = appraisal.partyId
    ? // E-9 A2: tenant-scoped contact lookup, same as the owner lookup below.
      // A foreign party id (bad row) must never put that contact's name into
      // this brokerage's generated presentation.
      await db
        .select()
        .from(parties)
        .where(and(eq(parties.id, appraisal.partyId), eq(parties.brokerageId, input.brokerageId)))
    : [null];
  const [owner] = appraisal.ownerUserId
    ? // WP1 P1-2: tenant-scoped owner lookup -- a foreign-brokerage owner id (bad row) must
      // never put another brokerage's user name into this brokerage's presentation.
      await db
        .select()
        .from(users)
        .where(and(eq(users.id, appraisal.ownerUserId), eq(users.brokerageId, input.brokerageId)))
    : [null];
  const [brokerage] = await db.select().from(brokerages).where(eq(brokerages.id, input.brokerageId));

  const text = renderPresentationText();
  const bytes = Buffer.from(text, "utf-8");

  let documentId = appraisal.presentationDocumentId ?? null;
  if (!documentId) {
    const [created] = await db
      .insert(documents)
      .values({
        propertyId: appraisal.propertyId,
        packageId: null,
        documentType: "AppraisalPresentation",
        title: `Appraisal presentation${property ? ` -- ${property.formattedAddress}` : ""}`,
        status: "Generated",
        metadata: { appraisalId: appraisal.id },
      })
      .returning();
    documentId = created.id;
  }

  const ingestResult = await ingestDocumentVersion({
    documentId,
    brokerageId: input.brokerageId,
    actorUserId: input.userId,
    bytes,
    originalFilename: `appraisal-${appraisal.id}-presentation.txt`,
    declaredMimeType: "text/plain",
    source: "generated",
    replacementReason: "Appraisal presentation regenerated from current workspace data.",
    metadata: { appraisalId: appraisal.id },
  });

  await db
    .update(appraisals)
    .set({ presentationDocumentId: documentId, updatedAt: new Date() })
    .where(eq(appraisals.id, appraisal.id));

  await logAudit({
    userId: input.userId,
    action: "appraisal_presentation_generated",
    recordType: "appraisal",
    recordId: String(appraisal.id),
    propertyId: appraisal.propertyId,
    updatedValue: `document ${documentId} v${ingestResult.version.version}`,
  });

  return { documentId, version: ingestResult.version.version };

  // Closure so every field below is typed exactly as the queries above
  // actually returned it, with no hand-maintained parallel interface to
  // drift out of sync with the schema.
  function renderPresentationText(): string {
    const address = property?.formattedAddress ?? "Property address not on file";
    const clientName = party ? computePartyDisplayName(party) : "Valued client";
    const agentName = owner ? `${owner.firstName} ${owner.lastName}`.trim() : "Your agent";
    const agencyName = brokerage?.name ?? "";
    const currency = appraisal.priceRangeCurrency ?? "AUD";
    const priceRange =
      appraisal.priceRangeLow && appraisal.priceRangeHigh
        ? `${currency} ${appraisal.priceRangeLow} - ${currency} ${appraisal.priceRangeHigh}`
        : "To be confirmed";

    const lines: string[] = [];
    const heading = (title: string) => {
      lines.push("", "=".repeat(title.length), title.toUpperCase(), "=".repeat(title.length), "");
    };

    heading("Cover");
    lines.push(address, `Prepared for: ${clientName}`, `Prepared by: ${agentName}${agencyName ? ` -- ${agencyName}` : ""}`);

    heading("Property");
    lines.push(address);

    heading("Understanding Your Goals");
    lines.push(appraisal.recommendedNextSteps ? "See Next Steps below." : "(not yet captured)");

    heading("Market Snapshot");
    lines.push(appraisal.marketPositionNarrative ?? "(not yet drafted)");

    heading("Comparable Sales");
    if (comparableSales.length === 0) {
      lines.push("(none entered)");
    } else {
      for (const sale of comparableSales) {
        const sold = sale.saleDate ? ` (sold ${new Date(sale.saleDate).toISOString().slice(0, 10)})` : "";
        lines.push(`- ${sale.address}: ${sale.salePrice ?? "n/a"}${sold}`);
      }
    }

    heading("Current Competition");
    if (marketCompetition.length === 0) {
      lines.push("(none entered)");
    } else {
      for (const comp of marketCompetition) {
        lines.push(`- ${comp.address}: ${comp.askingPriceDisplay ?? "n/a"}${comp.status ? ` (${comp.status})` : ""}`);
      }
    }

    heading("Recommended Market Position");
    lines.push(`Price range: ${priceRange}`);
    if (appraisal.pricingCommentary) lines.push(appraisal.pricingCommentary);

    heading("Selling Strategy");
    lines.push(appraisal.sellingStrategy ?? "(not yet drafted)");

    heading("Marketing Recommendation");
    lines.push(appraisal.marketingProposal ?? "(not yet drafted)");

    heading("Agent & Agency");
    lines.push(`${agentName}${agencyName ? ` -- ${agencyName}` : ""}`);

    heading("Fees & Commission");
    lines.push(appraisal.commissionRatePercent ? `Commission: ${appraisal.commissionRatePercent}%` : "(not yet set)");
    if (appraisal.commissionProposal) lines.push(appraisal.commissionProposal);

    heading("Next Steps");
    lines.push(appraisal.recommendedNextSteps ?? "(not yet drafted)");

    return lines.join("\n");
  }
}

/* ---------------------------------------------------------------------
 * Sec 19/20 -- Grow -> Run handoff. Reuses the canonical property/party
 * relationship (property_parties) and the existing Ready to List
 * workflow entirely as-is (apps/api/src/routes/properties.ts,
 * POST /:id/ready-to-list) -- this function's only job is to make sure
 * that route's own precondition (a Seller party link on the property)
 * is satisfied from data Grow already has, gated behind the same
 * run.access entitlement Run uses everywhere else (checked at the
 * route layer). It never starts a transaction itself and never calls
 * ready-to-list itself -- the agent's own next click does, same as any
 * other property (Sec 19: "no auto-start ... without agent confirmation").
 * -----------------------------------------------------------------*/
export interface PrepareAppraisalRunHandoffInput {
  appraisalId: number;
  brokerageId: number;
  userId: number;
}

export interface PrepareAppraisalRunHandoffResult {
  propertyId: number;
  sellerLinkCreated: boolean;
}

export async function prepareAppraisalRunHandoff(
  input: PrepareAppraisalRunHandoffInput,
): Promise<PrepareAppraisalRunHandoffResult> {
  const appraisal = await assertAppraisalInBrokerage(input.appraisalId, input.brokerageId);
  if (appraisal.outcome !== "WON") {
    throw new AppraisalAccessError("Only a WON appraisal can be handed off to Run.");
  }
  if (!appraisal.partyId) {
    throw new AppraisalAccessError("This appraisal has no linked contact to record as the seller.");
  }

  // E-9 A2: appraisals.party_id is not re-checked against the caller brokerage.
  // Before inserting a Seller link, require the party to belong here. A miss
  // is refused exactly like createAppraisalFromContact — AppraisalAccessError
  // "Contact not found", which the route maps to HTTP 404. That response does
  // not confirm the foreign id exists, and this function inserts nothing.
  const [sellerParty] = await db
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.id, appraisal.partyId), eq(parties.brokerageId, input.brokerageId)));
  if (!sellerParty) {
    await noteGrowPartyIsolationRejection(appraisal.partyId, input.brokerageId);
    throw new AppraisalAccessError("Contact not found");
  }

  const existingLinks = await db
    .select()
    .from(propertyParties)
    .where(and(eq(propertyParties.propertyId, appraisal.propertyId), eq(propertyParties.partyId, appraisal.partyId)));

  let sellerLinkCreated = false;
  if (!existingLinks.some((l) => l.role === "Seller")) {
    await db.insert(propertyParties).values({
      propertyId: appraisal.propertyId,
      partyId: appraisal.partyId,
      role: "Seller",
      isPrimary: true,
    });
    sellerLinkCreated = true;
  }

  await logAudit({
    userId: input.userId,
    action: "appraisal_run_handoff_prepared",
    recordType: "appraisal",
    recordId: String(appraisal.id),
    propertyId: appraisal.propertyId,
    updatedValue: sellerLinkCreated ? "seller_link_created" : "seller_link_existing",
  });

  return { propertyId: appraisal.propertyId, sellerLinkCreated };
}

/* ---------------------------------------------------------------------
 * Sec 9/10 -- manual comparable sale / market competition entry.
 * Manual-first, Priority-5-provider-injection-ready (the source /
 * sourceProvenance columns already exist on both tables for that).
 * Every mutation re-asserts tenancy via assertAppraisalInBrokerage so a
 * caller can never touch another brokerage's row by guessing an id.
 * -----------------------------------------------------------------*/
export type ComparableSaleInput = Omit<typeof appraisalComparableSales.$inferInsert, "id" | "appraisalId" | "createdAt" | "updatedAt">;
export type MarketCompetitionInput = Omit<typeof appraisalMarketCompetition.$inferInsert, "id" | "appraisalId" | "createdAt" | "updatedAt">;

export async function addComparableSale(
  appraisalId: number,
  brokerageId: number,
  input: ComparableSaleInput,
): Promise<AppraisalComparableSale> {
  const appraisal = await assertAppraisalInBrokerage(appraisalId, brokerageId);
  enforceAppraisalPricingRule(appraisal);
  const [row] = await db
    .insert(appraisalComparableSales)
    .values({ ...input, appraisalId: appraisal.id })
    .returning();
  return row;
}

export async function updateComparableSale(
  appraisalId: number,
  brokerageId: number,
  saleId: number,
  input: Partial<ComparableSaleInput>,
): Promise<AppraisalComparableSale> {
  const appraisal = await assertAppraisalInBrokerage(appraisalId, brokerageId);
  enforceAppraisalPricingRule(appraisal);
  const [row] = await db
    .update(appraisalComparableSales)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(appraisalComparableSales.id, saleId), eq(appraisalComparableSales.appraisalId, appraisalId)))
    .returning();
  if (!row) {
    await noteGrowComparableSaleIsolationRejection(saleId, brokerageId);
    throw new AppraisalAccessError("Comparable sale not found.");
  }
  return row;
}

export async function deleteComparableSale(appraisalId: number, brokerageId: number, saleId: number): Promise<void> {
  const appraisal = await assertAppraisalInBrokerage(appraisalId, brokerageId);
  enforceAppraisalPricingRule(appraisal);
  await db
    .delete(appraisalComparableSales)
    .where(and(eq(appraisalComparableSales.id, saleId), eq(appraisalComparableSales.appraisalId, appraisalId)));
}

export async function addMarketCompetitionItem(
  appraisalId: number,
  brokerageId: number,
  input: MarketCompetitionInput,
): Promise<AppraisalMarketCompetition> {
  const appraisal = await assertAppraisalInBrokerage(appraisalId, brokerageId);
  enforceAppraisalPricingRule(appraisal);
  const [row] = await db
    .insert(appraisalMarketCompetition)
    .values({ ...input, appraisalId: appraisal.id })
    .returning();
  return row;
}

export async function updateMarketCompetitionItem(
  appraisalId: number,
  brokerageId: number,
  itemId: number,
  input: Partial<MarketCompetitionInput>,
): Promise<AppraisalMarketCompetition> {
  const appraisal = await assertAppraisalInBrokerage(appraisalId, brokerageId);
  enforceAppraisalPricingRule(appraisal);
  const [row] = await db
    .update(appraisalMarketCompetition)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(appraisalMarketCompetition.id, itemId), eq(appraisalMarketCompetition.appraisalId, appraisalId)))
    .returning();
  if (!row) {
    await noteGrowMarketCompetitionIsolationRejection(itemId, brokerageId);
    throw new AppraisalAccessError("Market competition entry not found.");
  }
  return row;
}

export async function deleteMarketCompetitionItem(appraisalId: number, brokerageId: number, itemId: number): Promise<void> {
  const appraisal = await assertAppraisalInBrokerage(appraisalId, brokerageId);
  enforceAppraisalPricingRule(appraisal);
  await db
    .delete(appraisalMarketCompetition)
    .where(and(eq(appraisalMarketCompetition.id, itemId), eq(appraisalMarketCompetition.appraisalId, appraisalId)));
}
