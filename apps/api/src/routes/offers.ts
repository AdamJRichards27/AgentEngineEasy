import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db, offers, properties } from "@aee/db";
import { incrementCounter, logger } from "@aee/events";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import {
  createOffer,
  listOffersForProperty,
  withdrawOffer,
  declineOffer,
  getOfferByShareToken,
  toOfferView,
  getShareLinkStatus,
  revokeOfferShareLinks,
  reissueOfferShareLink,
  SHARE_LINK_MAX_EXPIRY_DAYS,
} from "../lib/offers.js";
import { acceptOffer } from "../lib/transactions.js";

export const offersRouter = Router();

// R-F2 — authenticated offer routes are the same Run surface as transactions
// (accept is the chokepoint that creates a transaction). requireEntitlement("run.access")
// sits after requireAuth and before the handler's tenant check, matching
// routes/transactions.ts. GET /public/:shareToken stays unauthenticated: it is
// the buyer status link (no session), not an agent Run route.
const requiresRunAccess = requireEntitlement("run.access");

// AE GROW Pilot Readiness WP9 — route-id validation, the same bounded guard
// routes/grow.ts, routes/communications.ts, routes/growAppraisals.ts and
// routes/propertyIntelligence.ts already use (each keeps its own local copy;
// this is deliberately not a shared module). Every :propertyId / :id route
// below took a raw `Number(req.params...)` straight into a
// `where(eq(..., ...))` bind, so "abc" reached Postgres as NaN and an id past
// int4 as an unbindable value. Bounded by MAX_SIGNED_INT4 because offers.id
// and properties.id are `serial` columns, i.e. int4. GET /public/:shareToken
// is deliberately not covered: a share token is an opaque string column, not
// an id, and getOfferByShareToken already answers 404 for anything unknown.
const MAX_SIGNED_INT4 = 2_147_483_647;

function parsePositiveId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= MAX_SIGNED_INT4 ? n : null;
}

/** Resolves a route id, answering 400 itself and returning null when malformed. */
function readIdParam(res: Response, value: unknown, label: "property" | "offer"): number | null {
  const id = parsePositiveId(value);
  if (id === null) {
    res.status(400).json({ error: `Invalid ${label} id` });
    return null;
  }
  return id;
}

/** What an unrecognised error is allowed to tell a client. */
const GENERIC_OFFER_ERROR = "An unexpected error occurred. Please try again or contact support if the problem persists.";

/** Driver/ORM text, as a second line of defence behind the prototype test below. */
const DRIVER_TEXT = /failed query|\bselect\b[\s\S]*\bfrom\b|\bparams:\s/i;

/**
 * True only for a plain `new Error("...")` — the shape lib/offers.ts and
 * lib/transactions.ts use for their operator-authored, caller-facing messages
 * ("Offer 3 cannot be withdrawn from status Accepted", "A buyerPartyId or
 * buyer contact details are required to record an offer."), which are
 * deliberately kept with this router's existing 400.
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
 */
function handleOfferError(err: unknown, res: Response): void {
  if (isOperatorAuthoredError(err)) {
    res.status(400).json({ error: err.message });
    return;
  }
  logger.error("offer_route_unhandled_error", {
    error: err instanceof Error ? err.message : String(err),
    errorName: err instanceof Error ? (err.constructor?.name ?? err.name) : typeof err,
  });
  res.status(500).json({ error: GENERIC_OFFER_ERROR });
}

// #123 — tenant scoping. None of these routes previously verified that the
// offer's (or property's) brokerage matched the caller's — a property id
// or offer id from any brokerage worked as long as the caller was
// authenticated at all.
// R-F8 — offer-route tenant check. The declared boundary set has no
// "offer" value (packages/events is unchanged), so this uses the closest
// declared value, "transaction". Same rule as routes/transactions.ts: a
// missing property does not increment; a property in another brokerage
// does, exactly once, and the response stays 404. The other brokerage's
// id is not logged or returned.
async function propertyInBrokerage(propertyId: number, brokerageId: number): Promise<boolean> {
  const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (!property) return false;
  if (property.brokerageId !== brokerageId) {
    incrementCounter("tenant_isolation_rejection_total", { boundary: "transaction" });
    return false;
  }
  return true;
}

