import { Router } from "express";
import { eq, and, inArray, ne, ilike, or } from "drizzle-orm";
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
  WORKFLOW_STAGES,
} from "@aee/db";
import { publishDomainEvent, currentCorrelationId, incrementCounter, logger } from "@aee/events";
import { createPropertyDataProvider } from "@aee/integration-property-data";
import { requireAuth, BROKERAGE_ADMIN_ROLES, type AuthedUser } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { restrictedPropertyIdsFor } from "../lib/propertyVisibility.js";
import { logAudit } from "../lib/audit.js";
import { initiateAmlIfNeeded } from "../lib/aml.js";
import { determineRequiredDocuments, DOCUMENT_RULE_SET_VERSION } from "../lib/documentRules.js";
import { refreshReadyToListSteps } from "../lib/workflowSteps.js";
import { getPropertyTimeline } from "../lib/timeline.js";
import { getAppraisalByProperty } from "../lib/appraisals.js";
import { goLiveProperty } from "../lib/goLive.js";

export const propertiesRouter = Router();

// R-F35b — Ready to List and Go Live are Run transitions. Applied only on
// those two routes (not Router.use): Grow appraisal workspace reads
// GET /:id/timeline on this same router, and the Grow -> Run handoff does
// not call either route — it only prepares a seller link, and the agent's
// later Ready to List click is the Run action. Order matches
// routes/transactions.ts: requireAuth, then run.access, then the
// handler's tenant lookup, so an unentitled caller is refused without a
// same-brokerage existence oracle. Denial is requireEntitlement's
// existing 403.
const requiresRunAccess = requireEntitlement("run.access");
const propertyDataProvider = createPropertyDataProvider();

// AE GROW Pilot Readiness WP6a (D1-residual): a malformed :id is a malformed
// request (400), not a server fault (500). Before this guard, `Number("abc")`
// produced NaN and `Number("1e20")` an integer outside Postgres' int4 range,
// and both were passed straight into a `where(eq(properties.id, ...))` bind
// the driver rejects — a 500 with a database diagnostic in the log for what
// is simply a mistyped URL. Bounded by MAX_SIGNED_INT4 because properties.id
// is a `serial` (packages/db/src/schema/property.ts), i.e. an int4. Same
// shape as routes/contacts.ts's parsePositiveId and routes/growCalls.ts's
// parseIdParam; this codebase has no shared cross-router helper today, each
// route module declares its own.
const MAX_SIGNED_INT4 = 2_147_483_647;

function parsePositiveId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= MAX_SIGNED_INT4 ? n : null;
}

/* ---------------------------------------------------------------------
 * AE GROW Pilot Readiness WP9 — internal error text must never reach a
 * client. Same shape as routes/growAppraisals.ts's handleGrowAppraisalError
 * and routes/propertyIntelligence.ts's handlePropertyIntelligenceError.
 * -----------------------------------------------------------------*/

/** What an unrecognised error is allowed to tell a client. */
const GENERIC_PROPERTY_ERROR = "An unexpected error occurred. Please try again or contact support if the problem persists.";

/** Driver/ORM text, as a second line of defence behind the prototype test below. */
const DRIVER_TEXT = /failed query|\bselect\b[\s\S]*\bfrom\b|\bparams:\s/i;

/**
 * True only for a plain `new Error("...")` — the shape lib/timeline.ts's
 * assertPropertyInBrokerage uses for its operator-authored, caller-facing
 * "Property 12 not found" (deliberately uniform for a missing property AND a
 * cross-tenant one, so the two are indistinguishable), which is kept with
 * this route's existing 404.
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
 * The expected not-found error keeps its 404 and its own message; anything
 * else is an unrecognised server fault, logged in full server-side with this
 * request's correlation id and answered generically. (The structured logger
 * already attaches the ambient correlationId itself — see
 * packages/events/src/logger.ts — but this router threads it explicitly
 * everywhere else it logs, so it does so here too.)
 */
