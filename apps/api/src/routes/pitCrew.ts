
// Agent Engine 2.0 -- Pit Crew Command Centre (Priority 7), HTTP surface.
//
// Visible to Pit Crew and Brokerage Administrator only (Section 26) --
// Agents keep their existing workflows unchanged and do not get this
// surface. Every mutating route requires expectedVersion in the body
// (Section 12) and maps the resulting concurrency/transition errors to
// 409/422 so the frontend can tell "someone else moved this" apart from
// "that move isn't allowed from here."

import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole, PIT_CREW_ROLES, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { getPitCrewWorkspace, getPitCrewTeam } from "../lib/pitCrew/queries.js";
import {
  claimWorkItem,
  assignWorkItem,
  startProgress,
  setWaitingOn,
  returnFromWaitingOn,
  completeWorkItem,
  releaseWorkItem,
  handoffWorkItem,
  PitCrewTransitionError,
  PitCrewConcurrencyError,
  PitCrewPropertyMismatchError,
} from "../lib/pitCrew/assignment.js";
import { addPropertyNote } from "../lib/propertyNotes.js";

export const pitCrewRouter = Router();

const canAccess = requireRole(...PIT_CREW_ROLES, ...BROKERAGE_ADMIN_ROLES);

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
  return false;
}

// ---------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------

pitCrewRouter.get("/pit-crew/workspace", requireAuth, canAccess, async (req, res) => {
  const user = req.authedUser!;
  const workspace = await getPitCrewWorkspace(user.brokerageId, user.id);
  res.json(workspace);
});

pitCrewRouter.get("/pit-crew/team", requireAuth, canAccess, async (req, res) => {
  const user = req.authedUser!;
  const team = await getPitCrewTeam(user.brokerageId);
  res.json({ team });
});

// ---------------------------------------------------------------------
// Writes. Every body carries propertyId (the frontend already has the
// PcWorkItem loaded) and expectedVersion (Section 12).
// ---------------------------------------------------------------------

const baseMutationSchema = z.object({
  propertyId: z.coerce.number().int(),
  expectedVersion: z.coerce.number().int().min(0),
});

const itemParamsSchema = z.object({ sourceType: z.string().min(1), sourceRecordId: z.string().min(1) });

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/claim", requireAuth, canAccess, async (req, res) => {
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

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/assign", requireAuth, canAccess, async (req, res) => {
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

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/start", requireAuth, canAccess, async (req, res) => {
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

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/waiting-on", requireAuth, canAccess, async (req, res) => {
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


pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/return", requireAuth, canAccess, async (req, res) => {
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

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/complete", requireAuth, canAccess, async (req, res) => {
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

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/release", requireAuth, canAccess, async (req, res) => {
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

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/handoff", requireAuth, canAccess, async (req, res) => {
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

pitCrewRouter.post("/pit-crew/items/:sourceType/:sourceRecordId/note", requireAuth, canAccess, async (req, res) => {
  const user = req.authedUser!;
  const body = noteSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  const [dbUser] = await db.select({ email: users.email }).from(users).where(eq(users.id, user.id));
  const result = await addPropertyNote({
    propertyId: body.data.propertyId,
    brokerageId: user.brokerageId,
    userId: user.id,
    userEmail: dbUser?.email ?? "",
    note: body.data.note,
    actorType: "PIT_CREW",
  });
  res.json(result);
});
