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

import { Router, type Response } from "express";
import { z } from "zod";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import {
  createThread,
  getThread,
  listThreadsForProperty,
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
import { listRecipientCandidatesForProperty, addParticipantFromParty, addManualParticipant } from "../lib/communications/recipientResolution.js";
import {
  createTemplate,
  createTemplateVersion,
  activateTemplate,
  archiveTemplate,
  listTemplatesForBrokerage,
  CommunicationTemplateError,
} from "../lib/communications/templates.js";
import { checkConsent, recordConsent } from "../lib/communications/consent.js";
import { getCostSummary } from "../lib/communications/costControl.js";
import { getOrCreateCommunicationSettings, updateCommunicationSettings } from "../lib/communications/settings.js";
import {
  CommunicationTenancyError,
  CommunicationConcurrencyError,
  CommunicationTransitionError,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_CLASSIFICATIONS,
} from "../lib/communications/types.js";

export const communicationsRouter = Router();

function handleCommunicationsError(err: unknown, res: Response): boolean {
  if (err instanceof CommunicationConcurrencyError) {
    res.status(409).json({ error: err.message });
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
  const propertyId = Number(req.params.propertyId);
  try {
    const threads = await listThreadsForProperty(propertyId, user.brokerageId);
    res.json({ threads });
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

communicationsRouter.post("/properties/:propertyId/communications/threads", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const propertyId = Number(req.params.propertyId);
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
  const propertyId = Number(req.params.propertyId);
  try {
    const candidates = await listRecipientCandidatesForProperty(propertyId, user.brokerageId);
    res.json({ candidates });
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

communicationsRouter.get("/communications/threads/:threadId", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const threadId = Number(req.params.threadId);
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
// Participants (Section 11).
// ---------------------------------------------------------------------

const addParticipantFromPartySchema = z.object({ partyId: z.coerce.number().int(), role: z.string().min(1) });

communicationsRouter.post("/communications/threads/:threadId/participants", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const threadId = Number(req.params.threadId);
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

communicationsRouter.post("/communications/threads/:threadId/participants/manual", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const threadId = Number(req.params.threadId);
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
    if (err instanceof Error) return void res.status(422).json({ error: err.message });
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

communicationsRouter.post("/communications/threads/:threadId/messages", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const threadId = Number(req.params.threadId);
  const body = createDraftMessageSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const thread = await getThread(threadId, user.brokerageId);
    const message = await createDraftMessage({
      threadId,
      brokerageId: user.brokerageId,
      propertyId: thread.propertyId,
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
  const messageId = Number(req.params.messageId);
  try {
    const message = await getMessage(messageId, user.brokerageId);
    res.json(message);
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

const versionedActionSchema = z.object({ expectedVersion: z.coerce.number().int().min(0) });
const cancelActionSchema = versionedActionSchema.extend({ reason: z.string().optional() });

communicationsRouter.post("/communications/messages/:messageId/request-approval", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const messageId = Number(req.params.messageId);
  const body = versionedActionSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const message = await requestApproval(messageId, user.brokerageId, user.id, body.data.expectedVersion);
    res.json(message);
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

communicationsRouter.post("/communications/messages/:messageId/approve", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const messageId = Number(req.params.messageId);
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
  const messageId = Number(req.params.messageId);
  const body = cancelActionSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const message = await cancelMessage(messageId, user.brokerageId, user.id, body.data.expectedVersion, body.data.reason);
    res.json(message);
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

communicationsRouter.post("/communications/messages/:messageId/send", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const messageId = Number(req.params.messageId);
  const body = versionedActionSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  try {
    const result = await sendMessageNow(messageId, user.brokerageId, user.id, body.data.expectedVersion);
    res.json(result);
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

communicationsRouter.post("/communications/messages/:messageId/requeue", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const messageId = Number(req.params.messageId);
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
  const templateId = Number(req.params.templateId);
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
  const templateId = Number(req.params.templateId);
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
  const templateId = Number(req.params.templateId);
  try {
    const template = await archiveTemplate(templateId, user.brokerageId, user.id);
    res.json(template);
  } catch (err) {
    if (!handleCommunicationsError(err, res)) throw err;
  }
});

// ---------------------------------------------------------------------
// Consent (Section 16).
// ---------------------------------------------------------------------

communicationsRouter.get("/communications/consent", requireAuth, async (req, res) => {
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

communicationsRouter.post("/communications/consent", requireAuth, async (req, res) => {
  const user = req.authedUser!;
  const body = recordConsentSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "Invalid request." });
  const consent = await recordConsent({ ...body.data, brokerageId: user.brokerageId, source: "MANUAL", recordedByUserId: user.id });
  res.status(201).json(consent);
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
