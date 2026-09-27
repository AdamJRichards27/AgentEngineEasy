// AE GROW Priority 6 Stage F1 — Call Foundation, Consent Model and Sandbox
// Telephony.
//
// Authenticated call-session surface, entitlement-gated by
// grow.calling.access (session lifecycle) and grow.calling.recording
// (consent capture/withdrawal) — see packages/db/src/schema/billing.ts.
// F2 routes outbound creation and confirmation through the audited canonical
// PHONE_CALL decision. GET .../eligibility is a presentation poll: it uses
// the same evaluator read-only (no decision row, no consent advisory lock).
// Recording disclosure/confirmation remains an orthogonal in-call state machine.
// Nothing here places a real call: every session this router creates is
// provider = "sandbox" (lib/telephony/sandboxProvider.ts), and lifecycle
// progression beyond DIAL_REQUESTED only ever happens via the separate,
// signature-verified webhook route (routes/growCallsWebhooks.ts).
//
// §13 — Contact 360 integration point. GET .../eligibility is the cheap
// pre-check a "Call" button/action would use to decide whether to render
// at all (entitlement + a usable phone number); POST / is "select Call"
// (prepares a sandbox session and returns the exact number that would be
// dialled, matching the "Call Sarah Mitchell / 0412 XXX XXX / [Confirm
// Call] [Cancel]" UI example in the governing authorisation); POST
// /:id/confirm is the explicit user confirmation before anything — even a
// sandbox call — begins. This is a new, additive router rather than a
// change to the existing, already well-tested contactsRouter
// (routes/contacts.ts) — see the Stage F1 completion report for the full
// reasoning.
//
// Every route re-resolves its own party/session against req.authedUser's
// brokerageId — never trusts a client-supplied brokerageId or partyId
// beyond what that lookup itself proves, matching this codebase's
// established tenant-isolation convention (see e.g. growCommitmentActions.ts's
// own header comment).

import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, parties } from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { normalizePhoneNumber, PhoneNumberValidationError } from "../lib/telephony/phoneNumber.js";
import { noteGrowPartyIsolationRejection } from "../lib/grow/isolationRejection.js";
import {
  createCallSession,
  confirmCallSession,
  cancelCallSession,
  getCallSessionForBrokerage,
  recordInCallRecordingDisclosure,
  confirmInCallRecording,
  declineInCallRecording,
  assertCallSessionActorAuthorized,
  GrowCallSessionValidationError,
  GrowCallSessionNotFoundError,
  GrowCallSessionAuthorizationError,
} from "../lib/telephony/callSessions.js";
import {
  captureRecordingConsent,
  withdrawRecordingConsent,
  GrowCallConsentValidationError,
  GrowCallConsentNotFoundError,
} from "../lib/telephony/consent.js";
import { CallSessionTransitionError } from "../lib/telephony/stateMachine.js";
import { CallConsentEligibilityError, evaluateOutboundCallEligibilityReadOnly } from "../lib/telephony/eligibility.js";
import { evaluatePreCallRecordingGates, evaluateRecordingGates } from "../lib/telephony/recordingGates.js";
import { SandboxTelephonyProvider } from "../lib/telephony/sandboxProvider.js";
import {
  CallTranscriptionError,
  initiateCallTranscription,
} from "../lib/telephony/callTranscriptions.js";
import {
  CallTranscriptionReviewError,
  discardCallTranscription,
  getCallTranscriptionForReview,
  listCallTranscriptionsForContact,
  saveCallTranscriptionReview,
} from "../lib/telephony/callTranscriptionReview.js";
import { persistApprovedCallSummaryActivity } from "../lib/telephony/callTranscriptionTimeline.js";

export const growCallsRouter = Router();

growCallsRouter.use(requireAuth);

