// Agent Engine 2.0 — Step 5: Integration and Data Exchange Foundation.
//
// Minimal admin/operational HTTP surface (Section 9): no generic
// arbitrary-HTTP endpoint, every handler re-derives brokerageId from
// req.authedUser (never a client-supplied tenant id — mirrors
// routes/exceptions.ts's own header comment), and every mutating action is
// gated to Brokerage Administrator only (this is operational integration
// tooling, the same weight class as routes/exceptions.ts's
// /exceptions/ops/* surface). Never returns a credential's secretIdentifier
// value to the client (Section 10: "never display credential values").

import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireRole, BROKERAGE_ADMIN_ROLES } from "../middlewares/auth.js";
import { listProviderCatalogue, resolveActiveConnection } from "../lib/integrations/registry.js";
import {
  createDraftConnection,
  requestApproval,
  decideApproval,
  beginConfiguration,
  validateConnection,
  suspendConnection,
  resumeConnection,
  revokeConnection,
  listConnectionsForBrokerage,
  loadConnectionInBrokerage,
  getConnectionTransitions,
} from "../lib/integrations/model.js";
import { mintMockAuthFlow } from "../lib/integrations/credentials.js";
import { listDeadLettersForBrokerage, loadDeadLetterInBrokerage } from "../lib/integrations/deadLetters.js";
import { replayDeadLetteredCommand } from "../lib/integrations/outbox.js";
import { replayDeadLetteredWebhook } from "../lib/integrations/webhooks.js";
import { publishListingToMockPortal } from "../lib/integrations/launchProof.js";
import { sendSmsViaIntegration } from "../lib/integrations/commsProof.js";
import { linkPaymentRequestToExternalReference, MockPaymentStatusSyncError, MappingConflictError } from "../lib/financial/mockPaymentStatusSync.js";
import { getIntegrationOverview, getIntegrationActivity, getReconciliationSnapshot } from "../lib/integrations/adminViews.js";
import { getOrCreateIntegrationSettings, updateIntegrationSettings } from "../lib/integrations/settings.js";
import { IntegrationError, INTEGRATION_CAPABILITIES } from "../lib/integrations/types.js";
import { CommunicationTenancyError, CommunicationTransitionError } from "../lib/communications/types.js";
import { OutboundConsentRefused } from "../lib/communications/outboundConsent.js";

export const integrationsRouter = Router();

function actorFrom(user: { id: number; role: string }) {
  return { id: user.id, role: user.role };
}

function statusForIntegrationError(reason: string): number {
  switch (reason) {
    case "NOT_FOUND":
      return 404;
    case "INVALID_STATUS":
    case "CONCURRENCY":
    case "CONNECTION_NOT_USABLE":
    case "SCOPE_NOT_APPROVED":
    case "ENVIRONMENT_NOT_ALLOWED":
      return 409;
    case "ENTITLEMENT_DENIED":
    case "BROKERAGE_DISABLED":
      return 403;
    default:
      return 400;
  }
}

function handleIntegrationError(err: unknown, res: import("express").Response): boolean {
  if (err instanceof IntegrationError) {
    res.status(statusForIntegrationError(err.reason)).json({ error: err.message, reason: err.reason });
    return true;
  }
  return false;
}

// All routes below are Brokerage Administrator only — see this file's own
// header comment for why (operational integration tooling, not a
// per-property agent action).
integrationsRouter.use(requireAuth, requireRole(...BROKERAGE_ADMIN_ROLES));

// ---------------------------------------------------------------------
// Settings.
// ---------------------------------------------------------------------

integrationsRouter.get("/integrations/settings", async (req, res) => {
  const settings = await getOrCreateIntegrationSettings(req.authedUser!.brokerageId);
  res.json({ settings });
});

const updateSettingsSchema = z.object({ enabled: z.boolean().optional(), maxActiveConnections: z.number().int().min(0).max(100).optional() });
integrationsRouter.put("/integrations/settings", async (req, res) => {
  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const settings = await updateIntegrationSettings(req.authedUser!.brokerageId, parsed.data);
  res.json({ settings });
});