function handlePropertyError(err: unknown, res: import("express").Response, expectedStatus: number): void {
  if (isOperatorAuthoredError(err)) {
    res.status(expectedStatus).json({ error: err.message });
    return;
  }
  logger.error("property_route_unhandled_error", {
    correlationId: currentCorrelationId(),
    error: err instanceof Error ? err.message : String(err),
    errorName: err instanceof Error ? (err.constructor?.name ?? err.name) : typeof err,
  });
  res.status(500).json({ error: GENERIC_PROPERTY_ERROR });
}

// R-F9 — the property boundary of tenant_isolation_rejection_total.
// The brokerage-scoped load cannot tell a missing property from one in
// another brokerage. On a miss only, one existence lookup (never on the
// success path) checks whether that id belongs to another brokerage and,
// if so, increments once. The lookup selects no brokerage id and no other
// tenant's columns. Callers still answer 404 either way. Same rule as
// routes/transactions.ts and routes/offers.ts: a missing row does not
// increment, and the other brokerage's id is not logged or returned.
async function notePropertyIsolationRejection(propertyId: number, brokerageId: number): Promise<void> {
  if (!Number.isInteger(propertyId) || propertyId <= 0) return;
  const [elsewhere] = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(eq(properties.id, propertyId), ne(properties.brokerageId, brokerageId)));
  if (elsewhere) {
    incrementCounter("tenant_isolation_rejection_total", { boundary: "property" });
  }
}

/** True when this caller is an ordinary Agent (or any non-brokerage-wide role)
 * and the property is not one they are the agent for. Brokerage Administrator
 * and Pit Crew are not hidden: restrictedPropertyIdsFor returns null for them. */
async function propertyHiddenFromCaller(user: AuthedUser, propertyId: number): Promise<boolean> {
  const restrictTo = await restrictedPropertyIdsFor(user);
  return restrictTo !== null && !restrictTo.includes(propertyId);
}

async function loadPropertyInBrokerage(propertyId: number, brokerageId: number) {
  const [property] = await db
    .select()
    .from(properties)
    .where(and(eq(properties.id, propertyId), eq(properties.brokerageId, brokerageId)));
  if (!property) {
    await notePropertyIsolationRejection(propertyId, brokerageId);
    return null;
  }
  return property;
}

const READY_TO_LIST_STEPS = [
  { stepKey: "VerifySellers", label: "Verify Sellers", sequence: 1 },
  { stepKey: "AgencyAgreement", label: "Agency Agreement", sequence: 2 },
  { stepKey: "RequiredDocuments", label: "Required Documents", sequence: 3 },
];

const READY_TO_LIST_STAGE = "Ready to List";
const PROPERTY_READY_TO_LIST_AUDIT = "PROPERTY_READY_TO_LIST";

// Appraisal is the only WORKFLOW_STAGES value before Ready to List. Grow's
// run handoff does not write workflowStage, so a handed-off property is
// still at Appraisal — that is the stage this action is meant to leave.
function readyToListTransition(stage: string): "advance" | "replay" | "refuse" {
  if (stage === READY_TO_LIST_STAGE) return "replay";
  const index = WORKFLOW_STAGES.findIndex((known) => known === stage);
  const readyIndex = WORKFLOW_STAGES.indexOf(READY_TO_LIST_STAGE);
  if (index >= 0 && index < readyIndex) return "advance";
  return "refuse";
}

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