function parseIdParam(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

const CALL_ELIGIBILITY_STATUS = {
  READY: "Ready to call",
  CONSENT_REVIEW: "Consent needs review",
  DNCR_REVIEW: "Do Not Call check required",
  UNAVAILABLE: "Calling unavailable at this time",
} as const;

type CallEligibilityStatus = (typeof CALL_ELIGIBILITY_STATUS)[keyof typeof CALL_ELIGIBILITY_STATUS];

const DNCR_REVIEW_REASONS = new Set([
  "NO_VALID_DNCR_CLEARED_CONSENT",
  "DNCR_LISTED",
  "DNCR_STATUS_UNKNOWN",
  "DNCR_JURISDICTION_UNKNOWN",
  "DNCR_REVIEW_DUE",
]);

const CONSENT_REVIEW_REASONS = new Set([
  "WITHDRAWN",
  "SUPPRESSED",
  "UNKNOWN_CONSENT",
  "NO_CONSENT",
  "CONSENT_EXPIRED",
  "CONSENT_REVIEW_DUE",
  "UNKNOWN_JURISDICTION",
  "JURISDICTION_MISMATCH",
  "POLICY_NOT_FOUND",
  "POLICY_INVALID_WINDOW",
  "NOT_REQUIRED_JUSTIFICATION_MISSING",
  "NOT_REQUIRED_NOT_ENABLED_BY_POLICY",
  "INFERRED_EVIDENCE_MISSING",
  "INFERRED_NOT_ENABLED_BY_POLICY",
  "NO_VALID_CONSENT",
  "POLICY_INVALID_DNCR_CONFIG",
  "POLICY_INVALID_EFFECTIVE_AT",
  "POLICY_NOT_CURRENT",
  "COUNTRY_CONFIRMATION_REQUIRED",
]);

function callEligibilityStatus(reason: string | null, eligible: boolean): CallEligibilityStatus {
  if (eligible) return CALL_ELIGIBILITY_STATUS.READY;
  if (reason && DNCR_REVIEW_REASONS.has(reason)) return CALL_ELIGIBILITY_STATUS.DNCR_REVIEW;
  if (reason && CONSENT_REVIEW_REASONS.has(reason)) return CALL_ELIGIBILITY_STATUS.CONSENT_REVIEW;
  return CALL_ELIGIBILITY_STATUS.UNAVAILABLE;
}

/**
 * A call session does not exist before the agent selects Call, so evaluate the
 * five gates against an explicit pre-call shape. In particular, do not turn a
 * standing consent into a recording grant: disclosure and confirmation happen
 * in-call and the sandbox adapter cannot capture audio.
 */
function recordingGateResult(evaluation: Awaited<ReturnType<typeof evaluateRecordingGates>>, permitted: boolean) {
  return {
    evaluatedAt: evaluation.evidence.evaluatedAt,
    permitted,
    allPassed: evaluation.evidence.allPassed,
    gates: evaluation.evidence.gates,
    outboundDecisionId: evaluation.evidence.outboundDecisionId,
    outboundReasonCode: evaluation.evidence.outboundReasonCode,
  };
}

async function beforeCallRecordingStatus(input: {
  brokerageId: number;
  partyId: number;
  actor: { id: number; role: string; brokerageId: number };
  jurisdiction: "AU" | "NZ" | null;
}) {
  const provider = new SandboxTelephonyProvider();
  const evaluation = await evaluatePreCallRecordingGates({
    brokerageId: input.brokerageId,
    partyId: input.partyId,
    actor: input.actor,
    jurisdiction: input.jurisdiction,
    providerName: provider.name,
    providerCapabilities: provider.capabilities,
  });
  return {
    available: false,
    permitted: false,
    status: "Recording not permitted" as const,
    statusCode: "PRE_CALL_NOT_PERMITTED" as const,
    reason: "Recording remains off before in-call disclosure and confirmation; the server will re-check all gates while connected.",
    provider: "sandbox",
    fiveGateResult: recordingGateResult(evaluation, false),
  };
}

async function currentRecordingPresentation(
  session: Awaited<ReturnType<typeof getCallSessionForBrokerage>>,
  actor: { id: number; role: string; brokerageId: number },
) {
  const provider = new SandboxTelephonyProvider();
  const evaluation = await evaluateRecordingGates({
    session,
    actor,
    providerName: provider.name,
    providerCapabilities: provider.capabilities,
    readOnly: true,
  });
  const permitted = session.recordingPermitted === true && evaluation.permitted;
  return {
    available: permitted,
    permitted,
    status: permitted ? ("Recording available" as const) : ("Recording not permitted" as const),
    statusCode: session.recordingStatus,
    provider: session.provider,
    fiveGateResult: recordingGateResult(evaluation, permitted),
  };
}

growCallsRouter.get("/contacts/:partyId/eligibility", requireEntitlement("grow.calling.access"), async (req, res) => {
  const partyId = parseIdParam(req.params.partyId);
  if (partyId === null) {
    res.status(400).json({ error: "Invalid contact id." });
    return;
  }
  const authedUser = req.authedUser!;
  const rawAssumedCountry = typeof req.query.assumedCountry === "string" ? req.query.assumedCountry : undefined;
  if (rawAssumedCountry !== undefined && rawAssumedCountry !== "AU" && rawAssumedCountry !== "NZ") {
    res.status(400).json({ error: "assumedCountry must be AU or NZ." });
    return;
  }
  const assumedCountry = rawAssumedCountry as "AU" | "NZ" | undefined;

  const [party] = await db
    .select()
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.brokerageId, authedUser.brokerageId)))
    .limit(1);
  if (!party) {
    await noteGrowPartyIsolationRejection(partyId, authedUser.brokerageId);
    res.status(404).json({ error: "Contact not found." });
    return;
  }

  if (!party.mobile || party.mobile.trim().length === 0) {
    const recording = await beforeCallRecordingStatus({
      brokerageId: authedUser.brokerageId,
      partyId,
      actor: { id: authedUser.id, role: authedUser.role, brokerageId: authedUser.brokerageId },
      jurisdiction: null,
    });
    const status = callEligibilityStatus("NO_PHONE_NUMBER", false);
    res.json({
      eligible: false,
      status,
      eligibilityStatus: status,
      reason: "NO_PHONE_NUMBER",
      displayNumber: null,
      requiresCountryConfirmation: false,
      recording,
    });
    return;
  }

  try {
    const normalized = normalizePhoneNumber(party.mobile, { assumedCountry });
    const recording = await beforeCallRecordingStatus({
      brokerageId: authedUser.brokerageId,
      partyId,
      actor: { id: authedUser.id, role: authedUser.role, brokerageId: authedUser.brokerageId },
      jurisdiction: normalized.country,
    });
    try {
      // A-9: a UI poll must not append grow_consent_decisions or take the
      // consent advisory lock. The read-only evaluator uses the same
      // current-state lookups and pure decision as create/confirm, and it
      // never manufactures a decision id.
      await evaluateOutboundCallEligibilityReadOnly({
        brokerageId: authedUser.brokerageId,
        partyId,
        decidedByUserId: authedUser.id,
        jurisdiction: normalized.country,
      });
      res.json({
        eligible: true,
        status: CALL_ELIGIBILITY_STATUS.READY,
        eligibilityStatus: CALL_ELIGIBILITY_STATUS.READY,
        reason: "OK",
        displayNumber: party.mobile,
        requiresCountryConfirmation: false,
        consentDecisionId: null,
        recording,
      });
    } catch (err) {
      if (err instanceof CallConsentEligibilityError) {
        const status = callEligibilityStatus(err.reasonCode, false);
        res.json({
          eligible: false,
          status,
          eligibilityStatus: status,
          reason: err.reasonCode,
          displayNumber: party.mobile,
          requiresCountryConfirmation: false,
          consentDecisionId: err.decisionId,
          recording,
        });
        return;
      }
      throw err;
    }
  } catch (err) {
    if (err instanceof PhoneNumberValidationError && err.code === "AMBIGUOUS") {
      // An ambiguous national number has no authoritative country/jurisdiction
      // yet.  Evaluate the conservative PHONE_CALL decision read-only, but
      // never advertise it as dial-eligible until creation receives an
      // explicit assumedCountry. Creation still records the authoritative row.
      let consentDecisionId: number | null = null;
      let reason = "COUNTRY_CONFIRMATION_REQUIRED";
      const recording = await beforeCallRecordingStatus({
        brokerageId: authedUser.brokerageId,
        partyId,
        actor: { id: authedUser.id, role: authedUser.role, brokerageId: authedUser.brokerageId },
        jurisdiction: null,
      });
      try {
        await evaluateOutboundCallEligibilityReadOnly({
          brokerageId: authedUser.brokerageId,
          partyId,
          decidedByUserId: authedUser.id,
          jurisdiction: null,
        });
        consentDecisionId = null;
        reason = "COUNTRY_CONFIRMATION_REQUIRED";
      } catch (decisionError) {
        if (decisionError instanceof CallConsentEligibilityError) {
          consentDecisionId = decisionError.decisionId;
          reason = decisionError.reasonCode;
        } else {
          throw decisionError;
        }
      }
      const status = callEligibilityStatus(reason, false);
      res.json({
        eligible: false,
        status,
        eligibilityStatus: status,
        reason,
        displayNumber: party.mobile,
        requiresCountryConfirmation: true,
        consentDecisionId,
        recording,
      });
      return;
    }
    if (err instanceof PhoneNumberValidationError) {
      const recording = await beforeCallRecordingStatus({
        brokerageId: authedUser.brokerageId,
        partyId,
        actor: { id: authedUser.id, role: authedUser.role, brokerageId: authedUser.brokerageId },
        jurisdiction: null,
      });
      const status = callEligibilityStatus("INVALID_PHONE_NUMBER", false);
      res.json({
        eligible: false,
        status,
        eligibilityStatus: status,
        reason: "INVALID_PHONE_NUMBER",
        displayNumber: party.mobile,
        requiresCountryConfirmation: false,
        recording,
      });
      return;
    }
    throw err;
  }
});