const createOfferSchema = z.object({
  offerPriceCents: z.number().int().positive(),
  conditions: z.record(z.unknown()).optional(),
  buyerPartyId: z.number().optional(),
  buyer: z
    .object({
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      email: z.string().email().optional(),
      mobile: z.string().optional(),
    })
    .optional(),
});

offersRouter.post("/by-property/:propertyId", requireAuth, requiresRunAccess, async (req, res) => {
  const propertyId = readIdParam(res, req.params.propertyId, "property");
  if (propertyId === null) return;
  const parsed = createOfferSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;
  if (!(await propertyInBrokerage(propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  try {
    const offer = await createOffer({
      propertyId,
      offerPriceCents: parsed.data.offerPriceCents,
      conditions: parsed.data.conditions,
      buyerPartyId: parsed.data.buyerPartyId,
      buyer: parsed.data.buyer,
      userId: user.id,
      brokerageId: user.brokerageId,
    });
    // BE-Q1: the only response that still carries shareToken, returned once
    // to the user who recorded the offer (see toOfferView in lib/offers.ts).
    res.status(201).json({ offer });
  } catch (err) {
    handleOfferError(err, res);
  }
});

offersRouter.get("/by-property/:propertyId", requireAuth, requiresRunAccess, async (req, res) => {
  const propertyId = readIdParam(res, req.params.propertyId, "property");
  if (propertyId === null) return;
  const user = req.authedUser!;
  if (!(await propertyInBrokerage(propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const rows = await listOffersForProperty(propertyId);
  res.json({ offers: rows.map(toOfferView) });
});

offersRouter.get("/:id", requireAuth, requiresRunAccess, async (req, res) => {
  const id = readIdParam(res, req.params.id, "offer");
  if (id === null) return;
  const user = req.authedUser!;
  const [offer] = await db.select().from(offers).where(eq(offers.id, id));
  if (!offer || !(await propertyInBrokerage(offer.propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json({ offer: toOfferView(offer) });
});

// M3 revocable offer links (Owner t165u; migration 0037). The public link
// shows the offer price, so managing it follows the Owner's offer-price rule
// (t165u: "listing agent and authorised brokerage administrators only"):
// a Brokerage Administrator, or the Agent who is the property's listing agent
// (properties.agent_id). Other agents and Pit Crew get 403. Gate order: auth,
// run.access, role, tenant 404 (R-F8 metric once), then the listing-agent check.
const requiresShareLinkRole = requireRole("Agent", ...BROKERAGE_ADMIN_ROLES);

async function loadOwnOffer(req: Request, res: Response): Promise<{ id: number; propertyId: number } | null> {
  const id = readIdParam(res, req.params.id, "offer");
  if (id === null) return null;
  const user = req.authedUser!;
  const [offer] = await db.select({ id: offers.id, propertyId: offers.propertyId }).from(offers).where(eq(offers.id, id));
  if (!offer || !(await propertyInBrokerage(offer.propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  if (!BROKERAGE_ADMIN_ROLES.includes(user.role)) {
    const [property] = await db.select({ agentId: properties.agentId }).from(properties).where(eq(properties.id, offer.propertyId));
    if (property?.agentId !== user.id) {
      res.status(403).json({ error: "Only the listing agent or a brokerage administrator can manage this offer's link" });
      return null;
    }
  }
  return offer;
}

offersRouter.get("/:id/share-link", requireAuth, requiresRunAccess, requiresShareLinkRole, async (req, res) => {
  const offer = await loadOwnOffer(req, res);
  if (!offer) return;
  try {
    res.json({ shareLink: await getShareLinkStatus(offer.id) });
  } catch (err) {
    handleOfferError(err, res);
  }
});

offersRouter.post("/:id/share-link/revoke", requireAuth, requiresRunAccess, requiresShareLinkRole, async (req, res) => {
  const offer = await loadOwnOffer(req, res);
  if (!offer) return;
  const user = req.authedUser!;
  try {
    const result = await revokeOfferShareLinks({ offerId: offer.id, userId: user.id, brokerageId: user.brokerageId, propertyId: offer.propertyId });
    res.json({ ...result, shareLink: await getShareLinkStatus(offer.id) });
  } catch (err) {
    handleOfferError(err, res);
  }
});

const reissueSchema = z.object({ expiresInDays: z.number().int().min(1).max(SHARE_LINK_MAX_EXPIRY_DAYS).optional() }).strict();

offersRouter.post("/:id/share-link/reissue", requireAuth, requiresRunAccess, requiresShareLinkRole, async (req, res) => {
  const offer = await loadOwnOffer(req, res);
  if (!offer) return;
  const parsed = reissueSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: `expiresInDays must be a whole number from 1 to ${SHARE_LINK_MAX_EXPIRY_DAYS}` });
    return;
  }
  const user = req.authedUser!;
  try {
    const result = await reissueOfferShareLink({
      offerId: offer.id,
      userId: user.id,
      brokerageId: user.brokerageId,
      propertyId: offer.propertyId,
      expiresInDays: parsed.data.expiresInDays,
    });
    // The new token is returned once, to the caller, like POST create.
    res.status(201).json(result);
  } catch (err) {
    handleOfferError(err, res);
  }
});

// The chokepoint that converts a Property into an active Transaction —
// idempotent, and auto-declines every other still-open offer on the
// property (see lib/transactions.ts acceptOffer).
offersRouter.post("/:id/accept", requireAuth, requiresRunAccess, async (req, res) => {
  const id = readIdParam(res, req.params.id, "offer");
  if (id === null) return;
  const user = req.authedUser!;
  const [offer] = await db.select().from(offers).where(eq(offers.id, id));
  if (!offer || !(await propertyInBrokerage(offer.propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const result = await acceptOffer({ offerId: id, userId: user.id, brokerageId: user.brokerageId });
    res.status(result.created ? 201 : 200).json({ ...result, offer: toOfferView(result.offer) });
  } catch (err) {
    handleOfferError(err, res);
  }
});

offersRouter.post("/:id/decline", requireAuth, requiresRunAccess, async (req, res) => {
  const id = readIdParam(res, req.params.id, "offer");
  if (id === null) return;
  const user = req.authedUser!;
  const [offer] = await db.select().from(offers).where(eq(offers.id, id));
  if (!offer || !(await propertyInBrokerage(offer.propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const updated = await declineOffer(id, user.id);
    res.json({ offer: toOfferView(updated) });
  } catch (err) {
    handleOfferError(err, res);
  }
});

offersRouter.post("/:id/withdraw", requireAuth, requiresRunAccess, async (req, res) => {
  const id = readIdParam(res, req.params.id, "offer");
  if (id === null) return;
  const user = req.authedUser!;
  const [offer] = await db.select().from(offers).where(eq(offers.id, id));
  if (!offer || !(await propertyInBrokerage(offer.propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const updated = await withdrawOffer(id, user.id);
    res.json({ offer: toOfferView(updated) });
  } catch (err) {
    handleOfferError(err, res);
  }
});

// Public, unauthenticated — lets a buyer who submitted an offer through the
// agent check its status via the link the agent sends them (offers.shareToken
// schema comment: "public buyer-facing link, no sign-in required").
offersRouter.get("/public/:shareToken", async (req, res) => {
  const result = await getOfferByShareToken(req.params.shareToken);
  if (!result) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(result);
});
