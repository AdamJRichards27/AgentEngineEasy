import { Router, type Response } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, properties } from "@aee/db";
import { logger } from "@aee/events";
import { requireAuth } from "../middlewares/auth.js";
import { getAppraisalByProperty, getOrCreateAppraisal, updateAppraisal, finaliseAppraisal } from "../lib/appraisals.js";
import { AppraisalLifecycleClosedError, AppraisalPricingLockedError } from "../lib/appraisalFinaliseGuard.js";
import { noteGrowPropertyIsolationRejection } from "../lib/grow/isolationRejection.js";
import { assertPropertyVisibleForWrite, propertyHiddenFromCaller } from "../lib/propertyVisibility.js";

export const appraisalsRouter = Router();

// AE GROW Pilot Readiness WP9 — route-id validation, the same bounded guard
// routes/grow.ts, routes/communications.ts, routes/growAppraisals.ts and
// routes/propertyIntelligence.ts already use (each keeps its own local copy;
// this is deliberately not a shared module). Every route below took a raw
// `Number(req.params.propertyId)` into assertPropertyInBrokerage's
// `where(eq(properties.id, ...))` bind, so "abc" reached Postgres as NaN and
// an id past int4 as an unbindable value — a 500 (or, once caught, a body
// carrying the driver's own query text) for an ordinary mistyped URL.
// Bounded by MAX_SIGNED_INT4 because properties.id is a `serial`, i.e. int4.
const MAX_SIGNED_INT4 = 2_147_483_647;

function parsePositiveId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= MAX_SIGNED_INT4 ? n : null;
}

/** Resolves a route id, answering 400 itself and returning null when malformed. */
function readPropertyIdParam(res: Response, value: unknown): number | null {
  const id = parsePositiveId(value);
  if (id === null) {
    res.status(400).json({ error: "Invalid property id" });
    return null;
  }
  return id;
}

/** What an unrecognised error is allowed to tell a client. */
const GENERIC_APPRAISAL_ERROR = "An unexpected error occurred. Please try again or contact support if the problem persists.";

/** Driver/ORM text, as a second line of defence behind the prototype test below. */
const DRIVER_TEXT = /failed query|\bselect\b[\s\S]*\bfrom\b|\bparams:\s/i;

/**
 * True only for a plain `new Error("...")` — the shape lib/appraisals.ts
 * uses for its operator-authored, caller-facing messages ("Property 12 not
 * found", "A price range is required before an appraisal can be
 * finalised."), which are deliberately kept with this router's existing 400.
 *
 * A finalised pricing write and a write against a closed lifecycle are
 * not in that 400 set. enforceAppraisalPricingRule throws
 * AppraisalPricingLockedError / AppraisalLifecycleClosedError, and this
 * handler answers those with 409 and a stable code.
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
function handleAppraisalError(err: unknown, res: Response): void {
  if (err instanceof AppraisalPricingLockedError || err instanceof AppraisalLifecycleClosedError) {
    res.status(409).json({ error: err.message, code: err.code });
    return;
  }
  if (isOperatorAuthoredError(err)) {
    res.status(400).json({ error: err.message });
    return;
  }
  logger.error("appraisal_route_unhandled_error", {
    error: err instanceof Error ? err.message : String(err),
    errorName: err instanceof Error ? (err.constructor?.name ?? err.name) : typeof err,
  });
  res.status(500).json({ error: GENERIC_APPRAISAL_ERROR });
}

async function assertPropertyInBrokerage(propertyId: number, brokerageId: number): Promise<boolean> {
  const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (!property || property.brokerageId !== brokerageId) {
    await noteGrowPropertyIsolationRejection(propertyId, brokerageId);
    return false;
  }
  return true;
}

appraisalsRouter.get("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = readPropertyIdParam(res, req.params.propertyId);
  if (propertyId === null) return;
  const user = req.authedUser!;
  if (!(await assertPropertyInBrokerage(propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Same 404 as a property outside this brokerage. The isolation counter
  // already ran inside assertPropertyInBrokerage only for another brokerage.
  if (await propertyHiddenFromCaller(user, propertyId)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const appraisal = await getAppraisalByProperty(propertyId, user.brokerageId);
  res.json({ appraisal });
});

// Idempotent start — reuses an existing in-progress appraisal for this
// property instead of creating a second one (getOrCreateAppraisal).
appraisalsRouter.post("/by-property/:propertyId/start", requireAuth, async (req, res) => {
  const propertyId = readPropertyIdParam(res, req.params.propertyId);
  if (propertyId === null) return;
  const user = req.authedUser!;
  if (!(await assertPropertyInBrokerage(propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!(await assertPropertyVisibleForWrite(user, propertyId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const result = await getOrCreateAppraisal({ propertyId, userId: user.id, brokerageId: user.brokerageId });
    res.status(result.created ? 201 : 200).json({ appraisal: result.appraisal });
  } catch (err) {
    handleAppraisalError(err, res);
  }
});

const updateAppraisalSchema = z.object({
  priceRangeLow: z.string().optional(),
  priceRangeHigh: z.string().optional(),
  comparableSales: z.unknown().optional(),
});

appraisalsRouter.post("/by-property/:propertyId", requireAuth, async (req, res) => {
  const propertyId = readPropertyIdParam(res, req.params.propertyId);
  if (propertyId === null) return;
  const parsed = updateAppraisalSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  const user = req.authedUser!;
  if (!(await assertPropertyInBrokerage(propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!(await assertPropertyVisibleForWrite(user, propertyId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const appraisal = await updateAppraisal({
      propertyId,
      userId: user.id,
      brokerageId: user.brokerageId,
      priceRangeLow: parsed.data.priceRangeLow,
      priceRangeHigh: parsed.data.priceRangeHigh,
      comparableSales: parsed.data.comparableSales,
    });
    res.json({ appraisal });
  } catch (err) {
    handleAppraisalError(err, res);
  }
});

appraisalsRouter.post("/by-property/:propertyId/finalise", requireAuth, async (req, res) => {
  const propertyId = readPropertyIdParam(res, req.params.propertyId);
  if (propertyId === null) return;
  const user = req.authedUser!;
  if (!(await assertPropertyInBrokerage(propertyId, user.brokerageId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (!(await assertPropertyVisibleForWrite(user, propertyId))) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  try {
    const appraisal = await finaliseAppraisal({ propertyId, userId: user.id, brokerageId: user.brokerageId });
    res.json({ appraisal });
  } catch (err) {
    handleAppraisalError(err, res);
  }
});