/**
 * Recording is an orthogonal in-call state machine.  Disclosure is accepted
 * only after CONNECTED and never gates creation or dialling.  Confirmation
 * re-evaluates all five recording gates and leaves the base call untouched
 * when recording remains UNRECORDED.
 */
async function handleRecordingDisclosure(req: import("express").Request, res: import("express").Response) {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid call session id." });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const callSession = await recordInCallRecordingDisclosure({
      brokerageId: authedUser.brokerageId,
      callSessionId: id,
      disclosedByUserId: authedUser.id,
      disclosedByUserRole: authedUser.role,
    });
    res.json({ callSession });
  } catch (err) {
    if (err instanceof GrowCallSessionNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallSessionValidationError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallSessionAuthorizationError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }
}

async function handleRecordingConfirmation(req: import("express").Request, res: import("express").Response) {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid call session id." });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const callSession = await confirmInCallRecording({
      brokerageId: authedUser.brokerageId,
      callSessionId: id,
      confirmedByUserId: authedUser.id,
      actorRole: authedUser.role,
    });
    res.json({ callSession });
  } catch (err) {
    if (err instanceof GrowCallSessionNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallSessionValidationError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallSessionAuthorizationError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }
}

async function handleRecordingDecline(req: import("express").Request, res: import("express").Response) {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid call session id." });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const callSession = await declineInCallRecording({
      brokerageId: authedUser.brokerageId,
      callSessionId: id,
      declinedByUserId: authedUser.id,
      declinedByUserRole: authedUser.role,
    });
    res.json({ callSession });
  } catch (err) {
    if (err instanceof GrowCallSessionNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallSessionValidationError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallSessionAuthorizationError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }
}

