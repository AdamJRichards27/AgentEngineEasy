
// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7), HTTP surface.
//
// Visible to Pit Crew and Brokerage Administrator only (Section 26) --
// Agents keep their existing workflows unchanged and do not get this
// surface, except GET /pit-crew/responsibility-inbox, which has its own
// role list (Agent, Pit Crew, Brokerage Administrator). canAccess is not
// widened. Every mutating route requires expectedVersion in the body
// (Section 12) and maps the resulting concurrency/transition errors to
// 409/422 so the frontend can tell "someone else moved this" apart from
// "that move isn't allowed from here."
//
// AE GROW Priority 0.5 -- Workstream 3: every route below now also requires
// requireEntitlement("run.access"), alongside the existing role gate, not instead of it. Pit
// Crew is part of the RUN product ($289/mo, "Deliver the Business") under the new GROW -> RUN
// -> SCALE product hierarchy -- see docs/AE_GROW_PRIORITY_0_5_FOUNDATION_REPORT.md's "Grow/Run
// Boundary" section. Every brokerage that already had Pit Crew access before this phase keeps it
// uninterrupted via the non-destructive run.access backfill (lib/billing/runAccessBackfill.ts)
// and the dev-login auto-grant (routes/auth.ts) -- this is additive entitlement enforcement, not
// a new business rule about who may use Pit Crew.

import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { logger } from "@aee/events";
import { requireAuth, requireRole, PIT_CREW_ROLES, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { getPitCrewWorkspace, getPitCrewTeam, listResponsibilityItemsForRecipient } from "../lib/pitCrew/queries.js";
import { listOverdueWaitingOnDetections } from "../lib/pitCrew/waitingOnDetectionRun.js";
import type { ResolvedPitCrewWaitingOnSweepSettings } from "../lib/pitCrew/waitingOnDetection.js";
import { loadPitCrewWaitingOnSweepSettings } from "../lib/pitCrew/waitingOnSweepSettings.js";
import {
  pitCrewWaitingOnSweepCallerFailedLastTick,
  pitCrewWaitingOnSweepOpsSnapshot,
  type PitCrewWaitingOnSweepOpsSnapshot,
} from "../lib/pitCrew/waitingOnSweepBootstrap.js";
import {
  PIT_CREW_ESCALATION_REASON_CATEGORIES,
  PIT_CREW_ESCALATION_SEVERITIES,
  PIT_CREW_HAND_BACK_REASON_CATEGORIES,
} from "@aee/db";
import {
  claimWorkItem,
  assignWorkItem,
  startProgress,
  setWaitingOn,
  returnFromWaitingOn,
  completeWorkItem,
  releaseWorkItem,
  handoffWorkItem,
  sweepOverdueWaitingOn,
  PitCrewTransitionError,
  PitCrewConcurrencyError,
  PitCrewPropertyMismatchError,
  PitCrewAssigneeMismatchError,
  notePitCrewPropertyIsolationRejection,
} from "../lib/pitCrew/assignment.js";
import {
  acknowledgeEscalation,
  escalateWorkItem,
  handBackWorkItem,
  isPitCrewResponsibilityActionsEnabled,
  reclaimHandedBack,
  resolveEscalation,
  returnEscalation,
  PitCrewResponsibilityDisabledError,
  PitCrewResponsibilityForbiddenError,
  PitCrewResponsibilityNotFoundError,
  PitCrewResponsibilityValidationError,
  type ResponsibilityMutationResult,
} from "../lib/pitCrew/responsibility.js";
import { addPropertyNote } from "../lib/propertyNotes.js";

export const pitCrewRouter = Router();

const canAccess = requireRole(...PIT_CREW_ROLES, ...BROKERAGE_ADMIN_ROLES);
// Inbox only. Do not reuse this on the workspace or mutation routes.
const canReadResponsibilityInbox = requireRole("Agent", ...PIT_CREW_ROLES, ...BROKERAGE_ADMIN_ROLES);
const requiresRunAccess = requireEntitlement("run.access");

function handlePitCrewError(err: unknown, res: Response): boolean {
  if (err instanceof PitCrewConcurrencyError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof PitCrewTransitionError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  if (err instanceof PitCrewPropertyMismatchError) {
    // Same tenant-isolation convention as the rest of the codebase (see
    // exceptions.ts, parties.ts): a cross-brokerage propertyId reads to the
    // caller as "not found," not as a permissions error, so it doesn't leak
    // whether the id belongs to someone else's brokerage.
    res.status(404).json({ error: err.message });
    return true;
  }
  if (err instanceof PitCrewAssigneeMismatchError) {
    // Same posture as PitCrewPropertyMismatchError above -- an
    // assigneeUserId belonging to another brokerage reads as "not found."
    res.status(404).json({ error: err.message });
    return true;
  }
  if (err instanceof PitCrewResponsibilityDisabledError || err instanceof PitCrewResponsibilityNotFoundError) {
    res.status(404).json({ error: err.message });
    return true;
  }
  if (err instanceof PitCrewResponsibilityForbiddenError) {
    res.status(403).json({ error: err.message });
    return true;
  }
  if (err instanceof PitCrewResponsibilityValidationError) {
    res.status(400).json({ error: "Invalid request." });
    return true;
  }
  return false;
}

// R-F16: hand-back and escalate stay invisible until the flag is the literal
// "true". This runs before zod and before any table read. The library throws
// the same error if a caller reaches it while the flag is off.
function rejectIfResponsibilityActionsDisabled(res: Response): boolean {
  if (isPitCrewResponsibilityActionsEnabled()) return false;
  res.status(404).json({ error: new PitCrewResponsibilityDisabledError().message });
  return true;
}

// First middleware on the inbox route, before auth, role, and entitlement,
// so a flag that is not the literal "true" returns 404 without the handler
// reading pit_crew_responsibility_events (that table is absent on the pilot
// database until 0032/0033 are applied).
function requireResponsibilityActionsEnabled(_req: Request, res: Response, next: NextFunction): void {
  if (rejectIfResponsibilityActionsDisabled(res)) return;
  next();
}

function sendResponsibilityMutation(res: Response, result: ResponsibilityMutationResult): void {
  res.json({ ...result.assignment, responsibilityEvent: result.responsibilityEvent });
}

// ---------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------

pitCrewRouter.get("/pit-crew/workspace", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const workspace = await getPitCrewWorkspace(user.brokerageId, user.id);
  res.json(workspace);
});

pitCrewRouter.get("/pit-crew/team", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const team = await getPitCrewTeam(user.brokerageId);
  res.json({ team });
});