function nonBlank(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

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

  // A Places suggestion's description is one line ("120 Given Terrace,
  // Paddington QLD, Australia") and does not include the postcode. The
  // client sends whatever components the search already resolved; any that
  // are still missing are filled from Place Details. Explicit values win, so
  // a hand-entered suburb/state/postcode is kept. A failed lookup does not
  // block creating the property.
  let suburb = nonBlank(parsed.data.suburb);
  let state = nonBlank(parsed.data.state);
  let postcode = nonBlank(parsed.data.postcode);
  const placeId = nonBlank(parsed.data.placeId);
  if (placeId && (!suburb || !state || !postcode)) {
    try {
      const resolved = await propertyDataProvider.resolveAddress(placeId);
      if (resolved) {
        suburb = suburb ?? nonBlank(resolved.suburb);
        state = state ?? nonBlank(resolved.state);
        postcode = postcode ?? nonBlank(resolved.postcode);
      }
    } catch (err) {
      logger.warn("property_address_parts_unresolved", {
        correlationId: currentCorrelationId(),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const [property] = await db
    .insert(properties)
    .values({
      brokerageId: user.brokerageId,
      agentId: user.id,
      formattedAddress: parsed.data.formattedAddress,
      placeId: parsed.data.placeId,
      suburb,
      state,
      postcode,
      isManualAddress: parsed.data.isManualAddress,
      ownershipData,
    })
    .returning();

  const correlationId = currentCorrelationId();

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
    logger.error("publish_domain_event_failed", { eventType: "PROPERTY_CREATED", error: err });
  }

  res.status(201).json({ property });
});

// UAT-S1 — optional property-list search. `properties` has no display-name
// or reference column; the address columns are formatted_address, suburb,
// state, and postcode. An empty `q` leaves the query exactly as it was
// (no extra predicate, no order, no limit). Tenant scope and the #147
// visibility rule stay in the same WHERE as the search.
const PROPERTY_LIST_QUERY_MAX = 100;

function propertyListQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, PROPERTY_LIST_QUERY_MAX);
}

// Postgres ILIKE uses `\` as the default escape. Escape it along with the
// two wildcards before wrapping the term in `%`, and bind the result as a
// parameter via drizzle's `ilike` (never string-concatenated SQL).
function escapeIlikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function propertyListSearch(q: string) {
  const pattern = `%${escapeIlikePattern(q)}%`;
  return or(
    ilike(properties.formattedAddress, pattern),
    ilike(properties.suburb, pattern),
    ilike(properties.state, pattern),
    ilike(properties.postcode, pattern),
  );
}

propertiesRouter.get("/", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const q = propertyListQuery(req.query.q);
  const restrictTo = await restrictedPropertyIdsFor(user);
  if (restrictTo !== null && restrictTo.length === 0) {
    res.json({ properties: [] });
    return;
  }
  const scope =
    restrictTo === null
      ? eq(properties.brokerageId, user.brokerageId)
      : and(eq(properties.brokerageId, user.brokerageId), inArray(properties.id, restrictTo));
  const rows = await db
    .select()
    .from(properties)
    .where(q ? and(scope, propertyListSearch(q)) : scope);
  res.json({ properties: rows });
});

// #123 — tenant scoping: previously matched by id alone, so any
// authenticated user from any brokerage could read any property by id.
propertiesRouter.get("/:id", requireAuth, async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (id === null) return void res.status(400).json({ error: "Invalid property id." });
  const user = req.authedUser!;
  const property = await loadPropertyInBrokerage(id, user.brokerageId);
  if (!property) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Same 404 as a property outside this brokerage. The isolation counter
  // already ran inside loadPropertyInBrokerage only when the row belongs to
  // another brokerage, so a same-brokerage property owned by someone else
  // does not increment it.
  if (await propertyHiddenFromCaller(user, id)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ property });
});

// The Property Action Screen's data source (ARCHITECTURE.md §4) — one
// response shaped for "what needs to happen next", not fifteen sub-screens.
// #123 — same tenant-scoping fix as GET /:id above.
propertiesRouter.get("/:id/workspace", requireAuth, async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (id === null) return void res.status(400).json({ error: "Invalid property id." });
  const user = req.authedUser!;
  const property = await loadPropertyInBrokerage(id, user.brokerageId);
  if (!property) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (await propertyHiddenFromCaller(user, id)) {
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
  // Stage A (#114) — surfaced additively; an unstarted appraisal is simply
  // null here, never a blocking field.
  const appraisal = await getAppraisalByProperty(id, user.brokerageId);

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
      salesMethod: property.salesMethod,
      priceDisplay: property.priceDisplay,
      campaignStartDate: property.campaignStartDate,
      campaignEndDate: property.campaignEndDate,
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
    appraisal,
  });
});