for (const path of ["/:id/recording/disclosure", "/:id/recording/disclose"]) {
  growCallsRouter.post(path, requireEntitlement("grow.calling.access"), handleRecordingDisclosure);
}
growCallsRouter.post("/:id/recording/confirm", requireEntitlement("grow.calling.access"), handleRecordingConfirmation);
growCallsRouter.post("/:id/recording/decline", requireEntitlement("grow.calling.access"), handleRecordingDecline);

const initiateTranscriptionSchema = z.object({
  recordingReference: z.number().int().positive(),
});

/**
 * F3 submits only the canonical immutable recording-version reference. The
 * service, rather than this transport, resolves session ownership, active
 * recording content, F2 evidence, and the existing recording entitlement.
 */
growCallsRouter.post("/:id/transcription", requireEntitlement("grow.calling.transcription"), async (req, res) => {
  const callSessionId = parseIdParam(req.params.id);
  if (callSessionId === null) {
    res.status(400).json({ error: "Invalid call session id." });
    return;
  }
  const parsed = initiateTranscriptionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const transcription = await initiateCallTranscription({
      brokerageId: authedUser.brokerageId,
      callSessionId,
      recordingReference: parsed.data.recordingReference,
      actor: {
        userId: authedUser.id,
        role: authedUser.role,
        brokerageId: authedUser.brokerageId,
      },
    });
    res.status(transcription.processingState === "PENDING" ? 202 : 200).json({ transcription });
  } catch (error) {
    if (error instanceof CallTranscriptionError) {
      const status = error.code === "CALL_NOT_FOUND" ? 404
        : error.code === "ACCESS_DENIED" || error.code === "ENTITLEMENT_REQUIRED" ? 403
          : error.code === "INVALID_INPUT" ? 400 : 409;
      res.status(status).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});

function transcriptionReviewErrorStatus(error: CallTranscriptionReviewError): number {
  if (error.code === "INVALID_INPUT") return 400;
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "ACCESS_DENIED" || error.code === "ENTITLEMENT_REQUIRED") return 403;
  return 409;
}

