import { Router } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  properties,
  propertyParties,
  parties,
  workflows,
  workflowSteps,
  amlVerifications,
  documentPackages,
  documents,
  signatureRequests,
  agencyAgreementTerms,
  insertPropertySchema,
} from "@aee/db";
import { publishDomainEvent, newCorrelationId } from "@aee/events";
import { createPropertyDataProvider } from "@aee/integration-property-data";
import { requireAuth } from "../middlewares/auth.js";
import { logAudit } from "../lib/audit.js";
import { initiateAmlIfNeeded } from "../lib/aml.js";
import { determineRequiredDocuments, DOCUMENT_RULE_SET_VERSION } from "../lib/documentRules.js";
import { refreshReadyToListSteps } from "../lib/workflowSteps.js";

export const propertiesRouter = Router();
const propertyDataProvider = createPropertyDataProvider();

const READY_TO_LIST_STEPS = [
  { stepKey: "VerifySellers", label: "Verify Sellers", sequence: 1 },
  { stepKey: "AgencyAgreement", label: "Agency Agreement", sequence: 2 },
  { stepKey: "RequiredDocuments", label: "Required Documents", sequence: 3 },
];

// Start Property (Build Brief §3): search or manually create an address,
// establish the Property Record immediately, gather everything else
// progressively rather than via one large creation form.
propertiesRouter.get("/address-search", requireAuth, async (req, res) => {
  const query = String(req.query.q ?? "");
  if (!query) {
    res.status(400).json({ error: "q is required" });
    return;
  }
  const candidates = await propertyDataProvider.searchAddress(query);
  res.json({ candidates });
});

const startPropertySchema = z.object({
  formattedAddress: z.string().min(1),
  placeId: z.string().optional(),
  suburb: z.string().optional(),
  state: z.string().optional(),
  postcode: z.string().optional(),
  isManualAddress: z.boolean().optional().default(false),
});

propertiesRouter.post("/", requireAuth, async (req, res) => {
  const parsed = startPropertySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;

  let ownershipData = null;
  if (parsed.data.placeId) {
    // Ownership check (Build Brief §8) — surfaced as a review prompt later,
    // never a hard block, since trusts/companies/estates/POAs can legitimately differ.
    // No sellers exist yet at this point, so this only fetches the data —
    // the actual comparison runs in reviewOwnershipForProperty() once a
    // Seller party is added (see routes/parties.ts).
    ownershipData = await propertyDataProvider.lookupOwnership(parsed.data.placeId);
  }

  const [property] = await db
    .insert(properties)
    .values({
      brokerageId: user.brokerageId,
      agentId: user.id,
      formattedAddress: parsed.data.formattedAddress,
      placeId: parsed.data.placeId,
      suburb: parsed.data.suburb,
      state: parsed.data.state,
      postcode: parsed.data.postcode,
      isManualAddress: parsed.data.isManualAddress,
      ownershipData,
    })
    .returning();

  const correlationId = newCorrelationId();

  await logAudit({
    userId: user.id,
    action: "property_created",
    recordType: "property",
    recordId: String(property.id),
    propertyId: property.id,
  });

  try {
    await publishDomainEvent({
      eventType: "PROPERTY_CREATED",
      occurredAt: new Date(),
      propertyId: property.id,
      transactionId: null,
      partyId: null,
      brokerageId: user.brokerageId,
      agentId: user.id,
      actorType: "USER",
      actorId: user.id,
      source: "api:properties:start",
      correlationId,
      causationId: null,
      idempotencyKey: `property-created:${property.id}`,
      payload: { propertyId: property.id },
      metadata: {},
    });
  } catch (err) {
    console.error("publishDomainEvent(PROPERTY_CREATED) failed", err);
  }

  res.status(201).json({ property });
});

propertiesRouter.get("/", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const rows = await db.select().from(properties).where(eq(properties.brokerageId, user.brokerageId));
  res.json({ properties: rows });
});

propertiesRouter.get("/:id", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const [property] = await db.select().from(properties).where(eq(properties.id, id));
  if (!property) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ property });
});