// Property Timeline (#131-#134) — a dedicated endpoint, separate from the
// workspace aggregate above, so a Timeline-only refresh doesn't require
// refetching the whole workspace and vice versa (#131 design doc §3/§4).
// Same #123-precedent tenant scoping as every other :id route in this
// file; canViewFinancials gates the financial-entitlement boundary
// (commission/funds/agent-paid figures) inside getPropertyTimeline itself.
propertiesRouter.get("/:id/timeline", requireAuth, async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (id === null) return void res.status(400).json({ error: "Invalid property id." });
  const user = req.authedUser!;
  const canViewFinancials = BROKERAGE_ADMIN_ROLES.includes(user.role);
  try {
    if (await propertyHiddenFromCaller(user, id)) {
      // Resolve brokerage membership before answering, so a cross-tenant id
      // still records tenant_isolation_rejection_total once (inside
      // loadPropertyInBrokerage) and a same-brokerage property owned by
      // someone else does not. The body matches assertPropertyInBrokerage.
      await loadPropertyInBrokerage(id, user.brokerageId);
      res.status(404).json({ error: `Property ${id} not found` });
      return;
    }
    const timeline = await getPropertyTimeline(id, user.brokerageId, canViewFinancials);
    res.json({ timeline });
  } catch (err) {
    // getPropertyTimeline's only expected failure is assertPropertyInBrokerage's
    // own "Property <id> not found" — the 404 this route has always answered.
    // A driver fault used to be returned here verbatim as a 404 carrying the
    // driver's message; it is now a logged, generic 500.
    // R-F9 — that not-found covers both a missing property and one in another
    // brokerage. Count only the latter. The thrown message, and therefore
    // this 404 body, stays exactly as assertPropertyInBrokerage wrote it.
    if (isOperatorAuthoredError(err) && err.message === `Property ${id} not found`) {
      await notePropertyIsolationRejection(id, user.brokerageId);
    }
    handlePropertyError(err, res, 404);
  }
});

// Ownership review resolution (Build Brief §8): the agent clears the review
// flag with an optional note — this never blocked property progress, it
// only surfaced a prompt, so resolving it is a simple acknowledgement.
const ownershipReviewSchema = z.object({ notes: z.string().optional() });

