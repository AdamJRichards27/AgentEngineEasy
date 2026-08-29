import { eq, and, inArray, ne } from "drizzle-orm";
import {
  db,
  documentPackages,
  documents,
  signatureRequests,
  agencyAgreementTerms,
  properties,
  propertyParties,
  parties,
} from "@aee/db";
import type { DocumentPackage, Document, SignatureRequest, AgencyAgreementTerms } from "@aee/db";
import { publishDomainEvent, newCorrelationId } from "@aee/events";
import { createESignProvider, type ESignWebhookResult } from "@aee/integration-esign";
import { createObjectStorageProvider } from "@aee/integration-object-storage";
import { populateTemplate } from "./documentTemplates.js";
import { refreshReadyToListSteps } from "./workflowSteps.js";

const esignProvider = createESignProvider();
const objectStorage = createObjectStorageProvider();

async function partyName(partyId: number): Promise<string> {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!p) return "Unknown";
  return p.organisationName || `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "Unknown";
}

/**
 * Real structured agency-agreement terms capture (ARCHITECTURE.md §3 —
 * explicitly not the legacy app's opaque-JSON commission storage). One
 * active row per property, updated in place; callers should also
 * logAudit() the change (route-layer concern, matching the ownership
 * review precedent) since this function only owns the upsert itself.
 */
export async function upsertAgencyAgreementTerms(input: {
  propertyId: number;
  commissionType: "Percentage" | "FlatFee";
  commissionRateBps?: number | null;
  flatFeeCents?: number | null;
  marketingFeeCents?: number | null;
  agreementTermDays: number;
  userId: number;
}): Promise<AgencyAgreementTerms> {
  const [existing] = await db
    .select()
    .from(agencyAgreementTerms)
    .where(eq(agencyAgreementTerms.propertyId, input.propertyId));

  if (existing) {
    const [updated] = await db
      .update(agencyAgreementTerms)
      .set({
        commissionType: input.commissionType,
        commissionRateBps: input.commissionRateBps ?? null,
        flatFeeCents: input.flatFeeCents ?? null,
        marketingFeeCents: input.marketingFeeCents ?? null,
        agreementTermDays: input.agreementTermDays,
        updatedBy: input.userId,
        updatedAt: new Date(),
      })
      .where(eq(agencyAgreementTerms.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db
    .insert(agencyAgreementTerms)
    .values({
      propertyId: input.propertyId,
      commissionType: input.commissionType,
      commissionRateBps: input.commissionRateBps ?? null,
      flatFeeCents: input.flatFeeCents ?? null,
      marketingFeeCents: input.marketingFeeCents ?? null,
      agreementTermDays: input.agreementTermDays,
      createdBy: input.userId,
    })
    .returning();
  return created;
}

export interface PopulateResult {
  documentPackage: DocumentPackage;
  documents: Document[];
  skipped: Array<{ documentId: number; reason: string }>;
}

/**
 * Template population (Phase 5). Idempotent/incremental: safe to call
 * repeatedly (e.g. after agency terms are captured later) — only Draft
 * documents are (re)rendered, already-Generated/Signed documents are left
 * alone. AgencyAgreement is deliberately skipped (left Draft) until
 * upsertAgencyAgreementTerms() has been called for the property, rather
 * than rendering a commission clause full of placeholders as if it were
 * real content ready to send.
 */
export async function populateDocumentPackage(packageId: number): Promise<PopulateResult> {
  const [docPackage] = await db.select().from(documentPackages).where(eq(documentPackages.id, packageId));
  if (!docPackage) {
    throw new Error(`DocumentPackage ${packageId} not found`);
  }

  const [property] = await db.select().from(properties).where(eq(properties.id, docPackage.propertyId));
  if (!property) {
    throw new Error(`Property ${docPackage.propertyId} not found`);
  }

  const links = await db
    .select()
    .from(propertyParties)
    .where(and(eq(propertyParties.propertyId, docPackage.propertyId), eq(propertyParties.role, "Seller")));
  const sellerNames = await Promise.all(links.map((l) => partyName(l.partyId)));

  const [terms] = await db.select().from(agencyAgreementTerms).where(eq(agencyAgreementTerms.propertyId, docPackage.propertyId));

  const ctx = {
    formattedAddress: property.formattedAddress,
    suburb: property.suburb,
    state: property.state,
    postcode: property.postcode,
    sellerNames,
    agencyTerms: terms
      ? {
          commissionType: terms.commissionType,
          commissionRateBps: terms.commissionRateBps,
          flatFeeCents: terms.flatFeeCents,
          marketingFeeCents: terms.marketingFeeCents,
          agreementTermDays: terms.agreementTermDays,
        }
      : null,
  };

  const packageDocuments = await db.select().from(documents).where(eq(documents.packageId, packageId));
  const skipped: PopulateResult["skipped"] = [];

  for (const doc of packageDocuments) {
    if (doc.status !== "Draft") continue;
    if (doc.documentType === "AgencyAgreement" && !terms) {
      skipped.push({ documentId: doc.id, reason: "Agency agreement terms not yet captured." });
      continue;
    }

    const content = populateTemplate(doc.documentType, doc.title, ctx);
    const key = `packages/${packageId}/documents/${doc.id}.txt`;
    await objectStorage.putObject(key, content, "text/plain");

    await db
      .update(documents)
      .set({
        status: "Generated",
        objectStorageKey: key,
        metadata: { ruleSetVersion: docPackage.ruleSetVersion, generatedAt: new Date().toISOString() },
        updatedAt: new Date(),
      })
      .where(eq(documents.id, doc.id));
  }

  const refreshedDocuments = await db.select().from(documents).where(eq(documents.packageId, packageId));
  const allGenerated = refreshedDocuments.length > 0 && refreshedDocuments.every((d) => d.status === "Generated" || d.status === "Signed");

  const [updatedPackage] = await db
    .update(documentPackages)
    .set({ status: allGenerated ? "Ready" : "Preparing", updatedAt: new Date() })
    .where(eq(documentPackages.id, packageId))
    .returning();

  await refreshReadyToListSteps(docPackage.propertyId).catch((err) => console.error("refreshReadyToListSteps failed", err));

  return { documentPackage: updatedPackage, documents: refreshedDocuments, skipped };
}

export interface SendForSignatureResult {
  signatureRequest: SignatureRequest;
  created: boolean;
}

/**
 * Idempotent send-for-signature — mirrors lib/aml.ts's initiateAmlIfNeeded
 * chokepoint pattern: an existing non-Voided SignatureRequest for the
 * package is returned as-is rather than creating a second envelope.
 */
export async function sendPackageForSignature(input: {
  packageId: number;
  userId: number;
  brokerageId: number;
}): Promise<SendForSignatureResult> {
  const [docPackage] = await db.select().from(documentPackages).where(eq(documentPackages.id, input.packageId));
  if (!docPackage) {
    throw new Error(`DocumentPackage ${input.packageId} not found`);
  }

  const [existing] = await db
    .select()
    .from(signatureRequests)
    .where(and(eq(signatureRequests.packageId, input.packageId), ne(signatureRequests.status, "Voided")));
  if (existing) {
    return { signatureRequest: existing, created: false };
  }

  if (docPackage.status !== "Ready") {
    throw new Error("Document package is not ready to send — all documents must be generated first.");
  }

  const packageDocuments = await db
    .select()
    .from(documents)
    .where(and(eq(documents.packageId, input.packageId), eq(documents.status, "Generated")));

  const links = await db
    .select()
    .from(propertyParties)
    .where(and(eq(propertyParties.propertyId, docPackage.propertyId), eq(propertyParties.role, "Seller")));
  const sellerPartyIds = links.map((l) => l.partyId);
  const sellerRows = sellerPartyIds.length ? await db.select().from(parties).where(inArray(parties.id, sellerPartyIds)) : [];
  const signatories = sellerRows
    .filter((p) => Boolean(p.email))
    .map((p) => ({
      partyId: p.id,
      name: p.organisationName || `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "Unknown",
      email: p.email as string,
    }));

  if (signatories.length === 0) {
    throw new Error("At least one seller with an email address is required to send for signature.");
  }

  const { providerReference } = await esignProvider.createEnvelope({
    packageId: input.packageId,
    documents: packageDocuments.map((d) => ({ documentId: d.id, title: d.title, objectStorageKey: d.objectStorageKey ?? "" })),
    signatories,
  });

  const [signatureRequest] = await db
    .insert(signatureRequests)
    .values({
      packageId: input.packageId,
      provider: process.env.ESIGN_PROVIDER ?? "mock",
      providerReference,
      signatories: signatories.map((s) => ({ ...s, status: "Pending" })),
      status: "Sent",
      sentAt: new Date(),
    })
    .returning();

  await db.update(documentPackages).set({ status: "Sent", updatedAt: new Date() }).where(eq(documentPackages.id, input.packageId));

  const hasAgencyAgreement = packageDocuments.some((d) => d.documentType === "AgencyAgreement");
  if (hasAgencyAgreement) {
    try {
      await publishDomainEvent({
        eventType: "AGENCY_AGREEMENT_SENT",
        occurredAt: new Date(),
        propertyId: docPackage.propertyId,
        transactionId: null,
        partyId: null,
        brokerageId: input.brokerageId,
        agentId: input.userId,
        actorType: "USER",
        actorId: input.userId,
        source: "api:documents:send-for-signature",
        correlationId: newCorrelationId(),
        causationId: null,
        idempotencyKey: `agency-agreement-sent:${signatureRequest.id}`,
        payload: { packageId: input.packageId, signatureRequestId: signatureRequest.id, providerReference },
        metadata: {},
      });
    } catch (err) {
      console.error("publishDomainEvent(AGENCY_AGREEMENT_SENT) failed", err);
    }
  }

  await refreshReadyToListSteps(docPackage.propertyId).catch((err) => console.error("refreshReadyToListSteps failed", err));

  return { signatureRequest, created: true };
}