/**
 * F3 review reads are tenant- and call-owner-scoped.  In particular, this
 * route never returns every transcription for a party merely because the
 * party itself is visible: listCallTranscriptionsForContact filters each
 * underlying call session through the same ownership rule as call reads.
 */
growCallsRouter.get("/contacts/:partyId/transcriptions", requireEntitlement("grow.calling.transcription"), async (req, res) => {
  const partyId = parseIdParam(req.params.partyId);
  if (partyId === null) {
    res.status(400).json({ error: "Invalid contact id." });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const transcriptions = await listCallTranscriptionsForContact({
      brokerageId: authedUser.brokerageId,
      partyId,
      actor: { userId: authedUser.id, role: authedUser.role, brokerageId: authedUser.brokerageId },
    });
    res.json({ transcriptions });
  } catch (error) {
    if (error instanceof CallTranscriptionReviewError) {
      res.status(transcriptionReviewErrorStatus(error)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});

growCallsRouter.get("/:id/transcription/:transcriptionId", requireEntitlement("grow.calling.transcription"), async (req, res) => {
  const callSessionId = parseIdParam(req.params.id);
  const transcriptionId = parseIdParam(req.params.transcriptionId);
  if (callSessionId === null || transcriptionId === null) {
    res.status(400).json({ error: "Invalid call session or transcription id." });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const transcription = await getCallTranscriptionForReview({
      brokerageId: authedUser.brokerageId,
      callSessionId,
      transcriptionId,
      actor: { userId: authedUser.id, role: authedUser.role, brokerageId: authedUser.brokerageId },
    });
    res.json({ transcription });
  } catch (error) {
    if (error instanceof CallTranscriptionReviewError) {
      res.status(transcriptionReviewErrorStatus(error)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});

growCallsRouter.post("/:id/transcription/:transcriptionId/review", requireEntitlement("grow.calling.transcription"), async (req, res) => {
  const callSessionId = parseIdParam(req.params.id);
  const transcriptionId = parseIdParam(req.params.transcriptionId);
  if (callSessionId === null || transcriptionId === null) {
    res.status(400).json({ error: "Invalid call session or transcription id." });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const transcription = await saveCallTranscriptionReview({
      brokerageId: authedUser.brokerageId,
      callSessionId,
      transcriptionId,
      actor: { userId: authedUser.id, role: authedUser.role, brokerageId: authedUser.brokerageId },
      body: req.body,
    }, persistApprovedCallSummaryActivity);
    // Part F: explicit Save has atomically committed approval plus one passive
    // Timeline snapshot. Discard and background processing never use this hook.
    res.json({ transcription });
  } catch (error) {
    if (error instanceof CallTranscriptionReviewError) {
      res.status(transcriptionReviewErrorStatus(error)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});

growCallsRouter.post("/:id/transcription/:transcriptionId/discard", requireEntitlement("grow.calling.transcription"), async (req, res) => {
  const callSessionId = parseIdParam(req.params.id);
  const transcriptionId = parseIdParam(req.params.transcriptionId);
  if (callSessionId === null || transcriptionId === null) {
    res.status(400).json({ error: "Invalid call session or transcription id." });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const transcription = await discardCallTranscription({
      brokerageId: authedUser.brokerageId,
      callSessionId,
      transcriptionId,
      actor: { userId: authedUser.id, role: authedUser.role, brokerageId: authedUser.brokerageId },
      body: req.body,
    });
    res.json({ transcription });
  } catch (error) {
    if (error instanceof CallTranscriptionReviewError) {
      res.status(transcriptionReviewErrorStatus(error)).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});

/**
 * Read-only recording presentation for the Contact 360 call panel.  The
 * evaluator is deliberately run against the current session on every read:
 * this means consent withdrawal, policy changes, entitlement changes, and
 * adapter/operational capability are reflected without trusting a client-side
 * copy of the five-gate decision.
 */
growCallsRouter.get("/:id/recording/status", requireEntitlement("grow.calling.access"), async (req, res) => {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid call session id." });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const session = await getCallSessionForBrokerage(authedUser.brokerageId, id, { id: authedUser.id, role: authedUser.role });
    const recording = await currentRecordingPresentation(session, {
      id: authedUser.id,
      role: authedUser.role,
      brokerageId: authedUser.brokerageId,
    });
    res.json({
      callSessionId: session.id,
      recording,
    });
  } catch (err) {
    if (err instanceof GrowCallSessionNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallSessionAuthorizationError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }
});

const createCallSchema = z.object({
  partyId: z.number().int().positive(),
  destinationRaw: z.string().min(1).optional(),
  assumedCountry: z.enum(["AU", "NZ"]).optional(),
  recordingRequested: z.boolean().optional(),
});

growCallsRouter.post("/", requireEntitlement("grow.calling.access"), async (req, res) => {
  const parsed = createCallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const session = await createCallSession({
      brokerageId: authedUser.brokerageId,
      partyId: parsed.data.partyId,
      initiatedByUserId: authedUser.id,
      destinationRaw: parsed.data.destinationRaw ?? null,
      assumedCountry: parsed.data.assumedCountry,
      recordingRequested: parsed.data.recordingRequested ?? false,
    });
    res.status(201).json({ callSession: session });
  } catch (err) {
    if (err instanceof GrowCallSessionValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

growCallsRouter.get("/:id", requireEntitlement("grow.calling.access"), async (req, res) => {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid call session id." });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const session = await getCallSessionForBrokerage(authedUser.brokerageId, id, { id: authedUser.id, role: authedUser.role });
    const recording = await currentRecordingPresentation(session, {
      id: authedUser.id,
      role: authedUser.role,
      brokerageId: authedUser.brokerageId,
    });
    res.json({ callSession: session, recording });
  } catch (err) {
    if (err instanceof GrowCallSessionNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallSessionAuthorizationError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }
});

growCallsRouter.post("/:id/confirm", requireEntitlement("grow.calling.access"), async (req, res) => {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid call session id." });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const session = await confirmCallSession({
      brokerageId: authedUser.brokerageId,
      callSessionId: id,
      confirmedByUserId: authedUser.id,
      confirmedByUserRole: authedUser.role,
    });
    res.json({ callSession: session });
  } catch (err) {
    if (err instanceof GrowCallSessionNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof CallSessionTransitionError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallSessionValidationError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallSessionAuthorizationError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }
});

const cancelCallSchema = z.object({ reason: z.string().max(500).optional() });

growCallsRouter.post("/:id/cancel", requireEntitlement("grow.calling.access"), async (req, res) => {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid call session id." });
    return;
  }
  const parsed = cancelCallSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const session = await cancelCallSession({
      brokerageId: authedUser.brokerageId,
      callSessionId: id,
      cancelledByUserId: authedUser.id,
      cancelledByUserRole: authedUser.role,
      reason: parsed.data.reason ?? null,
    });
    res.json({ callSession: session });
  } catch (err) {
    if (err instanceof GrowCallSessionNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallSessionValidationError || err instanceof CallSessionTransitionError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallSessionAuthorizationError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }
});

const captureConsentSchema = z.object({
  scope: z.enum(["PER_CALL", "STANDING"]),
  source: z.enum(["VERBAL_ON_CALL", "WRITTEN", "ELECTRONIC", "OTHER"]),
  jurisdiction: z.string().max(64).optional(),
  consentVersion: z.string().max(128).optional(),
  expiresAt: z.string().datetime().optional(),
  evidenceMetadata: z.record(z.unknown()).optional(),
});

/** Captures consent associated with an EXISTING call session (either scope). */
growCallsRouter.post("/:id/consent", requireEntitlement("grow.calling.recording"), async (req, res) => {
  const id = parseIdParam(req.params.id);
  if (id === null) {
    res.status(400).json({ error: "Invalid call session id." });
    return;
  }
  const parsed = captureConsentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const session = await getCallSessionForBrokerage(authedUser.brokerageId, id, { id: authedUser.id, role: authedUser.role });
    const consent = await captureRecordingConsent({
      brokerageId: authedUser.brokerageId,
      partyId: session.partyId,
      scope: parsed.data.scope,
      source: parsed.data.source,
      capturedByUserId: authedUser.id,
      jurisdiction: parsed.data.jurisdiction ?? null,
      consentVersion: parsed.data.consentVersion ?? null,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      evidenceMetadata: parsed.data.evidenceMetadata ?? null,
      callSessionId: session.id,
    });
    res.status(201).json({ consent });
  } catch (err) {
    if (err instanceof GrowCallSessionNotFoundError || err instanceof GrowCallConsentNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallConsentValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallSessionAuthorizationError) {
      res.status(403).json({ error: err.message });
      return;
    }
    throw err;
  }
});

const captureStandingConsentSchema = captureConsentSchema.extend({ scope: z.literal("STANDING") });

/** Captures a STANDING consent proactively, independent of any specific call session. */
growCallsRouter.post("/contacts/:partyId/consent", requireEntitlement("grow.calling.recording"), async (req, res) => {
  const partyId = parseIdParam(req.params.partyId);
  if (partyId === null) {
    res.status(400).json({ error: "Invalid contact id." });
    return;
  }
  const parsed = captureStandingConsentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request — only STANDING consent may be captured outside a specific call session.", details: parsed.error.flatten() });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const consent = await captureRecordingConsent({
      brokerageId: authedUser.brokerageId,
      partyId,
      scope: "STANDING",
      source: parsed.data.source,
      capturedByUserId: authedUser.id,
      jurisdiction: parsed.data.jurisdiction ?? null,
      consentVersion: parsed.data.consentVersion ?? null,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
      evidenceMetadata: parsed.data.evidenceMetadata ?? null,
    });
    res.status(201).json({ consent });
  } catch (err) {
    if (err instanceof GrowCallConsentNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallConsentValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

const withdrawConsentSchema = z.object({ reason: z.string().max(500).optional() });

growCallsRouter.post("/consent/:consentId/withdraw", requireEntitlement("grow.calling.recording"), async (req, res) => {
  const consentId = parseIdParam(req.params.consentId);
  if (consentId === null) {
    res.status(400).json({ error: "Invalid consent id." });
    return;
  }
  const parsed = withdrawConsentSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }
  const authedUser = req.authedUser!;
  try {
    const consent = await withdrawRecordingConsent({
      brokerageId: authedUser.brokerageId,
      consentId,
      withdrawnByUserId: authedUser.id,
      withdrawalReason: parsed.data.reason ?? null,
    });
    res.json({ consent });
  } catch (err) {
    if (err instanceof GrowCallConsentNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof GrowCallConsentValidationError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
});