// ---------------------------------------------------------------------
// Provider catalogue (read-only — Section 10: never suggest a real
// provider is already connected; this only ever returns catalogue rows the
// admin can start a DRAFT connection against).
// ---------------------------------------------------------------------

integrationsRouter.get("/integrations/providers", async (_req, res) => {
  const providers = await listProviderCatalogue();
  res.json({ providers });
});

// ---------------------------------------------------------------------
// AE Step 5 remediation — admin UI read models (12.1/12.3/12.5). Each is a
// thin pass-through to lib/integrations/adminViews.ts — see that file's own
// header comment for why the reconciliation view is on-demand/live-computed
// rather than a persisted "run".
// ---------------------------------------------------------------------

integrationsRouter.get("/integrations/overview", async (req, res) => {
  const overview = await getIntegrationOverview(req.authedUser!.brokerageId);
  res.json({ overview });
});

const activityQuerySchema = z.object({
  connectionId: z.string().optional(),
  direction: z.enum(["OUTBOUND", "INBOUND"]).optional(),
  status: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
integrationsRouter.get("/integrations/activity", async (req, res) => {
  const parsed = activityQuerySchema.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  const activity = await getIntegrationActivity(req.authedUser!.brokerageId, {
    connectionId: parsed.data.connectionId,
    direction: parsed.data.direction,
    status: parsed.data.status,
    from: parsed.data.from ? new Date(parsed.data.from) : undefined,
    to: parsed.data.to ? new Date(parsed.data.to) : undefined,
    limit: parsed.data.limit,
  });
  res.json({ activity });
});

integrationsRouter.get("/integrations/reconciliation", async (req, res) => {
  const snapshot = await getReconciliationSnapshot(req.authedUser!.brokerageId);
  res.json({ snapshot });
});

// ---------------------------------------------------------------------
// Connections.
// ---------------------------------------------------------------------

integrationsRouter.get("/integrations/connections", async (req, res) => {
  const connections = await listConnectionsForBrokerage(req.authedUser!.brokerageId);
  res.json({ connections });
});

const createConnectionSchema = z.object({
  providerId: z.string().min(1),
  displayName: z.string().min(1).max(200),
  purpose: z.string().min(1).max(1000),
  requestedScopes: z.array(z.string()).min(1),
});
integrationsRouter.post("/integrations/connections", async (req, res) => {
  const parsed = createConnectionSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  try {
    const connection = await createDraftConnection(req.authedUser!.brokerageId, actorFrom(req.authedUser!), parsed.data as any);
    res.status(201).json({ connection });
  } catch (err) {
    if (handleIntegrationError(err, res)) return;
    throw err;
  }
});

integrationsRouter.get("/integrations/connections/:id", async (req, res) => {
  try {
    const connection = await loadConnectionInBrokerage(req.params.id, req.authedUser!.brokerageId);
    const transitions = await getConnectionTransitions(req.params.id, req.authedUser!.brokerageId);
    // Never includes integration_credentials rows — Section 10: "never
    // display credential values" (the row itself carries no value, only an
    // opaque reference, but this endpoint omits it entirely regardless).
    res.json({ connection, transitions });
  } catch (err) {
    if (handleIntegrationError(err, res)) return;
    throw err;
  }
});

const versionedSchema = z.object({ expectedVersion: z.number().int() });

integrationsRouter.post("/integrations/connections/:id/request-approval", async (req, res) => {
  const parsed = versionedSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  try {
    const connection = await requestApproval(req.params.id, req.authedUser!.brokerageId, actorFrom(req.authedUser!), parsed.data.expectedVersion);
    res.json({ connection });
  } catch (err) {
    if (handleIntegrationError(err, res)) return;
    throw err;
  }
});

const decideApprovalSchema = z.object({
  expectedVersion: z.number().int(),
  decision: z.enum(["APPROVED", "REJECTED"]),
  approvedScopes: z.array(z.string()).nullable().optional(),
  authorityUserId: z.number().int().nullable().optional(),
  reason: z.string().max(2000).nullable().optional(),
});
integrationsRouter.post("/integrations/connections/:id/decide-approval", async (req, res) => {
  const parsed = decideApprovalSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  try {
    const connection = await decideApproval(
      req.params.id,
      req.authedUser!.brokerageId,
      actorFrom(req.authedUser!),
      parsed.data.expectedVersion,
      parsed.data.decision,
      (parsed.data.approvedScopes as any) ?? null,
      parsed.data.authorityUserId ?? null,
      parsed.data.reason ?? null,
    );
    res.json({ connection });
  } catch (err) {
    if (handleIntegrationError(err, res)) return;
    throw err;
  }
});

integrationsRouter.post("/integrations/connections/:id/mint-credential", async (req, res) => {
  try {
    const credential = await mintMockAuthFlow(req.params.id, req.authedUser!.brokerageId, actorFrom(req.authedUser!));
    // Deliberately omit secretIdentifier from the response (Section 10).
    res.status(201).json({ credential: { id: credential.id, referenceType: credential.referenceType, status: credential.status, createdAt: credential.createdAt } });
  } catch (err) {
    if (handleIntegrationError(err, res)) return;
    throw err;
  }
});

integrationsRouter.post("/integrations/connections/:id/configure", async (req, res) => {
  const parsed = versionedSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  try {
    const connection = await beginConfiguration(req.params.id, req.authedUser!.brokerageId, actorFrom(req.authedUser!), parsed.data.expectedVersion);
    res.json({ connection });
  } catch (err) {
    if (handleIntegrationError(err, res)) return;
    throw err;
  }
});

integrationsRouter.post("/integrations/connections/:id/validate", async (req, res) => {
  const parsed = versionedSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  try {
    const connection = await validateConnection(req.params.id, req.authedUser!.brokerageId, actorFrom(req.authedUser!), parsed.data.expectedVersion);
    res.json({ connection });
  } catch (err) {
    if (handleIntegrationError(err, res)) return;
    throw err;
  }
});

const reasonedSchema = z.object({ expectedVersion: z.number().int(), reason: z.string().min(1).max(2000) });

integrationsRouter.post("/integrations/connections/:id/suspend", async (req, res) => {
  const parsed = reasonedSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  try {
    const connection = await suspendConnection(req.params.id, req.authedUser!.brokerageId, actorFrom(req.authedUser!), parsed.data.expectedVersion, parsed.data.reason);
    res.json({ connection });
  } catch (err) {
    if (handleIntegrationError(err, res)) return;
    throw err;
  }
});

integrationsRouter.post("/integrations/connections/:id/resume", async (req, res) => {
  const parsed = versionedSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  try {
    const connection = await resumeConnection(req.params.id, req.authedUser!.brokerageId, actorFrom(req.authedUser!), parsed.data.expectedVersion);
    res.json({ connection });
  } catch (err) {
    if (handleIntegrationError(err, res)) return;
    throw err;
  }
});

integrationsRouter.post("/integrations/connections/:id/revoke", async (req, res) => {
  const parsed = reasonedSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  try {
    const connection = await revokeConnection(req.params.id, req.authedUser!.brokerageId, actorFrom(req.authedUser!), parsed.data.expectedVersion, parsed.data.reason);
    res.json({ connection });
  } catch (err) {
    if (handleIntegrationError(err, res)) return;
    throw err;
  }
});

// ---------------------------------------------------------------------
// Domain Proof A action (Section 15's "controlled actions" — this is the
// one real, working action this build ships beyond generic lifecycle
// management: publish a Launch portal destination through an ACTIVE mock
// portal connection).
// ---------------------------------------------------------------------

const publishListingSchema = z.object({ portalDestinationId: z.string().min(1) });
integrationsRouter.post("/integrations/connections/:id/actions/publish-listing", async (req, res) => {
  const parsed = publishListingSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  try {
    const result = await publishListingToMockPortal(parsed.data.portalDestinationId, req.authedUser!.brokerageId, req.params.id, actorFrom(req.authedUser!));
    res.json({ result });
  } catch (err) {
    if (handleIntegrationError(err, res)) return;
    throw err;
  }
});

// ---------------------------------------------------------------------
// AE Step 5 remediation — Proof B action (Communications Hub): send an
// existing DRAFT/APPROVED SMS message through an ACTIVE mock SMS
// connection. Brokerage-Administrator-only, same weight class as every
// other action on this router — see commsProof.ts's own header comment on
// why the communications.sms entitlement check inside sendSmsViaIntegration
// is a SEPARATE authority from this route's own requireRole gate.
// ---------------------------------------------------------------------

const sendSmsSchema = z.object({ messageId: z.number().int() });
integrationsRouter.post("/integrations/connections/:id/actions/send-sms", async (req, res) => {
  const parsed = sendSmsSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  try {
    const result = await sendSmsViaIntegration({
      messageId: parsed.data.messageId,
      brokerageId: req.authedUser!.brokerageId,
      connectionId: req.params.id,
      actor: actorFrom(req.authedUser!),
    });
    res.json({ result: { outcome: result.outcome, messageId: result.message.id, status: result.message.status } });
  } catch (err) {
    if (handleIntegrationError(err, res)) return;
    if (err instanceof OutboundConsentRefused) return void res.status(err.statusCode).json({ error: err.message, code: err.code });
    if (err instanceof CommunicationTenancyError) return void res.status(404).json({ error: "Message not found." });
    if (err instanceof CommunicationTransitionError) return void res.status(409).json({ error: err.message });
    throw err;
  }
});

// ---------------------------------------------------------------------
// AE Step 5 remediation — Proof C action (Financial Transaction Engine):
// link an existing payment request to the mock processor's own external
// reference — the bookkeeping half of Proof C's mapping (see
// mockPaymentStatusSync.ts's own header comment: there is no outbound
// "submit a payment" call in this build, only this reference-linking action
// plus the inbound mock status webhook).
// ---------------------------------------------------------------------

const linkPaymentReferenceSchema = z.object({ paymentRequestId: z.number().int(), externalReference: z.string().min(1).max(200) });
integrationsRouter.post("/integrations/connections/:id/actions/link-payment-reference", async (req, res) => {
  const parsed = linkPaymentReferenceSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: parsed.error.flatten() });
  try {
    await resolveActiveConnection(req.authedUser!.brokerageId, req.params.id, INTEGRATION_CAPABILITIES.PAYMENTS_STATUS_SYNC);
    await linkPaymentRequestToExternalReference(parsed.data.paymentRequestId, req.authedUser!.brokerageId, req.params.id, parsed.data.externalReference, actorFrom(req.authedUser!));
    res.status(201).json({ linked: true });
  } catch (err) {
    if (handleIntegrationError(err, res)) return;
    if (err instanceof MappingConflictError) return void res.status(409).json({ error: err.message });
    if (err instanceof MockPaymentStatusSyncError) return void res.status(err.reason === "NOT_FOUND" ? 404 : 400).json({ error: err.message });
    throw err;
  }
});