// Recipient inbox. No query params. brokerageId, user id, and role come
// from the session. The caller cannot name another user.
pitCrewRouter.get(
  "/pit-crew/responsibility-inbox",
  requireResponsibilityActionsEnabled,
  requireAuth,
  canReadResponsibilityInbox,
  requiresRunAccess,
  async (req, res) => {
    const user = req.authedUser!;
    try {
      const inbox = await listResponsibilityItemsForRecipient(user.brokerageId, user.id, user.role);
      res.json(inbox);
    } catch (err) {
      if (!handlePitCrewError(err, res)) throw err;
    }
  },
);

// ---------------------------------------------------------------------
// Writes. Every body carries propertyId (the frontend already has the
// PcWorkItem loaded) and expectedVersion (Section 12).
// ---------------------------------------------------------------------

const baseMutationSchema = z.object({
  propertyId: z.coerce.number().int(),
  expectedVersion: z.coerce.number().int().min(0),
});

const itemParamsSchema = z.object({ sourceType: z.string().min(1), sourceRecordId: z.string().min(1) });

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/claim", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const params = itemParamsSchema.safeParse(req.params);
  const body = baseMutationSchema.safeParse(req.body);
  if (!params.success || !body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const row = await claimWorkItem({
      brokerageId: user.brokerageId,
      propertyId: body.data.propertyId,
      sourceType: params.data.sourceType,
      sourceRecordId: params.data.sourceRecordId,
      expectedVersion: body.data.expectedVersion,
      actorUserId: user.id,
    });
    res.json(row);
  } catch (err) {
    if (!handlePitCrewError(err, res)) throw err;
  }
});

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/assign", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const params = itemParamsSchema.safeParse(req.params);
  const body = baseMutationSchema.extend({ assigneeUserId: z.coerce.number().int() }).safeParse(req.body);
  if (!params.success || !body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const row = await assignWorkItem({
      brokerageId: user.brokerageId,
      propertyId: body.data.propertyId,
      sourceType: params.data.sourceType,
      sourceRecordId: params.data.sourceRecordId,
      expectedVersion: body.data.expectedVersion,
      assigneeUserId: body.data.assigneeUserId,
      actorUserId: user.id,
    });
    res.json(row);
  } catch (err) {
    if (!handlePitCrewError(err, res)) throw err;
  }
});

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/start", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const params = itemParamsSchema.safeParse(req.params);
  const body = baseMutationSchema.safeParse(req.body);
  if (!params.success || !body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const row = await startProgress({
      brokerageId: user.brokerageId,
      propertyId: body.data.propertyId,
      sourceType: params.data.sourceType,
      sourceRecordId: params.data.sourceRecordId,
      expectedVersion: body.data.expectedVersion,
      actorUserId: user.id,
    });
    res.json(row);
  } catch (err) {
    if (!handlePitCrewError(err, res)) throw err;
  }
});

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/waiting-on", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const params = itemParamsSchema.safeParse(req.params);
  const body = baseMutationSchema
    .extend({
      waitingOnParty: z.string().min(1),
      waitingOnNote: z.string().optional(),
      waitingOnExpectedAt: z.coerce.date().optional(),
    })
    .safeParse(req.body);
  if (!params.success || !body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const row = await setWaitingOn({
      brokerageId: user.brokerageId,
      propertyId: body.data.propertyId,
      sourceType: params.data.sourceType,
      sourceRecordId: params.data.sourceRecordId,
      expectedVersion: body.data.expectedVersion,
      waitingOnParty: body.data.waitingOnParty,
      waitingOnNote: body.data.waitingOnNote,
      waitingOnExpectedAt: body.data.waitingOnExpectedAt,
      actorUserId: user.id,
    });
    res.json(row);
  } catch (err) {
    if (!handlePitCrewError(err, res)) throw err;
  }
});


pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/return", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const params = itemParamsSchema.safeParse(req.params);
  const body = baseMutationSchema.safeParse(req.body);
  if (!params.success || !body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const row = await returnFromWaitingOn({
      brokerageId: user.brokerageId, propertyId: body.data.propertyId,
      sourceType: params.data.sourceType, sourceRecordId: params.data.sourceRecordId,
      expectedVersion: body.data.expectedVersion, actorUserId: user.id,
    });
    res.json(row);
  } catch (err) { if (!handlePitCrewError(err, res)) throw err; }
});

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/complete", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const params = itemParamsSchema.safeParse(req.params);
  const body = baseMutationSchema.safeParse(req.body);
  if (!params.success || !body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const row = await completeWorkItem({
      brokerageId: user.brokerageId, propertyId: body.data.propertyId,
      sourceType: params.data.sourceType, sourceRecordId: params.data.sourceRecordId,
      expectedVersion: body.data.expectedVersion, actorUserId: user.id,
    });
    res.json(row);
  } catch (err) { if (!handlePitCrewError(err, res)) throw err; }
});

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/release", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const params = itemParamsSchema.safeParse(req.params);
  const body = baseMutationSchema.safeParse(req.body);
  if (!params.success || !body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const row = await releaseWorkItem({
      brokerageId: user.brokerageId, propertyId: body.data.propertyId,
      sourceType: params.data.sourceType, sourceRecordId: params.data.sourceRecordId,
      expectedVersion: body.data.expectedVersion, actorUserId: user.id,
    });
    res.json(row);
  } catch (err) { if (!handlePitCrewError(err, res)) throw err; }
});

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/handoff", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const params = itemParamsSchema.safeParse(req.params);
  const body = baseMutationSchema.extend({
    toUserId: z.coerce.number().int(),
    note: z.string().optional(),
  }).safeParse(req.body);
  if (!params.success || !body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const row = await handoffWorkItem({
      brokerageId: user.brokerageId, propertyId: body.data.propertyId,
      sourceType: params.data.sourceType, sourceRecordId: params.data.sourceRecordId,
      expectedVersion: body.data.expectedVersion, actorUserId: user.id,
      toUserId: body.data.toUserId, note: body.data.note,
    });
    res.json(row);
  } catch (err) { if (!handlePitCrewError(err, res)) throw err; }
});

// R-F16: hand-back and escalate. Same canAccess gate as claim (Pit Crew and
// Brokerage Administrator) plus run.access. Agents stay on requireRole's 403.
// The client never sends a recipient role; escalate omits recipientUserId to
// address the Brokerage Administrator role. Audit rows are written inside
// the library transaction (brokerageId, strict). These handlers do not
// write a second audit row.
const handBackSchema = baseMutationSchema.extend({
  reasonCategory: z.enum(PIT_CREW_HAND_BACK_REASON_CATEGORIES),
  note: z.string().optional(),
  recipientUserId: z.coerce.number().int().optional(),
  nextAction: z.string().trim().min(1),
}).strict();

