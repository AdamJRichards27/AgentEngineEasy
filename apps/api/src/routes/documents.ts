import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, properties } from "@aee/db";
import { logger } from "@aee/events";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { logAudit } from "../lib/audit.js";
import {
  DocumentStorageError,
  configuredMaxDocumentBytes,
  createDocumentSignedDownload,
  ingestDocumentVersion,
  quarantineDocument,
  redeemDocumentSignedDownload,
} from "../lib/documentStorage.js";
import {
  upsertAgencyAgreementTerms,
  getAgencyAgreementTerms,
  populateDocumentPackage,
  sendPackageForSignature,
  processEsignWebhook,
  getDocumentContent,
  getPackageByProperty,
} from "../lib/documents.js";

// Phase 5 (ARCHITECTURE.md §10): agency-agreement terms capture, template
// population, send-for-signature, and the e-sign webhook. Ready to List
// (routes/properties.ts) already creates the DocumentPackage/Document rows
// via lib/documentRules.ts — this router is what turns those Draft rows
// into generated, sendable, and eventually signed documents.
//
// #131/#135 cross-tenant IDOR fix: every handler below that loads a
// document/document-package/agency-agreement-terms record by a raw
// client-supplied id now passes req.authedUser.brokerageId into the
// lib/documents.ts function that does the actual tenant-scoped fetch —
// never a client-supplied tenant id, matching every other router in this
// app. See lib/documents.ts's own "Tenant chokepoints" comment for the
// fetch-time discipline this relies on.
export const documentsRouter = Router();

// R-F35b — Agency-agreement and listing documents are part of Run. Every
// session route requires run.access after requireAuth and before the
// handler's tenant check, matching routes/transactions.ts. The denial is
// requireEntitlement's existing 403. Two routes stay open because they
// have no session: POST /webhook (e-sign provider, HMAC over the raw
// body) and GET /signed-download/:versionId (the query signature is the
// credential; requireEntitlement would 401 every redemption). Grow
// appraisal presentation writes go through lib/documentStorage.ts, not
// these routes, and no Grow page calls them.
const requiresRunAccess = requireEntitlement("run.access");

// AE GROW Pilot Readiness WP9 — route-id validation, the same bounded guard
// routes/grow.ts, routes/communications.ts, routes/growAppraisals.ts and
// routes/propertyIntelligence.ts already use (each keeps its own local copy;
// this is deliberately not a shared module). Every route below took a raw
// `Number(req.params...)` straight into a tenant-scoped fetch, so "abc"
// reached Postgres as NaN and an id past int4 as an unbindable value — the
// driver error was then caught and returned to the caller as a 400 carrying
// its own "Failed query: select ..." text. Bounded by MAX_SIGNED_INT4
// because properties.id, documentPackages.id, documents.id and
// documentObjectVersions.id are all `serial` columns, i.e. int4.
const MAX_SIGNED_INT4 = 2_147_483_647;

function parsePositiveId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= MAX_SIGNED_INT4 ? n : null;
}

/** Resolves a route id, answering 400 itself and returning null when malformed. */
function readIdParam(
  res: Response,
  value: unknown,
  label: "property" | "document package" | "document" | "document version",
): number | null {
  const id = parsePositiveId(value);
  if (id === null) {
    res.status(400).json({ error: `Invalid ${label} id` });
    return null;
  }
  return id;
}

/** What an unrecognised error is allowed to tell a client. */
const GENERIC_DOCUMENT_ERROR = "An unexpected error occurred. Please try again or contact support if the problem persists.";

/** Driver/ORM text, as a second line of defence behind the prototype test below. */
const DRIVER_TEXT = /failed query|\bselect\b[\s\S]*\bfrom\b|\bparams:\s/i;

/**
 * True only for a plain `new Error("...")` — the shape lib/documents.ts uses
 * for its operator-authored, caller-facing messages ("Property 12 not found",
 * "DocumentPackage 3 not found", "Document package is not ready to send — all
 * documents must be generated first.", "At least one seller with an email
 * address is required to send for signature."). Those are deliberately kept
 * with this router's existing 400, and routes/__tests__/documents.test.ts
 * asserts two of them verbatim.
 *
 * Every driver/ORM/system error is a SUBCLASS of Error and therefore fails
 * this prototype-identity test: drizzle's DrizzleQueryError (whose message is
 * the `Failed query: select "id", "brokerage_id" ... from ...` text live
 * smoke testing found in real response bodies), pg's DatabaseError, and
 * RangeError/TypeError/SyntaxError. DrizzleQueryError notably does NOT
 * override `name` — it reports "Error" — so a name check alone would let the
 * leak straight through; only the prototype identity separates them.
 */
