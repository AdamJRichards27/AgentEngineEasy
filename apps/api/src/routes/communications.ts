// Agent Engine 2.0 — Communications Hub (Priority 8), HTTP surface.
//
// Visible to every authenticated brokerage user (Agent, Pit Crew, Brokerage
// Administrator) — Section 31 draws the finer-grained line at the resource
// level (a property's own agent, the Pit Crew member it's assigned to, or
// an admin), which the lib layer's own tenant checks already enforce; this
// router does not additionally gate by role except where Section 15/16
// requires a specific authority (settings changes are
// Brokerage-Administrator-only). Every mutating route that changes an
// existing communicationMessages row carries expectedVersion (the same
// optimistic-concurrency contract as Pit Crew's routes).
//
// AE GROW PRIORITY 3 — contact-first routes. The block near the bottom of
// this file (search "contact-first") adds the only new HTTP surface this
// priority needed: thread creation and recipient-candidate resolution for
// a party with no property, mounted under Grow's own /grow/contacts/:partyId
// namespace (matching routes/contacts.ts) so it carries its own explicit
// grow.contacts.* entitlement check — unlike every property-scoped route
// above, which is reachable by any authenticated brokerage user regardless
// of Grow entitlement. Every other action on a contact-first thread
// (drafting/sending/approving a message, adding a participant, etc.) reuses
// the exact same generic /communications/threads/:threadId/... routes
// above unchanged — those never assumed a propertyId, only a threadId
// resolvable within the caller's own brokerage.

import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { logger } from "@aee/events";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { explainEntitlementDecision } from "../lib/entitlements/resolver.js";
import {
  createThread,
  getThread,
  listThreadsForProperty,
  listThreadsForParty,
  listRecentMessagesForBrokerage,
  listParticipants,
  listMessagesForThread,
  getMessage,
  createDraftMessage,
  requestApproval,
  approveMessage,
  cancelMessage,
  sendMessageNow,
  requeueMessage,
} from "../lib/communications/messages.js";
import {
  listRecipientCandidatesForProperty,
  getContactRecipientCandidate,
  addParticipantFromParty,
  addManualParticipant,
} from "../lib/communications/recipientResolution.js";
import {
  createTemplate,
  createTemplateVersion,
  activateTemplate,
  archiveTemplate,
  listTemplatesForBrokerage,
  CommunicationTemplateError,
} from "../lib/communications/templates.js";
import { checkConsent, recordConsent, CommunicationConsentPartyError } from "../lib/communications/consent.js";
import { getCostSummary } from "../lib/communications/costControl.js";
import { getOrCreateCommunicationSettings, updateCommunicationSettings } from "../lib/communications/settings.js";
import {
  CommunicationTenancyError,
  CommunicationConcurrencyError,
  CommunicationTransitionError,
  CommunicationAnchorError,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_CLASSIFICATIONS,
} from "../lib/communications/types.js";

export const communicationsRouter = Router();

// AE GROW Pilot Readiness WP6a (D1-residual): every :id route parameter is
// validated BEFORE it reaches the database or the lib layer. A malformed id
// is a malformed request (400), not a server fault (500) — and until this
// guard existed it was the latter: `Number("abc")` is NaN and
// `Number("1e20")` is an integer far outside Postgres' int4 range, and both
// reach the driver as a bind value it rejects, surfacing as a 500 with a
// database diagnostic in the logs for what is simply a mistyped URL.
//
// Same shape (and same `{ error }` response shape) as routes/contacts.ts's
// parsePositiveId and routes/growCalls.ts's parseIdParam, additionally
// bounded by MAX_SIGNED_INT4 because every id this router resolves is a
// `serial` primary key (packages/db/src/schema/communications.ts), i.e. an
// int4. There is no shared cross-router helper in this codebase today — each
// route module declares its own, which is the convention this follows.
const MAX_SIGNED_INT4 = 2_147_483_647;

function parsePositiveId(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 && n <= MAX_SIGNED_INT4 ? n : null;
}