const escalateSchema = baseMutationSchema.extend({
  reasonCategory: z.enum(PIT_CREW_ESCALATION_REASON_CATEGORIES),
  severity: z.enum(PIT_CREW_ESCALATION_SEVERITIES),
  note: z.string().trim().min(1),
  nextAction: z.string().trim().min(1),
  recipientUserId: z.coerce.number().int().optional(),
  expectedResponseAt: z.coerce.date().optional(),
}).strict().superRefine((body, ctx) => {
  if ((body.severity === "AT_RISK" || body.severity === "CRITICAL") && body.expectedResponseAt == null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedResponseAt"],
      message: "expectedResponseAt is required when severity is AT_RISK or CRITICAL.",
    });
  }
});

const acknowledgeSchema = baseMutationSchema.extend({
  note: z.string().optional(),
}).strict();

const closeEscalationSchema = baseMutationSchema.extend({
  note: z.string().trim().min(1),
}).strict();

const reclaimSchema = baseMutationSchema.strict();

function responsibilityActor(user: { brokerageId: number; id: number }, propertyId: number, sourceType: string, sourceRecordId: string, expectedVersion: number) {
  return {
    brokerageId: user.brokerageId,
    propertyId,
    sourceType,
    sourceRecordId,
    expectedVersion,
    actorUserId: user.id,
  };
}

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/hand-back", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  if (rejectIfResponsibilityActionsDisabled(res)) return;
  const user = req.authedUser!;
  const params = itemParamsSchema.safeParse(req.params);
  const body = handBackSchema.safeParse(req.body);
  if (!params.success || !body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const result = await handBackWorkItem({
      ...responsibilityActor(user, body.data.propertyId, params.data.sourceType, params.data.sourceRecordId, body.data.expectedVersion),
      reasonCategory: body.data.reasonCategory,
      note: body.data.note,
      recipientUserId: body.data.recipientUserId,
      nextAction: body.data.nextAction,
    });
    sendResponsibilityMutation(res, result);
  } catch (err) {
    if (!handlePitCrewError(err, res)) throw err;
  }
});

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/escalate", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  if (rejectIfResponsibilityActionsDisabled(res)) return;
  const user = req.authedUser!;
  const params = itemParamsSchema.safeParse(req.params);
  const body = escalateSchema.safeParse(req.body);
  if (!params.success || !body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const result = await escalateWorkItem({
      ...responsibilityActor(user, body.data.propertyId, params.data.sourceType, params.data.sourceRecordId, body.data.expectedVersion),
      reasonCategory: body.data.reasonCategory,
      severity: body.data.severity,
      note: body.data.note,
      nextAction: body.data.nextAction,
      recipientUserId: body.data.recipientUserId,
      expectedResponseAt: body.data.expectedResponseAt,
    });
    sendResponsibilityMutation(res, result);
  } catch (err) {
    if (!handlePitCrewError(err, res)) throw err;
  }
});

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/escalation/acknowledge", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  if (rejectIfResponsibilityActionsDisabled(res)) return;
  const user = req.authedUser!;
  const params = itemParamsSchema.safeParse(req.params);
  const body = acknowledgeSchema.safeParse(req.body);
  if (!params.success || !body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const result = await acknowledgeEscalation({
      ...responsibilityActor(user, body.data.propertyId, params.data.sourceType, params.data.sourceRecordId, body.data.expectedVersion),
      note: body.data.note,
    });
    sendResponsibilityMutation(res, result);
  } catch (err) {
    if (!handlePitCrewError(err, res)) throw err;
  }
});

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/escalation/resolve", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  if (rejectIfResponsibilityActionsDisabled(res)) return;
  const user = req.authedUser!;
  const params = itemParamsSchema.safeParse(req.params);
  const body = closeEscalationSchema.safeParse(req.body);
  if (!params.success || !body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const result = await resolveEscalation({
      ...responsibilityActor(user, body.data.propertyId, params.data.sourceType, params.data.sourceRecordId, body.data.expectedVersion),
      note: body.data.note,
    });
    sendResponsibilityMutation(res, result);
  } catch (err) {
    if (!handlePitCrewError(err, res)) throw err;
  }
});

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/escalation/return", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  if (rejectIfResponsibilityActionsDisabled(res)) return;
  const user = req.authedUser!;
  const params = itemParamsSchema.safeParse(req.params);
  const body = closeEscalationSchema.safeParse(req.body);
  if (!params.success || !body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const result = await returnEscalation({
      ...responsibilityActor(user, body.data.propertyId, params.data.sourceType, params.data.sourceRecordId, body.data.expectedVersion),
      note: body.data.note,
    });
    sendResponsibilityMutation(res, result);
  } catch (err) {
    if (!handlePitCrewError(err, res)) throw err;
  }
});

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/hand-back/reclaim", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  if (rejectIfResponsibilityActionsDisabled(res)) return;
  const user = req.authedUser!;
  const params = itemParamsSchema.safeParse(req.params);
  const body = reclaimSchema.safeParse(req.body);
  if (!params.success || !body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const result = await reclaimHandedBack(
      responsibilityActor(user, body.data.propertyId, params.data.sourceType, params.data.sourceRecordId, body.data.expectedVersion),
    );
    sendResponsibilityMutation(res, result);
  } catch (err) {
    if (!handlePitCrewError(err, res)) throw err;
  }
});