// The Property Action Screen's data source (ARCHITECTURE.md §4) — one
// response shaped for "what needs to happen next", not fifteen sub-screens.
propertiesRouter.get("/:id/workspace", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const [property] = await db.select().from(properties).where(eq(properties.id, id));
  if (!property) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const links = await db.select().from(propertyParties).where(eq(propertyParties.propertyId, id));
  const partyIds = links.map((l) => l.partyId);
  // Multi-seller capture (Phase 2): fetch every linked party, not just the
  // first — the original Phase 1 version of this query only ever returned
  // one party regardless of how many were linked.
  const partyRows = partyIds.length ? await db.select().from(parties).where(inArray(parties.id, partyIds)) : [];

  // Phase 3: per-party AML status, matching the shape ARCHITECTURE.md §4
  // originally documented (`parties: [{ name, role, amlStatus }]`).
  const verifications = partyIds.length
    ? await db.select().from(amlVerifications).where(
        and(eq(amlVerifications.propertyId, id), inArray(amlVerifications.partyId, partyIds)),
      )
    : [];

  const [workflow] = await db.select().from(workflows).where(eq(workflows.propertyId, id));
  const steps = workflow
    ? await db.select().from(workflowSteps).where(eq(workflowSteps.workflowId, workflow.id))
    : [];

  const [docPackage] = await db
    .select()
    .from(documentPackages)
    .where(and(eq(documentPackages.propertyId, id), eq(documentPackages.purpose, "ReadyToList")));
  const packageDocuments = docPackage
    ? await db.select().from(documents).where(eq(documents.packageId, docPackage.id))
    : [];
  // Phase 5: signature status + whether commission terms have been
  // captured yet, so the workspace can offer "generate"/"send"/"resolve
  // missing terms" without a separate round trip.
  const [signatureRequest] = docPackage
    ? await db.select().from(signatureRequests).where(eq(signatureRequests.packageId, docPackage.id))
    : [];
  const [agreementTerms] = await db.select().from(agencyAgreementTerms).where(eq(agencyAgreementTerms.propertyId, id));

  res.json({
    property: {
      id: property.id,
      formattedAddress: property.formattedAddress,
      suburb: property.suburb,
      state: property.state,
      postcode: property.postcode,
      isManualAddress: property.isManualAddress,
      workflowStage: property.workflowStage,
      amlStatusSummary: property.amlStatusSummary,
      listingStatus: property.listingStatus,
    },
    ownership: {
      data: property.ownershipData,
      reviewRequired: property.ownershipReviewRequired,
      reviewedBy: property.ownershipReviewedBy,
      reviewedAt: property.ownershipReviewedAt,
      reviewNotes: property.ownershipReviewNotes,
    },
    parties: links.map((link) => {
      const verification = verifications.find((v) => v.partyId === link.partyId);
      return {
        linkId: link.id,
        role: link.role,
        isPrimary: link.isPrimary,
        partyId: link.partyId,
        party: partyRows.find((p) => p.id === link.partyId) ?? null,
        amlStatus: verification?.status ?? null,
        // Phase 4: lets the workspace offer retry/resolve-exception actions
        // directly against the verification without a separate lookup.
        amlVerificationId: verification?.id ?? null,
        amlException:
          verification && (verification.status === "Review Required" || verification.status === "Failed")
            ? { outcome: verification.outcome, riskLevel: verification.riskLevel }
            : null,
      };
    }),
    nextActions: steps
      .sort((a, b) => a.sequence - b.sequence)
      .map((s) => ({ label: s.label, status: s.status, blockedReason: s.blockedReason })),
    documentPackage: docPackage
      ? {
          id: docPackage.id,
          status: docPackage.status,
          documents: packageDocuments.map((d) => ({
            id: d.id,
            documentType: d.documentType,
            title: d.title,
            status: d.status,
          })),
          signatureRequest: signatureRequest
            ? { id: signatureRequest.id, status: signatureRequest.status, sentAt: signatureRequest.sentAt, completedAt: signatureRequest.completedAt }
            : null,
        }
      : null,
    agencyAgreementTerms: agreementTerms ?? null,
  });
});