function handleCommunicationsError(err: unknown, res: Response): boolean {
  if (err instanceof CommunicationConcurrencyError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  if (err instanceof CommunicationAnchorError) {
    res.status(400).json({ error: err.message });
    return true;
  }
  if (err instanceof CommunicationTransitionError || err instanceof CommunicationTemplateError) {
    res.status(422).json({ error: err.message });
    return true;
  }
  if (err instanceof CommunicationTenancyError) {
    // Same tenant-isolation convention as the rest of the codebase: a
    // cross-brokerage id reads to the caller as "not found," never as a
    // permissions error, so it doesn't leak whether the id belongs to
    // someone else's brokerage.
    res.status(404).json({ error: err.message });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// AE GROW Pilot Readiness WP1 (P2-3): Grow entitlement on contact-first
// thread mutations. The generic /communications/threads/:threadId/... and
// /communications/messages/:messageId/... mutation routes below are shared
// by property-scoped (RUN) threads and contact-first (Grow) threads. A
// contact-first thread (propertyId IS NULL -- the CHECK constraint then
// guarantees a partyId) can only be CREATED with grow.contacts.manage, so
// every subsequent mutation on it (participants, drafting, request-approval,
// approval, send, requeue) must require that same key too -- otherwise a
// brokerage/user without Grow could keep driving a Grow thread by id.
// Property-scoped threads are unchanged (no Grow check at all). Cancel is
// deliberately NOT gated: it can only withdraw an unsent message, never
// send one, and must stay available to stop an outbound message after an
// entitlement lapses.
//
// Returns true when the request may proceed; otherwise it has already
// written the response (404 for an unknown/foreign thread via
// handleCommunicationsError, 403 in the requireEntitlement() shape).
// ---------------------------------------------------------------------

async function ensureGrowEntitlementForThread(
  req: Request,
  res: Response,
  resolveThreadId: () => Promise<number>,
): Promise<boolean> {
  const user = req.authedUser!;
  try {
    const threadId = await resolveThreadId();
    if (!Number.isInteger(threadId) || threadId <= 0) throw new CommunicationTenancyError();
    const thread = await getThread(threadId, user.brokerageId);
    if (thread.propertyId !== null) return true;
    const decision = await explainEntitlementDecision(user, "grow.contacts.manage");
    if (decision.allowed) return true;
    res.status(403).json({
      error: "Not entitled",
      reason: decision.reason,
      entitlementKey: "grow.contacts.manage",
      upgrade: { action: "grow.checkout", productCode: "grow" },
    });
    return false;
  } catch (err) {
    if (handleCommunicationsError(err, res)) return false;
    logger.error("communications_grow_thread_entitlement_failed_closed", { userId: user.id, error: err });
    res.status(403).json({ error: "Not entitled", reason: "ENTITLEMENT_MISSING", entitlementKey: "grow.contacts.manage" });
    return false;
  }
}

// AE GROW Pilot Readiness WP6a (D1-residual): these gates run BEFORE the
// route handler, so a malformed id has to be rejected here too — otherwise
// the handler's own 400 is unreachable and the caller sees whatever this
// gate decided instead (previously a misleading 404, via the
// CommunicationTenancyError below, or a 500 once the id reached getMessage).
function requireGrowForContactThreadByThreadId() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const threadId = parsePositiveId(req.params.threadId);
    if (threadId === null) return void res.status(400).json({ error: "Invalid thread id." });
    if (await ensureGrowEntitlementForThread(req, res, async () => threadId)) next();
  };
}

function requireGrowForContactThreadByMessageId() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.authedUser!;
    const messageId = parsePositiveId(req.params.messageId);
    if (messageId === null) return void res.status(400).json({ error: "Invalid message id." });
    if (
      await ensureGrowEntitlementForThread(req, res, async () => {
        const message = await getMessage(messageId, user.brokerageId);
        return message.threadId;
      })
    ) {
      next();
    }
  };
}

// ---------------------------------------------------------------------
// Hub (Section 32) — brokerage-wide, not property-scoped. The Hub route's
// one job is "what's recent, and what needs my attention" without making
// the caller open every property individually.
// ---------------------------------------------------------------------