// Section 23: Internal Notes -- reuse addPropertyNote (already privacy-scoped
// and audit-logged via lib/audit.ts) rather than a second notes mechanism.
// That function requires userEmail, which AuthedUser does not carry, so it is
// looked up once here. Imports below are additional to the top-of-file block;
// ES modules hoist import declarations regardless of source position.
import { db, users } from "@aee/db";
import { eq } from "drizzle-orm";

const noteSchema = z.object({
  propertyId: z.coerce.number().int(),
  note: z.string().min(1),
});

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/note", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const body = noteSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  const [dbUser] = await db.select({ email: users.email }).from(users).where(eq(users.id, user.id));
  try {
    const result = await addPropertyNote({
      propertyId: body.data.propertyId,
      brokerageId: user.brokerageId,
      userId: user.id,
      userEmail: dbUser?.email ?? "",
      note: body.data.note,
      actorType: "PIT_CREW",
    });
    res.json(result);
  } catch (err) {
    // R-F10 — addPropertyNote already rejects a missing property and a
    // property in another brokerage with the same error. Count only the
    // latter, then rethrow so the response stays whatever it is today.
    if (err instanceof Error && err.message === "Property not found in this brokerage.") {
      await notePitCrewPropertyIsolationRejection(body.data.propertyId, user.brokerageId);
    }
    throw err;
  }
});

// R-F5: read-only detection queue for the caller's brokerage. Same gates as
// every other Pit Crew route. Does not write sightings, settings, or
// assignment state, and does not contact anyone. The operating window gates
// the scheduler, not this read: a human can still see the current queue.
pitCrewRouter.get("/pit-crew/ops/waiting-on/detections", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const settings = await loadPitCrewWaitingOnSweepSettings(user.brokerageId);
  const result = await listOverdueWaitingOnDetections({ brokerageId: user.brokerageId, settings });
  res.json(result);
});

// R-F3: the human-triggered caller for sweepOverdueWaitingOn. Same gates as
// every other Pit Crew route. brokerageId, the clock, and the audit actor
// all come from the session -- the body is not read, so a client cannot name
// another brokerage, pin "now", or impersonate the ops identity. Each
// returned row is audited as the caller (user id + email). This route still
// returns overdue rows to IN_PROGRESS. The scheduled sweep does not call it.
// GET /pit-crew/workspace does not sweep.
pitCrewRouter.post("/pit-crew/ops/waiting-on/sweep", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  try {
    const [dbUser] = await db.select({ email: users.email }).from(users).where(eq(users.id, user.id));
    const result = await sweepOverdueWaitingOn({
      brokerageId: user.brokerageId,
      actor: { actorUserId: user.id, actorEmail: dbUser?.email },
    });
    logger.info("pit_crew_waiting_on_sweep_completed", {
      brokerageId: user.brokerageId,
      actorUserId: user.id,
      scanned: result.scanned,
      returned: result.returned,
      skipped: result.skipped,
    });
    res.json(result);
  } catch (err) {
    if (!handlePitCrewError(err, res)) throw err;
  }
});