function isOperatorAuthoredError(err: unknown): err is Error {
  return err instanceof Error && Object.getPrototypeOf(err) === Error.prototype && !DRIVER_TEXT.test(err.message);
}

/**
 * Expected domain errors keep this router's existing 400 and their own
 * messages; anything else is an unrecognised server fault, logged in full
 * server-side (the structured logger attaches the ambient correlationId
 * itself — see packages/events/src/logger.ts) and answered generically.
 * Mirrors handleGrowAppraisalError / handlePropertyIntelligenceError.
 * (DocumentStorageError, this router's one typed error class, is mapped at
 * its own call sites below and never reaches here.)
 */
function handleDocumentError(err: unknown, res: Response): void {
  if (isOperatorAuthoredError(err)) {
    res.status(400).json({ error: err.message });
    return;
  }
  logger.error("document_route_unhandled_error", {
    error: err instanceof Error ? err.message : String(err),
    errorName: err instanceof Error ? (err.constructor?.name ?? err.name) : typeof err,
  });
  res.status(500).json({ error: GENERIC_DOCUMENT_ERROR });
}
const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: configuredMaxDocumentBytes(),
    files: 1,
    fields: 2,
    parts: 3,
    fieldNameSize: 64,
    fieldSize: 2_048,
    headerPairs: 32,
  },
});

const agencyTermsSchema = z
  .object({
    commissionType: z.enum(["Percentage", "FlatFee"]),
    commissionRateBps: z.number().int().min(0).max(10000).optional(),
    flatFeeCents: z.number().int().min(0).optional(),
    marketingFeeCents: z.number().int().min(0).optional(),
    agreementTermDays: z.number().int().min(1).default(90),
  })
  .refine((v) => v.commissionType !== "Percentage" || v.commissionRateBps !== undefined, {
    message: "commissionRateBps is required when commissionType is Percentage",
    path: ["commissionRateBps"],
  })
  .refine((v) => v.commissionType !== "FlatFee" || v.flatFeeCents !== undefined, {
    message: "flatFeeCents is required when commissionType is FlatFee",
    path: ["flatFeeCents"],
  });

documentsRouter.put("/agency-agreement-terms/:propertyId", requireAuth, requiresRunAccess, async (req, res) => {
  const propertyId = readIdParam(res, req.params.propertyId, "property");
  if (propertyId === null) return;
  const parsed = agencyTermsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;

  try {
    const terms = await upsertAgencyAgreementTerms({ propertyId, brokerageId: user.brokerageId, userId: user.id, ...parsed.data });

    await logAudit({
      brokerageId: user.brokerageId,
      userId: user.id,
      action: "agency_agreement_terms_updated",
      recordType: "agency_agreement_terms",
      recordId: String(terms.id),
      propertyId,
    });

    res.json({ terms });
  } catch (err) {
    handleDocumentError(err, res);
  }
});

// R-F40 — same 404 as GET /transactions/by-property. A missing property and
// a property in another brokerage are one result. No isolation metric: this
// slice does not add a tenant_isolation_rejection_total boundary.
async function propertyInBrokerage(propertyId: number, brokerageId: number): Promise<boolean> {
  const [property] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.brokerageId, brokerageId)));
  return property !== undefined;
}