// Ownership review resolution (Build Brief §8): the agent clears the review
// flag with an optional note — this never blocked property progress, it
// only surfaced a prompt, so resolving it is a simple acknowledgement.
const ownershipReviewSchema = z.object({ notes: z.string().optional() });

propertiesRouter.post("/:id/ownership-review", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const parsed = ownershipReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;

  const [property] = await db.select().from(properties).where(eq(properties.id, id));
  if (!property) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const [updated] = await db
    .update(properties)
    .set({
      ownershipReviewRequired: false,
      ownershipReviewedBy: user.id,
      ownershipReviewedAt: new Date(),
      ownershipReviewNotes: parsed.data.notes ?? null,
      updatedAt: new Date(),
    })
    .where(eq(properties.id, id))
    .returning();

  await logAudit({
    userId: user.id,
    action: "ownership_review_resolved",
    recordType: "property",
    recordId: String(id),
    propertyId: id,
    updatedValue: parsed.data.notes,
  });

  res.json({ property: updated });
});

// Ready to List (Build Brief §5): once selected, AgentEngineEasy determines
// and orchestrates the required next steps — the agent does not separately
// visit an AML screen, a documents screen, and an e-signature screen.
// Phase 3 (ARCHITECTURE.md §10): gates on at least one seller being
// captured, initiates AML for every seller (idempotently — see
// lib/aml.ts), determines and creates the required document package
// (idempotently), and recomputes the workflow's step statuses from that
// live state (lib/workflowSteps.ts). Ownership review, by contrast,
// intentionally does NOT gate this — see lib/ownership.ts / Build Brief §8.
propertiesRouter.post("/:id/ready-to-list", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  const [property] = await db.select().from(properties).where(eq(properties.id, id));
  if (!property) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const links = await db.select().from(propertyParties).where(eq(propertyParties.propertyId, id));
  const sellerLinks = links.filter((l) => l.role === "Seller");
  if (sellerLinks.length === 0) {
    res.status(400).json({ error: "At least one seller must be captured before Ready to List." });
    return;
  }

  // Idempotent: re-running Ready to List (e.g. a double click, or calling it
  // again after adding another seller) reuses the existing workflow rather
  // than creating a second one.
  let [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.propertyId, id), eq(workflows.workflowType, "ReadyToList")));
  if (!workflow) {
    [workflow] = await db.insert(workflows).values({ propertyId: id, workflowType: "ReadyToList" }).returning();
    await db.insert(workflowSteps).values(READY_TO_LIST_STEPS.map((step) => ({ workflowId: workflow.id, ...step })));
  }

  // AML initiation — one order per seller, never a duplicate (Build Brief
  // critical idempotency requirement) — see lib/aml.ts.
  for (const link of sellerLinks) {
    try {
      await initiateAmlIfNeeded({
        propertyId: id,
        partyId: link.partyId,
        userId: user.id,
        brokerageId: user.brokerageId,
      });
    } catch (err) {
      console.error(`initiateAmlIfNeeded failed for party ${link.partyId}`, err);
    }
  }

  // Required-document determination + package creation — idempotent: only
  // created once per property (see the ReadyToList-purpose lookup below).
  let [docPackage] = await db
    .select()
    .from(documentPackages)
    .where(and(eq(documentPackages.propertyId, id), eq(documentPackages.purpose, "ReadyToList")));
  if (!docPackage) {
    const required = determineRequiredDocuments(property.state);
    [docPackage] = await db
      .insert(documentPackages)
      .values({
        propertyId: id,
        purpose: "ReadyToList",
        state: property.state,
        status: "Preparing",
        ruleSetVersion: DOCUMENT_RULE_SET_VERSION,
      })
      .returning();
    await db.insert(documents).values(
      required.map((r) => ({
        propertyId: id,
        packageId: docPackage.id,
        documentType: r.documentType,
        title: r.title,
        status: "Draft",
      })),
    );

    try {
      await publishDomainEvent({
        eventType: "DOCUMENT_PACKAGE_CREATED",
        occurredAt: new Date(),
        propertyId: id,
        transactionId: null,
        partyId: null,
        brokerageId: user.brokerageId,
        agentId: user.id,
        actorType: "USER",
        actorId: user.id,
        source: "api:properties:ready-to-list",
        correlationId: newCorrelationId(),
        causationId: null,
        idempotencyKey: `document-package-created:${docPackage.id}`,
        payload: { packageId: docPackage.id, documentTypes: required.map((r) => r.documentType) },
        metadata: {},
      });
    } catch (err) {
      console.error("publishDomainEvent(DOCUMENT_PACKAGE_CREATED) failed", err);
    }
  }

  await refreshReadyToListSteps(id);

  await db.update(properties).set({ workflowStage: "Ready to List" }).where(eq(properties.id, id));

  try {
    await publishDomainEvent({
      eventType: "READY_TO_LIST",
      occurredAt: new Date(),
      propertyId: id,
      transactionId: null,
      partyId: null,
      brokerageId: user.brokerageId,
      agentId: user.id,
      actorType: "USER",
      actorId: user.id,
      source: "api:properties:ready-to-list",
      correlationId: newCorrelationId(),
      causationId: null,
      idempotencyKey: `ready-to-list:${id}`,
      payload: { propertyId: id, workflowId: workflow.id },
      metadata: {},
    });
  } catch (err) {
    console.error("publishDomainEvent(READY_TO_LIST) failed", err);
  }

  const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.workflowId, workflow.id));
  res.json({ workflow, steps, documentPackage: docPackage });
});