// R-F7: read-only ops health for the scheduled WAITING_ON detection sweep.
// Same role gate, run.access check, and caller-brokerage resolution as
// POST /pit-crew/ops/waiting-on/sweep. The brokerage id comes only from the
// session. This handler does not write, sweep, audit, or alert.
//
// Health is derived from the in-process streaks versus alertThreshold:
// - "not_running" when the sweep is disabled (PIT_CREW_WAITING_ON_SWEEP_ENABLED
//   is not the literal "true") or this process has never recorded a tick.
// - "unhealthy" when consecutiveUnhealthyTicks or
//   consecutiveBrokerageFailureTicks has reached alertThreshold (3).
// - "degraded" when either streak is above zero and still below that
//   threshold (1 or 2). A whole-tick failure and a partial brokerage
//   failure both count.
// - "ok" when the sweep is enabled, a tick has been recorded, and both
//   streaks are zero.
// The streaks and lastTick are job-level. They are not per-brokerage counts.
// failedLastTick is the only tenant-specific failure bit, and it is a
// boolean for the authenticated caller's brokerage. A missing migration
// 0031 (or any settings read error) stays 200 with settingsAvailable false.

type WaitingOnSweepHealthStatus = "ok" | "degraded" | "unhealthy" | "not_running";

function waitingOnSweepHealthStatus(snapshot: PitCrewWaitingOnSweepOpsSnapshot): WaitingOnSweepHealthStatus {
  if (!snapshot.enabled || snapshot.lastTick === null) return "not_running";
  const threshold = snapshot.alertThreshold;
  if (
    snapshot.consecutiveUnhealthyTicks >= threshold ||
    snapshot.consecutiveBrokerageFailureTicks >= threshold
  ) {
    return "unhealthy";
  }
  if (snapshot.consecutiveUnhealthyTicks > 0 || snapshot.consecutiveBrokerageFailureTicks > 0) {
    return "degraded";
  }
  return "ok";
}

type WaitingOnHealthSettingsLoader = (brokerageId: number) => Promise<ResolvedPitCrewWaitingOnSweepSettings>;

let waitingOnHealthSettingsLoader: WaitingOnHealthSettingsLoader = loadPitCrewWaitingOnSweepSettings;

/** Test-only. Pass null to restore the real settings reader. */
export function __setPitCrewWaitingOnHealthSettingsLoaderForTests(
  loader: WaitingOnHealthSettingsLoader | null,
): void {
  waitingOnHealthSettingsLoader = loader ?? loadPitCrewWaitingOnSweepSettings;
}

function brokerageSettingsFields(settings: ResolvedPitCrewWaitingOnSweepSettings) {
  return {
    settingsAvailable: true as const,
    cadenceMs: settings.cadenceMs,
    windowStart: settings.windowStart,
    windowEnd: settings.windowEnd,
    weekdays: [...settings.weekdays].sort((left, right) => left - right),
    timeZone: settings.timeZone,
    timeZoneSource: settings.timeZoneSource,
    attentionThresholdHours: settings.attentionThresholdHours,
    elevatedThresholdHours: settings.elevatedThresholdHours,
    lastDetectionAt: settings.lastDetectionAt,
  };
}

function brokerageSettingsUnavailable() {
  return {
    settingsAvailable: false as const,
    cadenceMs: null,
    windowStart: null,
    windowEnd: null,
    weekdays: null,
    timeZone: null,
    timeZoneSource: null,
    attentionThresholdHours: null,
    elevatedThresholdHours: null,
    lastDetectionAt: null,
  };
}

pitCrewRouter.get("/pit-crew/ops/waiting-on/health", requireAuth, canAccess, requiresRunAccess, async (req, res) => {
  const user = req.authedUser!;
  const snapshot = pitCrewWaitingOnSweepOpsSnapshot();
  let settingsFields: ReturnType<typeof brokerageSettingsFields> | ReturnType<typeof brokerageSettingsUnavailable>;
  try {
    settingsFields = brokerageSettingsFields(await waitingOnHealthSettingsLoader(user.brokerageId));
  } catch (err) {
    logger.warn("pit_crew_waiting_on_sweep_health_settings_unavailable", {
      brokerageId: user.brokerageId,
      error: err instanceof Error ? err.message : String(err),
    });
    settingsFields = brokerageSettingsUnavailable();
  }
  res.json({
    scheduler: {
      enabled: snapshot.enabled,
      started: snapshot.started,
      intervalMs: snapshot.intervalMs,
      lastTick: snapshot.lastTick,
      health: waitingOnSweepHealthStatus(snapshot),
      consecutiveUnhealthyTicks: snapshot.consecutiveUnhealthyTicks,
      consecutiveBrokerageFailureTicks: snapshot.consecutiveBrokerageFailureTicks,
      alertThreshold: snapshot.alertThreshold,
    },
    brokerage: {
      ...settingsFields,
      failedLastTick: pitCrewWaitingOnSweepCallerFailedLastTick(user.brokerageId),
    },
  });
});