export interface ProcessEsignWebhookResult {
  processed: boolean;
  reason?: "invalid_signature" | "signature_request_not_found" | "duplicate_delivery";
  signatureRequest?: SignatureRequest;
}

/**
 * ESign webhook processing (Phase 5) — same shape as lib/aml.ts's
 * processAmlWebhook: outcome-aware idempotency (a redelivery of the exact
 * same status is skipped, a real transition still processes), signature
 * verified against the raw request bytes.
 */
export async function processEsignWebhook(
  rawBody: Buffer | string,
  signature: string,
  payload: unknown,
): Promise<ProcessEsignWebhookResult> {
  if (!esignProvider.verifyWebhookSignature(rawBody, signature)) {
    return { processed: false, reason: "invalid_signature" };
  }

  const result: ESignWebhookResult = esignProvider.parseWebhook(payload);

  const [signatureRequest] = await db
    .select()
    .from(signatureRequests)
    .where(eq(signatureRequests.providerReference, result.providerReference));
  if (!signatureRequest) {
    return { processed: false, reason: "signature_request_not_found" };
  }

  const isTerminalRepeat =
    signatureRequest.status === result.status &&
    (signatureRequest.status === "Completed" || signatureRequest.status === "Voided") &&
    signatureRequest.completedAt !== null;
  if (isTerminalRepeat) {
    return { processed: false, reason: "duplicate_delivery", signatureRequest };
  }

  const [updated] = await db
    .update(signatureRequests)
    .set({
      status: result.status,
      completedAt: result.status === "Completed" || result.status === "Voided" ? new Date() : null,
      completedDocumentKey: result.completedDocumentKey ?? signatureRequest.completedDocumentKey,
      updatedAt: new Date(),
    })
    .where(eq(signatureRequests.id, signatureRequest.id))
    .returning();

  const [docPackage] = await db.select().from(documentPackages).where(eq(documentPackages.id, updated.packageId));

  if (result.status === "Completed" && docPackage) {
    const packageDocuments = await db.select().from(documents).where(eq(documents.packageId, updated.packageId));
    await db
      .update(documents)
      .set({ status: "Signed", updatedAt: new Date() })
      .where(
        and(
          eq(documents.packageId, updated.packageId),
          inArray(
            documents.id,
            packageDocuments.map((d) => d.id),
          ),
        ),
      );
    await db.update(documentPackages).set({ status: "Completed", updatedAt: new Date() }).where(eq(documentPackages.id, updated.packageId));

    const hasAgencyAgreement = packageDocuments.some((d) => d.documentType === "AgencyAgreement");
    if (hasAgencyAgreement) {
      try {
        await publishDomainEvent({
          eventType: "AGENCY_AGREEMENT_SIGNED",
          occurredAt: new Date(),
          propertyId: docPackage.propertyId,
          transactionId: null,
          partyId: null,
          brokerageId: null,
          agentId: null,
          actorType: "INTEGRATION",
          actorId: null,
          source: `webhook:esign:${updated.provider}`,
          correlationId: newCorrelationId(),
          causationId: null,
          idempotencyKey: `agency-agreement-signed:${updated.id}`,
          payload: { packageId: updated.packageId, signatureRequestId: updated.id },
          metadata: {},
        });
      } catch (err) {
        console.error("publishDomainEvent(AGENCY_AGREEMENT_SIGNED) failed", err);
      }
    }
  }

  if (docPackage) {
    await refreshReadyToListSteps(docPackage.propertyId).catch((err) => console.error("refreshReadyToListSteps failed", err));
  }

  return { processed: true, signatureRequest: updated };
}