// Go Live (Phase 7, ARCHITECTURE.md §10) — the transition into "able to
// receive offers." Gated on the Ready to List workflow being fully
// Complete (every step) — the same "gate on real completion, not on the
// button having been clicked" discipline as everywhere else in this app.
// This was a genuine pre-existing gap: nothing before Phase 7 ever moved a
// property to "Listed" or published LISTING_LIVE despite both existing in
// the schema/event registry since Phase 1.
propertiesRouter.post("/:id/go-live", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  const user = req.authedUser!;
  const [property] = await db.select().from(properties).where(eq(properties.id, id));
  if (!property) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const [workflow] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.propertyId, id), eq(workflows.workflowType, "ReadyToList")));
  if (!workflow) {
    res.status(400).json({ error: "Ready to List has not been started for this property." });
    return;
  }
  const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.workflowId, workflow.id));
  const incomplete = steps.filter((s) => s.status !== "Complete");
  if (incomplete.length > 0) {
    res.status(400).json({
      error: "Ready to List is not fully complete yet.",
      incompleteSteps: incomplete.map((s) => ({ label: s.label, status: s.status, blockedReason: s.blockedReason })),
    });
    return;
  }

  if (property.listingStatus !== "Listed") {
    await db
      .update(properties)
      .set({ workflowStage: "Listed", listingStatus: "Listed", updatedAt: new Date() })
      .where(eq(properties.id, id));

    try {
      await publishDomainEvent({
        eventType: "LISTING_LIVE",
        occurredAt: new Date(),
        propertyId: id,
        transactionId: null,
        partyId: null,
        brokerageId: user.brokerageId,
        agentId: user.id,
        actorType: "USER",
        actorId: user.id,
        source: "api:properties:go-live",
        correlationId: newCorrelationId(),
        causationId: null,
        idempotencyKey: `listing-live:${id}`,
        payload: { propertyId: id },
        metadata: {},
      });
    } catch (err) {
      console.error("publishDomainEvent(LISTING_LIVE) failed", err);
    }

    await logAudit({
      userId: user.id,
      action: "listing_live",
      recordType: "property",
      recordId: String(id),
      propertyId: id,
    });
  }

  const [updated] = await db.select().from(properties).where(eq(properties.id, id));
  res.json({ property: updated });
});

export const _internal = { insertPropertySchema }; // re-export for tests
