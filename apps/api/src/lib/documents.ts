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
import { publishDomainEvent, currentCorrelationId, logger } from "@aee/events";
import { createESignProvider, type ESignWebhookResult } from "@aee/integration-esign";
import { populateTemplate } from "./documentTemplates.js";
import { logAudit } from "./audit.js";
import { dispatchOperationalAlert } from "./operationalAlerts.js";
import {
  DocumentStorageError,
  configuredEsignMaxDocumentBytes,
  configuredEsignMaxDocuments,
  getStoredDocumentContent,
  ingestDocumentVersion,
} from "./documentStorage.js";
import { refreshReadyToListSteps } from "./workflowSteps.js";

const esignProvider = createESignProvider();

async function partyName(partyId: number): Promise<string> {
  const [p] = await db.select().from(parties).where(eq(parties.id, partyId));
  if (!p) return "Unknown";
  return p.organisationName || `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || "Unknown";
}

// --- Tenant chokepoints -----------------------------------------------
//
// #131/#135-class cross-tenant IDOR fix. documents/documentPackages/
// agencyAgreementTerms carry propertyId but (unlike e.g. communications'
// tables) no brokerageId of their own, so the tenant check has to resolve
// through properties — mirrors lib/transactionConditions.ts's
// loadTransactionInBrokerage and lib/aml.ts's assertPartyOnPropertyInBrokerage
// exactly: a cross-tenant id gets the SAME "not found" as a nonexistent
// one, never a distinguishing error. Where the id being loaded belongs to
// a table that itself has no brokerageId, the property join is folded into
// the SAME query that fetches by id (not a separate check performed after)
// so there is only one possible throw site — it cannot drift into two
// differently-worded errors over time.

/** Tenant + property chokepoint — matches assertPropertyInBrokerage in lib/launch/model.ts, lib/exceptions/model.ts, lib/timeline.ts. */
async function assertPropertyInBrokerage(propertyId: number, brokerageId: number): Promise<void> {
  const [property] = await db.select().from(properties).where(and(eq(properties.id, propertyId), eq(properties.brokerageId, brokerageId)));
  if (!property) throw new Error(`Property ${propertyId} not found`);
}

async function loadDocumentPackageInBrokerage(packageId: number, brokerageId: number): Promise<DocumentPackage> {
  const [row] = await db
    .select({ documentPackage: documentPackages })
    .from(documentPackages)
    .innerJoin(properties, eq(documentPackages.propertyId, properties.id))
    .where(and(eq(documentPackages.id, packageId), eq(properties.brokerageId, brokerageId)));
  if (!row) throw new Error(`DocumentPackage ${packageId} not found`);
  return row.documentPackage;
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
  brokerageId: number;
  commissionType: "Percentage" | "FlatFee";
  commissionRateBps?: number | null;
  flatFeeCents?: number | null;
  marketingFeeCents?: number | null;
  agreementTermDays: number;
  userId: number;
}): Promise<AgencyAgreementTerms> {
  await assertPropertyInBrokerage(input.propertyId, input.brokerageId);

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

/** Tenant-scoped read of a property's agency-agreement terms — `null` covers both "not captured yet" and (after the tenant check) is unreachable for a cross-tenant propertyId, which throws instead. */
export async function getAgencyAgreementTerms(propertyId: number, brokerageId: number): Promise<AgencyAgreementTerms | null> {
  await assertPropertyInBrokerage(propertyId, brokerageId);
  const [terms] = await db.select().from(agencyAgreementTerms).where(eq(agencyAgreementTerms.propertyId, propertyId));
  return terms ?? null;
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
export async function populateDocumentPackage(packageId: number, brokerageId: number): Promise<PopulateResult> {
  const docPackage = await loadDocumentPackageInBrokerage(packageId, brokerageId);

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
    const stored = await ingestDocumentVersion({
      documentId: doc.id,
      brokerageId,
      bytes: Buffer.from(content, "utf8"),
      originalFilename: `${doc.title}.txt`,
      declaredMimeType: "text/plain",
      source: "generated",
      retentionClass: doc.documentType === "AgencyAgreement" ? "signed-agreement" : "legal-pending",
      metadata: { ruleSetVersion: docPackage.ruleSetVersion },
    });
    await logAudit({
      action:
        stored.outcome === "created"
          ? "document_version_generated"
          : stored.outcome === "resumed"
            ? "document_version_generation_reconciled"
            : "document_version_generation_deduplicated",
      recordType: "document_object_version",
      recordId: String(stored.version.id),
      propertyId: stored.version.propertyId,
      updatedValue: JSON.stringify({
        documentId: doc.id,
        version: stored.version.version,
        byteSize: stored.version.byteSize,
        contentSha256: stored.version.contentSha256,
        retentionClass: stored.version.retentionClass,
      }),
    });

    await db
      .update(documents)
      .set({
        status: "Generated",
        objectStorageKey: stored.version.storageObjectKey,
        metadata: {
          ...((doc.metadata as Record<string, unknown> | null) ?? {}),
          ruleSetVersion: docPackage.ruleSetVersion,
          generatedAt: new Date().toISOString(),
          activeObjectVersionId: stored.version.id,
          contentSha256: stored.version.contentSha256,
          byteSize: stored.version.byteSize,
          detectedMimeType: stored.version.detectedMimeType,
          version: stored.version.version,
        },
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

  await refreshReadyToListSteps(docPackage.propertyId).catch((err) =>
    logger.error("refresh_ready_to_list_steps_failed", { propertyId: docPackage.propertyId, packageId, error: err }),
  );

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
 *
 * input.brokerageId used to be forwarded only into the outgoing
 * AGENCY_AGREEMENT_SENT event payload below — never actually checked
 * against the package, a false sense of safety rather than a real tenant
 * guard (#131/#135). loadDocumentPackageInBrokerage now makes it the real
 * chokepoint: a packageId from another brokerage is rejected identically
 * to one that doesn't exist, before anything else in this function runs.
 */
export async function sendPackageForSignature(input: {
  packageId: number;
  userId: number;
  brokerageId: number;
}): Promise<SendForSignatureResult> {
  const docPackage = await loadDocumentPackageInBrokerage(input.packageId, input.brokerageId);

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
        correlationId: currentCorrelationId(),
        causationId: null,
        idempotencyKey: `agency-agreement-sent:${signatureRequest.id}`,
        payload: { packageId: input.packageId, signatureRequestId: signatureRequest.id, providerReference },
        metadata: {},
      });
    } catch (err) {
      logger.error("publish_domain_event_failed", { eventType: "AGENCY_AGREEMENT_SENT", packageId: input.packageId, propertyId: docPackage.propertyId, error: err });
    }
  }

  await refreshReadyToListSteps(docPackage.propertyId).catch((err) =>
    logger.error("refresh_ready_to_list_steps_failed", { propertyId: docPackage.propertyId, packageId: input.packageId, error: err }),
  );

  return { signatureRequest, created: true };
}

export interface DocumentContentResult {
  content: string | Buffer;
  contentType: string;
  displayFilename: string;
  versionId: number | null;
  propertyId: number;
}

/**
 * Loads a document's stored content, scoped to the caller's brokerage —
 * previously a raw, unscoped `db.select` + object-storage read directly in
 * the route (the most severe of the confirmed cross-tenant IDOR findings:
 * real signed contract/agreement content, readable by any authenticated
 * user from any brokerage). The id+brokerageId join below is the same
 * single query used to fetch the document at all, so a cross-tenant
 * documentId comes back `null` — identical to the pre-existing "not
 * generated yet" case (`!doc.objectStorageKey`) the route already handled.
 * Only a genuine object-storage read failure (key present, tenant already
 * verified) still throws.
 */
export async function getDocumentContent(documentId: number, brokerageId: number): Promise<DocumentContentResult | null> {
  const stored = await getStoredDocumentContent(documentId, brokerageId);
  if (!stored) return null;
  return {
    content: stored.bytes,
    contentType: stored.contentType,
    displayFilename: stored.displayFilename,
    versionId: stored.version?.id ?? null,
    propertyId: stored.document.propertyId,
  };
}

export interface PackageByPropertyResult {
  documentPackage: DocumentPackage | null;
  documents: Document[];
  signatureRequest: SignatureRequest | null;
}

/**
 * Property-scoped package lookup for the Property Card's document panel —
 * joined onto properties and filtered by the caller's brokerageId in the
 * same query (mirrors routes/aml.ts's GET /by-property), so a propertyId
 * belonging to another brokerage returns the identical empty shape as a
 * property that simply hasn't had Ready to List run yet, never another
 * tenant's document package/documents/signature request.
 */
export async function getPackageByProperty(propertyId: number, brokerageId: number): Promise<PackageByPropertyResult> {
  const [row] = await db
    .select({ documentPackage: documentPackages })
    .from(documentPackages)
    .innerJoin(properties, eq(documentPackages.propertyId, properties.id))
    .where(and(eq(documentPackages.propertyId, propertyId), eq(properties.brokerageId, brokerageId)));
  if (!row) return { documentPackage: null, documents: [], signatureRequest: null };

  const packageDocuments = await db.select().from(documents).where(eq(documents.packageId, row.documentPackage.id));
  const [signatureRequest] = await db.select().from(signatureRequests).where(eq(signatureRequests.packageId, row.documentPackage.id));
  return { documentPackage: row.documentPackage, documents: packageDocuments, signatureRequest: signatureRequest ?? null };
}

export interface ProcessEsignWebhookResult {
  processed: boolean;
  reason?:
    | "invalid_signature"
    | "signature_request_not_found"
    | "duplicate_delivery"
    | "completed_document_missing"
    | "completed_document_invalid"
    | "completed_document_storage_retry_required";
  signatureRequest?: SignatureRequest;
}

function decodeCompletedDocument(contentBase64: string): Buffer {
  const maximumBytes = configuredEsignMaxDocumentBytes();
  const maximumEncodedLength = Math.ceil(maximumBytes / 3) * 4 + 4;
  if (
    contentBase64.length === 0 ||
    contentBase64.length > maximumEncodedLength ||
    contentBase64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)
  ) {
    throw new Error("Invalid or oversized Base64 document");
  }
  const bytes = Buffer.from(contentBase64, "base64");
  if (
    bytes.length > maximumBytes ||
    bytes.toString("base64") !== contentBase64
  ) {
    throw new Error("Invalid or oversized Base64 document");
  }
  return bytes;
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

  const [docPackage] = await db
    .select()
    .from(documentPackages)
    .where(eq(documentPackages.id, signatureRequest.packageId));
  const packageDocuments = docPackage
    ? await db.select().from(documents).where(eq(documents.packageId, docPackage.id))
    : [];

  let completedDocumentKey = signatureRequest.completedDocumentKey;
  if (result.status === "Completed") {
    if (
      !docPackage ||
      !result.completedDocuments ||
      result.completedDocuments.length > configuredEsignMaxDocuments() ||
      result.completedDocuments.length !== packageDocuments.length
    ) {
      return {
        processed: false,
        reason: "completed_document_missing",
        signatureRequest,
      };
    }
    const [property] = await db
      .select()
      .from(properties)
      .where(eq(properties.id, docPackage.propertyId));
    if (!property?.brokerageId) {
      return {
        processed: false,
        reason: "completed_document_invalid",
        signatureRequest,
      };
    }
    const expectedIds = new Set(packageDocuments.map((document) => document.id));
    if (
      new Set(result.completedDocuments.map((document) => document.documentId)).size !==
        packageDocuments.length ||
      result.completedDocuments.some((document) => !expectedIds.has(document.documentId))
    ) {
      return {
        processed: false,
        reason: "completed_document_invalid",
        signatureRequest,
      };
    }
    let completedWithBytes: Array<{
      completed: NonNullable<ESignWebhookResult["completedDocuments"]>[number];
      bytes: Buffer;
    }>;
    try {
      completedWithBytes = result.completedDocuments.map((completed) => ({
        completed,
        bytes: decodeCompletedDocument(completed.contentBase64),
      }));
    } catch {
      return {
        processed: false,
        reason: "completed_document_invalid",
        signatureRequest,
      };
    }
    try {
      const storedVersions = [];
      for (const { completed, bytes } of completedWithBytes) {
        const stored = await ingestDocumentVersion({
          documentId: completed.documentId,
          brokerageId: property.brokerageId,
          bytes,
          originalFilename: completed.filename,
          declaredMimeType: completed.contentType,
          replacementReason: `Completed e-signature envelope ${result.providerReference}`,
          retentionClass: "signed-agreement",
          source: "esign",
          sourceProvider: signatureRequest.provider,
          providerDocumentId: result.providerReference,
          webhookVerified: true,
        });
        storedVersions.push(stored.version);
        await logAudit({
          action:
            stored.outcome === "created"
              ? "document_version_ingested_from_esign"
              : stored.outcome === "resumed"
                ? "document_version_esign_ingestion_reconciled"
                : "document_version_esign_ingestion_deduplicated",
          recordType: "document_object_version",
          recordId: String(stored.version.id),
          propertyId: stored.version.propertyId,
          providerReference: result.providerReference,
          updatedValue: JSON.stringify({
            documentId: completed.documentId,
            version: stored.version.version,
            byteSize: stored.version.byteSize,
            contentSha256: stored.version.contentSha256,
            webhookVerified: true,
          }),
        });
      }
      completedDocumentKey = storedVersions[0]?.storageObjectKey ?? null;
    } catch (error) {
      const isInvalidPayload =
        error instanceof DocumentStorageError &&
        error.code !== "DOCUMENT_UNAVAILABLE" &&
        error.code !== "DOCUMENT_INTEGRITY_FAILURE";
      logger.warn("esign_completed_document_ingestion_rejected", {
        signatureRequestId: signatureRequest.id,
        retryable: !isInvalidPayload,
        error: error instanceof Error ? error.message : "unknown error",
      });
      if (!isInvalidPayload) {
        await logAudit({
          action: "esign_completed_document_storage_retry_required",
          recordType: "signature_request",
          recordId: String(signatureRequest.id),
          propertyId: docPackage.propertyId,
          providerReference: result.providerReference,
          updatedValue: JSON.stringify({
            status: signatureRequest.status,
            retryable: true,
            pendingDocumentIds: completedWithBytes.map(({ completed }) => completed.documentId),
          }),
        });
        await dispatchOperationalAlert({
          type: "DOCUMENT_STORAGE_INGESTION_RETRY_REQUIRED",
          summary: "Completed e-sign document storage requires provider redelivery",
          dedupKey: `document-storage:esign-retry:${signatureRequest.id}`,
          details: {
            signatureRequestId: signatureRequest.id,
            propertyId: docPackage.propertyId,
            pendingDocumentCount: completedWithBytes.length,
          },
        });
      }
      return {
        processed: false,
        reason: isInvalidPayload
          ? "completed_document_invalid"
          : "completed_document_storage_retry_required",
        signatureRequest,
      };
    }
  }

  const [updated] = await db
    .update(signatureRequests)
    .set({
      status: result.status,
      completedAt: result.status === "Completed" || result.status === "Voided" ? new Date() : null,
      completedDocumentKey,
      updatedAt: new Date(),
    })
    .where(eq(signatureRequests.id, signatureRequest.id))
    .returning();

  if (result.status === "Completed" && docPackage) {
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
      // #131/#135 fix: this webhook has no authenticated caller to take
      // brokerageId/agentId from (unlike sendPackageForSignature's
      // AGENCY_AGREEMENT_SENT above), so resolve them from the property
      // itself -- exactly the pattern lib/aml.ts's processAmlWebhook
      // already uses for AML_COMPLETED. Previously hardcoded to null,
      // which silently made this event invisible to every brokerageId-
      // filtered domain event consumer (the Property Timeline included).
      const [property] = await db.select().from(properties).where(eq(properties.id, docPackage.propertyId));
      try {
        await publishDomainEvent({
          eventType: "AGENCY_AGREEMENT_SIGNED",
          occurredAt: new Date(),
          propertyId: docPackage.propertyId,
          transactionId: null,
          partyId: null,
          brokerageId: property?.brokerageId ?? null,
          agentId: property?.agentId ?? null,
          actorType: "INTEGRATION",
          actorId: null,
          source: `webhook:esign:${updated.provider}`,
          correlationId: currentCorrelationId(),
          causationId: null,
          idempotencyKey: `agency-agreement-signed:${updated.id}`,
          payload: { packageId: updated.packageId, signatureRequestId: updated.id },
          metadata: {},
        });
      } catch (err) {
        logger.error("publish_domain_event_failed", { eventType: "AGENCY_AGREEMENT_SIGNED", packageId: updated.packageId, propertyId: docPackage.propertyId, error: err });
      }
    }
  }

  if (docPackage) {
    await refreshReadyToListSteps(docPackage.propertyId).catch((err) =>
      logger.error("refresh_ready_to_list_steps_failed", { propertyId: docPackage.propertyId, packageId: docPackage.id, error: err }),
    );
  }

  return { processed: true, signatureRequest: updated };
}