documentsRouter.get("/agency-agreement-terms/:propertyId", requireAuth, requiresRunAccess, async (req, res) => {
  const propertyId = readIdParam(res, req.params.propertyId, "property");
  if (propertyId === null) return;
  const user = req.authedUser!;
  if (!(await propertyInBrokerage(propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const terms = await getAgencyAgreementTerms(propertyId, user.brokerageId);
    res.json({ terms });
  } catch (err) {
    handleDocumentError(err, res);
  }
});

// Template population — idempotent/incremental, safe to call again after
// agency terms are captured or a prior partial run (see lib/documents.ts).
documentsRouter.post("/packages/:packageId/populate", requireAuth, requiresRunAccess, async (req, res) => {
  const packageId = readIdParam(res, req.params.packageId, "document package");
  if (packageId === null) return;
  const user = req.authedUser!;
  try {
    const result = await populateDocumentPackage(packageId, user.brokerageId);
    res.json(result);
  } catch (err) {
    handleDocumentError(err, res);
  }
});

documentsRouter.post("/packages/:packageId/send-for-signature", requireAuth, requiresRunAccess, async (req, res) => {
  const packageId = readIdParam(res, req.params.packageId, "document package");
  if (packageId === null) return;
  const user = req.authedUser!;
  try {
    const { signatureRequest, created } = await sendPackageForSignature({
      packageId,
      userId: user.id,
      brokerageId: user.brokerageId,
    });
    await logAudit({
      brokerageId: user.brokerageId,
      userId: user.id,
      action: "document_package_sent_for_signature",
      recordType: "document_package",
      recordId: String(packageId),
      providerReference: signatureRequest.providerReference ?? undefined,
    });
    res.status(created ? 201 : 200).json({ signatureRequest, created });
  } catch (err) {
    handleDocumentError(err, res);
  }
});

// Provider webhook — same shape as POST /aml/webhook: unauthenticated,
// authenticity comes from the HMAC signature, verified against the exact
// raw bytes captured by app.ts's express.json({ verify }).
documentsRouter.post("/webhook", async (req, res) => {
  const signature = String(req.header("x-esign-signature") ?? req.header("x-webhook-signature") ?? "");
  if (!Buffer.isBuffer(req.rawBody)) {
    res.status(400).json({ error: "Raw webhook body is required" });
    return;
  }

  const result = await processEsignWebhook(req.rawBody, signature, req.body);

  if (result.reason === "webhooks_disabled") {
    res.setHeader("Retry-After", "300");
    res.status(503).json({
      received: false,
      processed: false,
      reason: result.reason,
    });
    return;
  }
  if (result.reason === "invalid_signature") {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }
  if (result.reason === "signature_request_not_found") {
    res.status(200).json({ received: true, processed: false, reason: result.reason });
    return;
  }
  if (result.reason === "completed_document_storage_retry_required") {
    res.setHeader("Retry-After", "30");
    res.status(503).json({ received: false, processed: false, reason: result.reason });
    return;
  }

  res.status(200).json({ received: true, processed: result.processed, reason: result.reason });
});

documentsRouter.get("/signed-download/:versionId", async (req, res) => {
  const versionId = readIdParam(res, req.params.versionId, "document version");
  if (versionId === null) return;
  const expires = Number(req.query.expires);
  const signature = typeof req.query.signature === "string" ? req.query.signature : "";
  try {
    const result = await redeemDocumentSignedDownload(versionId, expires, signature);
    const safeFilename = result.displayFilename.replace(/["\\]/g, "_");
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    await logAudit({
      brokerageId: result.version!.brokerageId,
      action: "document_signed_download_redeemed",
      recordType: "document_object_version",
      recordId: String(result.version!.id),
      propertyId: result.document.propertyId,
    });
    res.send(result.bytes);
  } catch {
    res.status(404).json({ error: "Signed document link is invalid, expired, or unavailable" });
  }
});

// Lets the agent preview a generated (or signed) document's stored content
// before sending it, or review what was actually sent (Phase 5 "completed
// document storage" needs to be genuinely retrievable, not just a key).
documentsRouter.get("/:documentId/content", requireAuth, requiresRunAccess, async (req, res) => {
  const documentId = readIdParam(res, req.params.documentId, "document");
  if (documentId === null) return;
  const user = req.authedUser!;
  try {
    const result = await getDocumentContent(documentId, user.brokerageId);
    if (!result) {
      res.status(404).json({ error: "No stored content for this document" });
      return;
    }
    const safeFilename = result.displayFilename.replace(/["\\]/g, "_");
    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    await logAudit({
      brokerageId: user.brokerageId,
      userId: user.id,
      action: "document_content_downloaded",
      recordType: result.versionId ? "document_object_version" : "document",
      recordId: String(result.versionId ?? documentId),
      propertyId: result.propertyId,
    });
    res.send(result.content);
  } catch {
    res.status(404).json({ error: "Stored content could not be read" });
  }
});

documentsRouter.post(
  "/:documentId/versions",
  requireAuth,
  requiresRunAccess,
  documentUpload.single("file"),
  async (req, res) => {
    const documentId = readIdParam(res, req.params.documentId, "document");
    if (documentId === null) return;
    const user = req.authedUser!;
    if (!req.file) {
      res.status(400).json({ error: "A document file is required" });
      return;
    }
    try {
      const stored = await ingestDocumentVersion({
        documentId,
        brokerageId: user.brokerageId,
        actorUserId: user.id,
        bytes: req.file.buffer,
        originalFilename: req.file.originalname,
        declaredMimeType: req.file.mimetype,
        replacementReason:
          typeof req.body.replacementReason === "string"
            ? req.body.replacementReason
            : undefined,
        retentionClass:
          typeof req.body.retentionClass === "string"
            ? req.body.retentionClass
            : undefined,
        source: "upload",
      });
      await logAudit({
        brokerageId: user.brokerageId,
        userId: user.id,
        action:
          stored.outcome === "created"
            ? "document_version_ingested"
            : stored.outcome === "resumed"
              ? "document_version_ingestion_reconciled"
              : "document_version_ingestion_deduplicated",
        recordType: "document_object_version",
        recordId: String(stored.version.id),
        propertyId: stored.version.propertyId,
        updatedValue: JSON.stringify({
          documentId,
          version: stored.version.version,
          byteSize: stored.version.byteSize,
          contentSha256: stored.version.contentSha256,
          retentionClass: stored.version.retentionClass,
        }),
      });
      res.status(stored.created ? 201 : 200).json({
        created: stored.created,
        outcome: stored.outcome,
        version: stored.version,
      });
    } catch (error) {
      if (error instanceof DocumentStorageError) {
        const status =
          error.code === "DOCUMENT_NOT_FOUND"
            ? 404
            : error.code === "DOCUMENT_TOO_LARGE"
              ? 413
              : 400;
        res.status(status).json({ error: error.message, code: error.code });
        return;
      }
      throw error;
    }
  },
);

documentsRouter.post("/:documentId/signed-download", requireAuth, requiresRunAccess, async (req, res) => {
  const documentId = readIdParam(res, req.params.documentId, "document");
  if (documentId === null) return;
  const user = req.authedUser!;
  try {
    const { version, download } = await createDocumentSignedDownload(
      documentId,
      user.brokerageId,
    );
    await logAudit({
      brokerageId: user.brokerageId,
      userId: user.id,
      action: "document_signed_download_created",
      recordType: "document_object_version",
      recordId: String(version.id),
      propertyId: version.propertyId,
    });
    res.json({
      url: download.url,
      expiresAt: download.expiresAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof DocumentStorageError) {
      res.status(404).json({ error: "Stored document could not be found" });
      return;
    }
    throw error;
  }
});

documentsRouter.post("/:documentId/quarantine", requireAuth, requiresRunAccess, async (req, res) => {
  const documentId = readIdParam(res, req.params.documentId, "document");
  if (documentId === null) return;
  const user = req.authedUser!;
  if (user.role !== "Brokerage Administrator") {
    res.status(403).json({ error: "Administrator access is required" });
    return;
  }
  try {
    const version = await quarantineDocument(documentId, user.brokerageId);
    await logAudit({
      brokerageId: user.brokerageId,
      userId: user.id,
      action: "document_version_quarantined",
      recordType: "document_object_version",
      recordId: String(version.id),
      propertyId: version.propertyId,
    });
    res.json({ version });
  } catch (error) {
    if (error instanceof DocumentStorageError) {
      res.status(404).json({ error: "Stored document could not be found" });
      return;
    }
    throw error;
  }
});

documentsRouter.get("/packages/by-property/:propertyId", requireAuth, requiresRunAccess, async (req, res) => {
  const propertyId = readIdParam(res, req.params.propertyId, "property");
  if (propertyId === null) return;
  const user = req.authedUser!;
  if (!(await propertyInBrokerage(propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const result = await getPackageByProperty(propertyId, user.brokerageId);
  res.json(result);
});

documentsRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    const isFileSize = error.code === "LIMIT_FILE_SIZE";
    res.status(413).json(
      isFileSize
        ? {
            error: "Document exceeds the configured size limit",
            code: "DOCUMENT_TOO_LARGE",
          }
        : {
            error: "Document upload exceeds the configured multipart limits",
            code: "DOCUMENT_UPLOAD_LIMIT",
          },
    );
    return;
  }
  next(error);
});