// ---------------------------------------------------------------------
// Dead-letters (Section 7 — authorised replay only).
// ---------------------------------------------------------------------

integrationsRouter.get("/integrations/dead-letters", async (req, res) => {
  const deadLetters = await listDeadLettersForBrokerage(req.authedUser!.brokerageId);
  res.json({ deadLetters });
});

integrationsRouter.get("/integrations/dead-letters/:id", async (req, res) => {
  try {
    const deadLetter = await loadDeadLetterInBrokerage(req.params.id, req.authedUser!.brokerageId);
    res.json({ deadLetter });
  } catch {
    res.status(404).json({ error: "Not found" });
  }
});

integrationsRouter.post("/integrations/dead-letters/:id/replay", async (req, res) => {
  const brokerageId = req.authedUser!.brokerageId;
  const actor = actorFrom(req.authedUser!);
  try {
    const letter = await loadDeadLetterInBrokerage(req.params.id, brokerageId);
    if (letter.sourceType === "OUTBOX") {
      const result = await replayDeadLetteredCommand(req.params.id, brokerageId, actor);
      res.json({ replayed: true, sourceType: "OUTBOX", outboxStatus: result.status });
    } else {
      const { result } = await replayDeadLetteredWebhook(req.params.id, brokerageId, actor);
      res.json({ replayed: true, sourceType: "INBOX", detail: result?.detail ?? null });
    }
  } catch (err) {
    if (handleIntegrationError(err, res)) return;
    res.status(400).json({ error: err instanceof Error ? err.message : "Replay failed." });
  }
});

export { INTEGRATION_CAPABILITIES };
