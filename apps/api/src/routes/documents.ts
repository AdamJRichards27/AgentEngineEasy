import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middlewares/auth.js";
import { logAudit } from "../lib/audit.js";
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

documentsRouter.put("/agency-agreement-terms/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const parsed = agencyTermsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;

  try {
    const terms = await upsertAgencyAgreementTerms({ propertyId, brokerageId: user.brokerageId, userId: user.id, ...parsed.data });

    await logAudit({
      userId: user.id,
      action: "agency_agreement_terms_updated",
      recordType: "agency_agreement_terms",
      recordId: String(terms.id),
      propertyId,
    });

    res.json({ terms });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

documentsRouter.get("/agency-agreement-terms/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const user = req.authedUser!;
  try {
    const terms = await getAgencyAgreementTerms(propertyId, user.brokerageId);
    res.json({ terms });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Template population — idempotent/incremental, safe to call again after
// agency terms are captured or a prior partial run (see lib/documents.ts).
documentsRouter.post("/packages/:packageId/populate", requireAuth, async (req, res) => {
  const packageId = Number(req.params.packageId);
  const user = req.authedUser!;
  try {
    const result = await populateDocumentPackage(packageId, user.brokerageId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

documentsRouter.post("/packages/:packageId/send-for-signature", requireAuth, async (req, res) => {
  const packageId = Number(req.params.packageId);
  const user = req.authedUser!;
  try {
    const { signatureRequest, created } = await sendPackageForSignature({
      packageId,
      userId: user.id,
      brokerageId: user.brokerageId,
    });
    await logAudit({
      userId: user.id,
      action: "document_package_sent_for_signature",
      recordType: "document_package",
      recordId: String(packageId),
      providerReference: signatureRequest.providerReference ?? undefined,
    });
    res.status(created ? 201 : 200).json({ signatureRequest, created });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Provider webhook — same shape as POST /aml/webhook: unauthenticated,
// authenticity comes from the HMAC signature, verified against the exact
// raw bytes captured by app.ts's express.json({ verify }).
documentsRouter.post("/webhook", async (req, res) => {
  const signature = String(req.header("x-esign-signature") ?? req.header("x-webhook-signature") ?? "");
  const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));

  const result = await processEsignWebhook(rawBody, signature, req.body);

  if (result.reason === "invalid_signature") {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }
  if (result.reason === "signature_request_not_found") {
    res.status(200).json({ received: true, processed: false, reason: result.reason });
    return;
  }

  res.status(200).json({ received: true, processed: result.processed, reason: result.reason });
});

// Lets the agent preview a generated (or signed) document's stored content
// before sending it, or review what was actually sent (Phase 5 "completed
// document storage" needs to be genuinely retrievable, not just a key).
documentsRouter.get("/:documentId/content", requireAuth, async (req, res) => {
  const documentId = Number(req.params.documentId);
  const user = req.authedUser!;
  try {
    const result = await getDocumentContent(documentId, user.brokerageId);
    if (!result) {
      res.status(404).json({ error: "No stored content for this document" });
      return;
    }
    res.type("text/plain").send(result.content);
  } catch (err) {
    res.status(404).json({ error: "Stored content could not be read" });
  }
});

documentsRouter.get("/packages/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = Number(req.params.propertyId);
  const user = req.authedUser!;
  const result = await getPackageByProperty(propertyId, user.brokerageId);
  res.json(result);
});