communicationsRouter.get("/communications/hub", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const filter = req.query.filter === "needs-attention" ? "needs-attention" : "all";
  const limitParam = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
  const limit = Number.isFinite(limitParam) && limitParam! > 0 ? limitParam : undefined;

  const [messages, needsAttention] = await Promise.all([
    listRecentMessagesForBrokerage(user.brokerageId, { limit, needsAttentionOnly: filter === "needs-attention" }),
    // Always read separately from the displayed feed, capped at 200 like
    // every other Hub read — so the badge reflects the true needs-attention
    // count ("200+" on a very backlogged brokerage, never a true unbounded
    // count) regardless of which feed the caller is viewing or what `limit`
    // they passed for it.
    listRecentMessagesForBrokerage(user.brokerageId, { needsAttentionOnly: true, limit: 200 }),
  ]);

  res.json({ messages, needsAttentionCount: needsAttention.length });
});

// ---------------------------------------------------------------------
// Threads (Section 10) — property-scoped.
// ---------------------------------------------------------------------

const createThreadSchema = z.object({
  transactionId: z.coerce.number().int().optional(),
  subject: z.string().min(1),
});

communicationsRouter.get("/properties/:propertyId/communications/threads", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const propertyId = parsePositiveId(req.params.propertyId);
  if (propertyId === null) return void res.status(400).json({ error: "Invalid property id." });
  try {
    const threads = await listThreadsForProperty(propertyId, user.brokerageId);
    res.json({ threads });
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

communicationsRouter.post("/properties/:propertyId/communications/threads", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const propertyId = parsePositiveId(req.params.propertyId);
  if (propertyId === null) return void res.status(400).json({ error: "Invalid property id." });
  const body = createThreadSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const thread = await createThread({
      brokerageId: user.brokerageId,
      propertyId,
      transactionId: body.data.transactionId ?? null,
      subject: body.data.subject,
      createdByUserId: user.id,
    });
    res.status(201).json(thread);
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

// Section 11: recipient candidates resolved from the property's existing parties.
communicationsRouter.get("/properties/:propertyId/communications/recipients", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const propertyId = parsePositiveId(req.params.propertyId);
  if (propertyId === null) return void res.status(400).json({ error: "Invalid property id." });
  try {
    const candidates = await listRecipientCandidatesForProperty(propertyId, user.brokerageId);
    res.json({ candidates });
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

communicationsRouter.get("/communications/threads/:threadId", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const threadId = parsePositiveId(req.params.threadId);
  if (threadId === null) return void res.status(400).json({ error: "Invalid thread id." });
  try {
    const thread = await getThread(threadId, user.brokerageId);
    const [participants, messages] = await Promise.all([
      listParticipants(threadId, user.brokerageId),
      listMessagesForThread(threadId, user.brokerageId),
    ]);
    res.json({ thread, participants, messages });
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

// ---------------------------------------------------------------------
// AE GROW PRIORITY 3 — contact-first threads. Mounted under Grow's own
// /grow/contacts/:partyId namespace (matching routes/contacts.ts's own
// mount) precisely so it can carry its own explicit grow.contacts.*
// entitlement check, rather than inheriting the property-scoped routes'
// "any authenticated brokerage user" reach. Reuses createThread/
// listThreadsForParty/getContactRecipientCandidate — the exact same
// service functions and DB tables the property-scoped routes above use —
// never a second thread/message model.
//
// Everything past thread creation (drafting a message, adding a
// participant, approving, sending, requeuing) reuses the generic
// /communications/threads/:threadId/... and /communications/messages/
// :messageId/... routes already declared above/below in this file
// unchanged: none of them ever assumed a propertyId, only a threadId/
// messageId resolvable within the caller's own brokerage. The intended
// call sequence for a Contact 360 Email/SMS send is:
//   1. POST /grow/contacts/:partyId/communications/threads  -> { id, ... }
//   2. GET  /grow/contacts/:partyId/communications/recipients -> { candidates: [<the contact>] }
//   3. POST /communications/threads/:threadId/participants  (partyId + a role) -> { id: participantId, ... }
//   4. POST /communications/threads/:threadId/messages       (recipientParticipantId, channel, classification, bodyText, ...) -> DRAFT message
//   5. POST /communications/messages/:messageId/send          (expectedVersion) -> { message, blocked, dispatched }
// ---------------------------------------------------------------------

const createContactThreadSchema = z.object({
  transactionId: z.coerce.number().int().optional(),
  subject: z.string().min(1),
});

communicationsRouter.get(
  "/grow/contacts/:partyId/communications/threads",
  requireAuth,
  requireEntitlement("grow.contacts.read"),
  async (req, res) => {
    const user = req.authedUser!;
    const partyId = parsePositiveId(req.params.partyId);
    if (partyId === null) return void res.status(400).json({ error: "Invalid contact id." });
    try {
      const threads = await listThreadsForParty(partyId, user.brokerageId);
      res.json({ threads });
    } catch (err) {
      if (!handleCommunicationsError(err, res)) throw err;
    }
  },
);

communicationsRouter.post(
  "/grow/contacts/:partyId/communications/threads",
  requireAuth,
  requireEntitlement("grow.contacts.manage"),
  async (req, res) => {
    const user = req.authedUser!;
    const partyId = parsePositiveId(req.params.partyId);
    if (partyId === null) return void res.status(400).json({ error: "Invalid contact id." });
    const body = createContactThreadSchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "Invalid request." });
    try {
      const thread = await createThread({
        brokerageId: user.brokerageId,
        partyId,
        transactionId: body.data.transactionId ?? null,
        subject: body.data.subject,
        createdByUserId: user.id,
      });
      res.status(201).json(thread);
    } catch (err) {
      if (!handleCommunicationsError(err, res)) throw err;
    }
  },
);

// The contact-first analogue of GET /properties/:propertyId/communications/
// recipients above: a party-anchored thread has no propertyParties links to
// resolve candidates from, so the candidate pool is simply the one contact
// itself, shaped identically (`candidates: CandidateRecipient[]`) so a
// composer built against the property-first shape needs no special-casing.
communicationsRouter.get(
  "/grow/contacts/:partyId/communications/recipients",
  requireAuth,
  requireEntitlement("grow.contacts.read"),
  async (req, res) => {
    const user = req.authedUser!;
    const partyId = parsePositiveId(req.params.partyId);
    if (partyId === null) return void res.status(400).json({ error: "Invalid contact id." });
    const candidate = await getContactRecipientCandidate(partyId, user.brokerageId);
    res.json({ candidates: candidate ? [candidate] : [] });
  },
);

// ---------------------------------------------------------------------
// Participants (Section 11).
// ---------------------------------------------------------------------

const addParticipantFromPartySchema = z.object({ partyId: z.coerce.number().int(), role: z.string().min(1) });

communicationsRouter.post("/communications/threads/:threadId/participants", requireAuth, requireGrowForContactThreadByThreadId(), async (req, res) => {
  const user = req.authedUser!;
  const threadId = parsePositiveId(req.params.threadId);
  if (threadId === null) return void res.status(400).json({ error: "Invalid thread id." });
  const body = addParticipantFromPartySchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const participant = await addParticipantFromParty({
      threadId,
      brokerageId: user.brokerageId,
      partyId: body.data.partyId,
      role: body.data.role,
      addedByUserId: user.id,
    });
    res.status(201).json(participant);
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

const addManualParticipantSchema = z.object({
  displayName: z.string().min(1),
  role: z.string().min(1),
  email: z.string().email().optional(),
  mobile: z.string().min(1).optional(),
  reason: z.string().min(1),
});

communicationsRouter.post("/communications/threads/:threadId/participants/manual", requireAuth, requireGrowForContactThreadByThreadId(), async (req, res) => {
  const user = req.authedUser!;
  const threadId = parsePositiveId(req.params.threadId);
  if (threadId === null) return void res.status(400).json({ error: "Invalid thread id." });
  const body = addManualParticipantSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const participant = await addManualParticipant({
      threadId,
      brokerageId: user.brokerageId,
      displayName: body.data.displayName,
      role: body.data.role,
      email: body.data.email ?? null,
      mobile: body.data.mobile ?? null,
      reason: body.data.reason,
      addedByUserId: user.id,
    });
    res.status(201).json(participant);
  } catch (err) {
    if (handleCommunicationsError(err, res)) return;
    // AE Step 2 closure — Part C: same fix as routes/financial.ts's
    // handlePlainError — this fallback trusts an unrecognised Error to be a
    // deliberate, safe-to-disclose validation message (addManualParticipant
    // has no other typed error class of its own), but previously logged
    // nothing before responding, leaving zero diagnostic trail if that
    // assumption is ever wrong. The response contract is unchanged.
    if (err instanceof Error) {
      logger.warn("communications_add_manual_participant_plain_error", { error: err });
      return void res.status(422).json({ error: err.message });
    }
    throw err;
  }
});

// ---------------------------------------------------------------------
// Messages / the composer (Section 13) and its lifecycle actions.
// ---------------------------------------------------------------------

const createDraftMessageSchema = z.object({
  transactionId: z.coerce.number().int().optional(),
  channel: z.enum(COMMUNICATION_CHANNELS),
  classification: z.enum(COMMUNICATION_CLASSIFICATIONS),
  subject: z.string().optional(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  sendOnBehalfOfUserId: z.coerce.number().int().optional(),
  recipientParticipantId: z.coerce.number().int().optional(),
  recipientDisplayName: z.string().optional(),
  recipientDestination: z.string().optional(),
  templateId: z.coerce.number().int().optional(),
  placeholderValues: z.record(z.string()).optional(),
});

communicationsRouter.post("/communications/threads/:threadId/messages", requireAuth, requireGrowForContactThreadByThreadId(), async (req, res) => {
  const user = req.authedUser!;
  const threadId = parsePositiveId(req.params.threadId);
  if (threadId === null) return void res.status(400).json({ error: "Invalid thread id." });
  const body = createDraftMessageSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    // AE Grow Priority 3: propertyId/partyId are no longer passed in here —
    // createDraftMessage derives both directly from the thread itself (see
    // messages.ts), so a draft can never disagree with its own thread's
    // property/contact anchor. This also means a contact-first thread (no
    // propertyId at all) works here unchanged.
    const message = await createDraftMessage({
      threadId,
      brokerageId: user.brokerageId,
      transactionId: body.data.transactionId ?? null,
      channel: body.data.channel,
      classification: body.data.classification,
      subject: body.data.subject ?? null,
      bodyText: body.data.bodyText,
      bodyHtml: body.data.bodyHtml ?? null,
      senderUserId: user.id,
      sendOnBehalfOfUserId: body.data.sendOnBehalfOfUserId ?? null,
      recipientParticipantId: body.data.recipientParticipantId ?? null,
      recipientDisplayName: body.data.recipientDisplayName ?? null,
      recipientDestination: body.data.recipientDestination ?? null,
      templateId: body.data.templateId ?? null,
      placeholderValues: body.data.placeholderValues,
      createdByUserId: user.id,
    });
    res.status(201).json(message);
  } catch (err) {
    if (err instanceof CommunicationTemplateError) return void res.status(422).json({ error: err.message });
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

communicationsRouter.get("/communications/messages/:messageId", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const messageId = parsePositiveId(req.params.messageId);
  if (messageId === null) return void res.status(400).json({ error: "Invalid message id." });
  try {
    const message = await getMessage(messageId, user.brokerageId);
    res.json(message);
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

const versionedActionSchema = z.object({ expectedVersion: z.coerce.number().int().min(0) });
const cancelActionSchema = versionedActionSchema.extend({ reason: z.string().optional() });

communicationsRouter.post("/communications/messages/:messageId/request-approval", requireAuth, requireGrowForContactThreadByMessageId(), async (req, res) => {
  const user = req.authedUser!;
  const messageId = parsePositiveId(req.params.messageId);
  if (messageId === null) return void res.status(400).json({ error: "Invalid message id." });
  const body = versionedActionSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const message = await requestApproval(messageId, user.brokerageId, user.id, body.data.expectedVersion);
    res.json(message);
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

communicationsRouter.post("/communications/messages/:messageId/approve", requireAuth, requireGrowForContactThreadByMessageId(), async (req, res) => {
  const user = req.authedUser!;
  const messageId = parsePositiveId(req.params.messageId);
  if (messageId === null) return void res.status(400).json({ error: "Invalid message id." });
  const body = versionedActionSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const message = await approveMessage(messageId, user.brokerageId, user.id, body.data.expectedVersion);
    res.json(message);
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

communicationsRouter.post("/communications/messages/:messageId/cancel", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const messageId = parsePositiveId(req.params.messageId);
  if (messageId === null) return void res.status(400).json({ error: "Invalid message id." });
  const body = cancelActionSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const message = await cancelMessage(messageId, user.brokerageId, user.id, body.data.expectedVersion, body.data.reason);
    res.json(message);
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

communicationsRouter.post("/communications/messages/:messageId/send", requireAuth, requireGrowForContactThreadByMessageId(), async (req, res) => {
  const user = req.authedUser!;
  const messageId = parsePositiveId(req.params.messageId);
  if (messageId === null) return void res.status(400).json({ error: "Invalid message id." });
  const body = versionedActionSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const result = await sendMessageNow(messageId, user.brokerageId, user.id, body.data.expectedVersion);
    res.json(result);
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

communicationsRouter.post("/communications/messages/:messageId/requeue", requireAuth, requireGrowForContactThreadByMessageId(), async (req, res) => {
  const user = req.authedUser!;
  const messageId = parsePositiveId(req.params.messageId);
  if (messageId === null) return void res.status(400).json({ error: "Invalid message id." });
  const body = versionedActionSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const result = await requeueMessage(messageId, user.brokerageId, user.id, body.data.expectedVersion);
    res.json(result);
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

// ---------------------------------------------------------------------
// Templates (Section 14).
// ---------------------------------------------------------------------

const templateCategorySchema = z.enum(["LAUNCH", "TRANSACTION", "PC_EVENT", "GENERAL"]);

const createTemplateSchema = z.object({
  templateKey: z.string().min(1),
  name: z.string().min(1),
  channel: z.enum(COMMUNICATION_CHANNELS),
  classification: z.enum(COMMUNICATION_CLASSIFICATIONS),
  category: templateCategorySchema,
  subject: z.string().optional(),
  bodyText: z.string().min(1),
  bodyHtml: z.string().optional(),
  placeholders: z.array(z.string()).default([]),
});

communicationsRouter.get("/communications/templates", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const channel = typeof req.query.channel === "string" ? req.query.channel : undefined;
  const category = typeof req.query.category === "string" ? req.query.category : undefined;
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const templates = await listTemplatesForBrokerage(user.brokerageId, {
    channel: channel as (typeof COMMUNICATION_CHANNELS)[number] | undefined,
    category: category as "LAUNCH" | "TRANSACTION" | "PC_EVENT" | "GENERAL" | undefined,
    status: status as "DRAFT" | "ACTIVE" | "ARCHIVED" | undefined,
  });
  res.json({ templates });
});

communicationsRouter.post("/communications/templates", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const body = createTemplateSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const template = await createTemplate({ ...body.data, brokerageId: user.brokerageId, createdByUserId: user.id });
    res.status(201).json(template);
  } catch (err) {
    if (err instanceof CommunicationTemplateError) return void res.status(422).json({ error: err.message });
    throw err;
  }
});

const createTemplateVersionSchema = z.object({
  name: z.string().optional(),
  subject: z.string().optional(),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  placeholders: z.array(z.string()).optional(),
});

communicationsRouter.post("/communications/templates/:templateId/versions", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const templateId = parsePositiveId(req.params.templateId);
  if (templateId === null) return void res.status(400).json({ error: "Invalid template id." });
  const body = createTemplateVersionSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const template = await createTemplateVersion({ ...body.data, templateId, brokerageId: user.brokerageId, createdByUserId: user.id });
    res.status(201).json(template);
  } catch (err) {
    if (err instanceof CommunicationTemplateError) return void res.status(422).json({ error: err.message });
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

communicationsRouter.post("/communications/templates/:templateId/activate", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const templateId = parsePositiveId(req.params.templateId);
  if (templateId === null) return void res.status(400).json({ error: "Invalid template id." });
  try {
    const template = await activateTemplate(templateId, user.brokerageId, user.id);
    res.json(template);
  } catch (err) {
    if (err instanceof CommunicationTemplateError) return void res.status(422).json({ error: err.message });
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

communicationsRouter.post("/communications/templates/:templateId/archive", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const templateId = parsePositiveId(req.params.templateId);
  if (templateId === null) return void res.status(400).json({ error: "Invalid template id." });
  try {
    const template = await archiveTemplate(templateId, user.brokerageId, user.id);
    res.json(template);
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

// ---------------------------------------------------------------------
// Consent (Section 16).
//
// AE GROW W1-A (A-2): these two routes were requireAuth-only. routes/
// index.ts mounts every router with no requireEntitlement, and this router
// has no router-level .use() guard, so any authenticated user in the
// brokerage could POST marketingOptIn: true for any destination with
// source "MANUAL" and no evidence — i.e. manufacture marketing consent for
// a recipient who never gave it, and then watch the MARKETING gate in
// lib/communications/consent.ts wave the resulting send through.
//
// Consent and DNC are contact-management controls, so they are gated on the
// canonical Grow contact-management keys (packages/db/src/schema/billing.ts)
// — grow.contacts.manage to change a consent record, grow.contacts.read to
// interrogate one — matching the /grow/contacts/:partyId/communications/...
// routes above, which already carry exactly this pair.
// ---------------------------------------------------------------------

communicationsRouter.get("/communications/consent", requireAuth, requireEntitlement("grow.contacts.read"), async (req, res) => {
  const user = req.authedUser!;
  const channel = req.query.channel;
  const destination = req.query.destination;
  const classification = req.query.classification;
  if (channel !== "EMAIL" && channel !== "SMS") return void res.status(400).json({ error: "channel must be EMAIL or SMS." });
  if (typeof destination !== "string" || !destination) return void res.status(400).json({ error: "destination is required." });
  if (classification !== "TRANSACTIONAL" && classification !== "SERVICE" && classification !== "MARKETING") {
    return void res.status(400).json({ error: "classification must be TRANSACTIONAL, SERVICE, or MARKETING." });
  }
  const result = await checkConsent(user.brokerageId, channel, destination, classification);
  res.json(result);
});

const recordConsentSchema = z.object({
  channel: z.enum(["EMAIL", "SMS"]),
  destination: z.string().min(1),
  partyId: z.coerce.number().int().optional(),
  marketingOptIn: z.boolean().optional(),
  transactionalOptOut: z.boolean().optional(),
  notes: z.string().optional(),
});

communicationsRouter.post("/communications/consent", requireAuth, requireEntitlement("grow.contacts.manage"), async (req, res) => {
  const user = req.authedUser!;
  const body = recordConsentSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const consent = await recordConsent({ ...body.data, brokerageId: user.brokerageId, source: "MANUAL", recordedByUserId: user.id });
    res.status(201).json(consent);
  } catch (err) {
    // AE GROW W1-A (A-5): a partyId the caller's brokerage does not own is a
    // bad request body, not a missing resource — 400, and recordConsent has
    // already guaranteed nothing was written and nothing published.
    if (err instanceof CommunicationConsentPartyError) return void res.status(400).json({ error: err.message });
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

// ---------------------------------------------------------------------
// Cost control (Section 21) and settings (Sections 16/21/22).
// ---------------------------------------------------------------------

communicationsRouter.get("/communications/cost-summary", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const summary = await getCostSummary(user.brokerageId, user.id);
  res.json(summary);
});

communicationsRouter.get("/communications/settings", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const settings = await getOrCreateCommunicationSettings(user.brokerageId);
  res.json(settings);
});

const updateSettingsSchema = z.object({
  timeZone: z.string().nullable().optional(),
  quietHoursStart: z.string().nullable().optional(),
  quietHoursEnd: z.string().nullable().optional(),
  smsSoftThresholdCents: z.coerce.number().int().min(0).optional(),
  smsHardThresholdCents: z.coerce.number().int().min(0).optional(),
  transactionalOptOutAllowed: z.boolean().optional(),
});

communicationsRouter.patch(
  "/communications/settings",
  requireAuth,
  requireRole(...BROKERAGE_ADMIN_ROLES),
  async (req, res) => {
    const user = req.authedUser!;
    const body = updateSettingsSchema.safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: "Invalid request." });
    const settings = await updateCommunicationSettings(user.brokerageId, body.data);
    res.json(settings);
  },
);