propertiesRouter.post("/:id/ownership-review", requireAuth, async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (id === null) return void res.status(400).json({ error: "Invalid property id." });
  const parsed = ownershipReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;

  const property = await loadPropertyInBrokerage(id, user.brokerageId);
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

// Stage C — Listing preparation (#116). Purely descriptive/informational
// fields shown ahead of Go Live — never publishes a listing, orders a
// supplier, or incurs a cost (governing spec §8 excludes both from this
// build). Any subset may be sent; an omitted field keeps its current value.
const listingDetailsSchema = z.object({
  salesMethod: z.string().optional(),
  priceDisplay: z.string().optional(),
  campaignStartDate: z.coerce.date().optional(),
  campaignEndDate: z.coerce.date().optional(),
});

propertiesRouter.post("/:id/listing-details", requireAuth, async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (id === null) return void res.status(400).json({ error: "Invalid property id." });
  const parsed = listingDetailsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;
  const property = await loadPropertyInBrokerage(id, user.brokerageId);
  if (!property) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const [updated] = await db
    .update(properties)
    .set({
      salesMethod: parsed.data.salesMethod ?? property.salesMethod,
      priceDisplay: parsed.data.priceDisplay ?? property.priceDisplay,
      campaignStartDate: parsed.data.campaignStartDate ?? property.campaignStartDate,
      campaignEndDate: parsed.data.campaignEndDate ?? property.campaignEndDate,
      updatedAt: new Date(),
    })
    .where(eq(properties.id, id))
    .returning();

  await logAudit({
    userId: user.id,
    action: "listing_details_updated",
    recordType: "property",
    recordId: String(id),
    propertyId: id,
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
propertiesRouter.post("/:id/ready-to-list", requireAuth, requiresRunAccess, async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (id === null) return void res.status(400).json({ error: "Invalid property id." });
  const user = req.authedUser!;
  const property = await loadPropertyInBrokerage(id, user.brokerageId);
  if (!property) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  // R-F31: never walk a later stage back to Ready to List. Refusal is the
  // same 400 { error: string } this handler already uses (no 409 stage
  // conflict exists in this file) and it returns before any write.
  const transition = readyToListTransition(property.workflowStage);
  if (transition === "refuse") {
    res.status(400).json({
      error: `Ready to List cannot move a property that is already at ${property.workflowStage}.`,
    });
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
      logger.error("initiate_aml_if_needed_failed", { partyId: link.partyId, error: err });
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
        correlationId: currentCorrelationId(),
        causationId: null,
        idempotencyKey: `document-package-created:${docPackage.id}`,
        payload: { packageId: docPackage.id, documentTypes: required.map((r) => r.documentType) },
        metadata: {},
      });
    } catch (err) {
      logger.error("publish_domain_event_failed", { eventType: "DOCUMENT_PACKAGE_CREATED", error: err });
    }
  }

  await refreshReadyToListSteps(id);

  // Replay at Ready to List writes neither the stage nor an audit row.
  // The conditional stage match is the backstop if the row moved on after
  // the read above: a later stage is left where it is, and no audit is written.
  if (transition === "advance") {
    const [advanced] = await db
      .update(properties)
      .set({ workflowStage: READY_TO_LIST_STAGE, updatedAt: new Date() })
      .where(and(eq(properties.id, id), eq(properties.workflowStage, property.workflowStage)))
      .returning({ id: properties.id });
    if (advanced) {
      await logAudit({
        brokerageId: user.brokerageId,
        userId: user.id,
        action: PROPERTY_READY_TO_LIST_AUDIT,
        recordType: "property",
        recordId: String(id),
        propertyId: id,
        previousValue: property.workflowStage,
        updatedValue: READY_TO_LIST_STAGE,
      });
    }
  }

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
      correlationId: currentCorrelationId(),
      causationId: null,
      idempotencyKey: `ready-to-list:${id}`,
      payload: { propertyId: id, workflowId: workflow.id },
      metadata: {},
    });
  } catch (err) {
    logger.error("publish_domain_event_failed", { eventType: "READY_TO_LIST", error: err });
  }

  const steps = await db.select().from(workflowSteps).where(eq(workflowSteps.workflowId, workflow.id));
  res.json({ workflow, steps, documentPackage: docPackage });
});

// Go Live (Phase 7, ARCHITECTURE.md §10) — the transition into "able to
// receive offers." Gated on the Ready to List workflow being fully
// Complete (every step) — the same "gate on real completion, not on the
// button having been clicked" discipline as everywhere else in this app.
// Agent Engine 2.0 — Property Launch & Campaign Coordination: the actual
// gating/transition logic now lives in lib/goLive.ts's goLiveProperty(),
// shared with Launch's own confirmLaunchLive() — this route is a thin
// HTTP wrapper over it, not a second implementation.
propertiesRouter.post("/:id/go-live", requireAuth, requiresRunAccess, async (req, res) => {
  const id = parsePositiveId(req.params.id);
  if (id === null) return void res.status(400).json({ error: "Invalid property id." });
  const user = req.authedUser!;
  const property = await loadPropertyInBrokerage(id, user.brokerageId);
  if (!property) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const result = await goLiveProperty(id, user.brokerageId, { id: user.id }, "api:properties:go-live");
  if (!result.ok) {
    if (result.reason === "NO_READY_TO_LIST_WORKFLOW") {
      res.status(400).json({ error: "Ready to List has not been started for this property." });
      return;
    }
    res.status(400).json({
      error: "Ready to List is not fully complete yet.",
      incompleteSteps: result.incompleteSteps,
    });
    return;
  }

  res.json({ property: result.property });
});

export const _internal = { insertPropertySchema }; // re-export for tests
