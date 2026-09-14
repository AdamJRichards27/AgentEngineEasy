import { randomUUID } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { logger } from "@aee/events";
import { requireAuth } from "../middlewares/auth.js";
import { isRoleEnabled } from "../lib/ai/featureFlags.js";
import { resolveBrokerageTier, isRoleEntitled } from "../lib/ai/entitlements.js";
import type { AiRole, SubscriptionTier } from "../lib/ai/types.js";
import {
  assertVoiceRateLimit,
  acquireVoiceConcurrencySlot,
  releaseVoiceConcurrencySlot,
  VoiceRateLimitError,
  VoiceConcurrentRequestError,
} from "../lib/ai/voice/voiceRateLimiter.js";
import {
  validateVoiceAudioUpload,
  assertProviderReportedDurationWithinLimit,
  configuredMaxVoiceAudioBytes,
  VoiceUploadValidationError,
  type ValidatedVoiceAudio,
} from "../lib/ai/voice/audioValidation.js";
import { loadVoiceTranscriptionConfig, buildVoiceTranscriptionProvider } from "../lib/ai/voice/gateway.js";
import { assertTranscriptSizeIsSane, TranscriptionProviderError } from "../lib/ai/voice/types.js";
import type { TranscriptionProvider, TranscriptionResponse } from "../lib/ai/voice/types.js";

// AE GROW Priority 6 Stage E — Voice as Input.
//
// POST /api/ai/voice/transcribe: an authenticated multipart upload (one
// audio file, plus an optional `mode` field distinguishing Ask AE from
// Business Coach) in, a transcript string out. This is the ENTIRE surface
// this route exposes — the transcript is handed back to the client to
// populate the existing Ask AE / Business Coach question textbox, exactly
// as if the agent had typed it. This route never calls POST /api/ai/ask
// itself, never persists the audio or the transcript anywhere, and never
// creates a Stage D proposal on its own — every one of those still
// requires the human to review the populated (fully editable) text and
// press the existing Ask/Send button, unchanged from today. Voice is
// additive input only; it does not touch Stage D governance in any way.
//
// Entitlement gate — deliberately the SAME three-part sequence
// lib/ai/orchestrator.ts's askCopilot() applies for the equivalent typed
// request, in the same order and using the same functions
// (isRoleEnabled/resolveBrokerageTier/isRoleEntitled), so voice access can
// never diverge from typed access for either surface: isRoleEnabled(role)
// -> isRoleEntitled(tier, role) -> the Grow-specific STARTER gate (see
// that gate's own comment below for why isRoleEntitled alone does not
// block "copilot" on STARTER). Voice input for either Ask AE or Business
// Coach is always Grow-scoped in this build (there is no non-Grow voice
// surface), so the STARTER gate below applies unconditionally, unlike
// askCopilot()'s own `isGrowRequest &&` guard.
export const aiVoiceRouter = Router();

const voiceUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: configuredMaxVoiceAudioBytes(),
    files: 1,
    fields: 1,
    parts: 2,
    fieldNameSize: 32,
    fieldSize: 256,
    headerPairs: 32,
  },
});

// The ONLY client-controllable field on this route. Everything else it
// needs — the authenticated user, their brokerage, the applicable AI
// role, the resolved subscription tier, the transcription provider, and
// the rate-limit identity — is derived server-side, never accepted from
// the request body or any header, matching routes/ai.ts's own askSchema
// discipline (no client-supplied role/actor/brokerage/provider/endpoint).
const transcribeSchema = z.object({
  mode: z.enum(["ask", "coach"]).optional(),
});

// Matches routes/ai.ts's askSchema.question.max(2000) exactly — a
// transcript this route hands back is destined for that exact textbox, so
// it is truncated to the same ceiling before being returned. This is a
// display-length bound only; assertTranscriptSizeIsSane (voice/types.ts)
// already ran first and would have failed the request outright if the
// provider's raw response was implausibly large in the first place.
const MAX_RETURNED_TRANSCRIPT_LENGTH = 2000;

function mapVoiceUploadError(res: Response, error: VoiceUploadValidationError): void {
  const status = error.code === "AUDIO_TOO_LARGE" ? 413 : 400;
  res.status(status).json({ error: error.message, code: error.code });
}

function mapTranscriptionProviderError(res: Response, error: TranscriptionProviderError): void {
  if (error.code === "empty_transcript") {
    res.status(422).json({
      error: "No speech was detected in that recording. Try again, or type your question instead.",
      code: error.code,
    });
    return;
  }
  const status =
    error.code === "timeout"
      ? 504
      : error.code === "live_provider_disabled" || error.code === "missing_credentials"
        ? 503
        : 502; // provider_error, malformed_response, oversized_transcript
  res.status(status).json({
    error: "Voice transcription is temporarily unavailable right now. You can still type your question.",
    code: error.code,
  });
}

aiVoiceRouter.post("/transcribe", requireAuth, voiceUpload.single("audio"), async (req, res) => {
  const authedUser = req.authedUser;
  if (authedUser === undefined) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const parsed = transcribeSchema.safeParse(req.body);
  if (parsed.success === false) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
    return;
  }

  if (!req.file) {
    res.status(400).json({ error: "An audio file is required" });
    return;
  }

  // Server maps mode -> role, identically to askCopilot() — a client can
  // never send a raw role name (this schema has no such field at all).
  const isCoachRequest = parsed.data.mode === "coach";
  const role: AiRole = isCoachRequest ? "business_coach" : "copilot";

  if (isRoleEnabled(role) === false) {
    res.status(403).json({
      error: isCoachRequest
        ? "The AI Business Coach is currently disabled for this environment."
        : "The AI Copilot is currently disabled for this environment.",
    });
    return;
  }

  let tier: SubscriptionTier;
  try {
    tier = await resolveBrokerageTier(authedUser.brokerageId);
  } catch (err) {
    logger.error("voice_transcription_tier_resolution_failed", { error: err, brokerageId: authedUser.brokerageId });
    res.status(500).json({ error: "Could not verify your plan right now. Try again in a moment." });
    return;
  }

  if (isRoleEntitled(tier, role) === false) {
    res.status(403).json({
      error: `The ${tier} plan does not include ${isCoachRequest ? "the AI Business Coach" : "the AI Copilot"}.`,
    });
    return;
  }

  // Grow-specific gate, mirroring orchestrator.ts's own critical
  // discovery: isRoleEntitled alone does NOT gate "copilot" for STARTER
  // (copilot is entitled on every tier) — only this second, separate
  // check does. Voice is always Grow-scoped in this build, so this
  // applies unconditionally (there is no non-Grow voice surface to
  // exempt), unlike askCopilot()'s own `isGrowRequest &&` guard.
  if (tier === "STARTER") {
    res.status(403).json({ error: "Grow-scoped Ask AE requires a Grow or Pro plan." });
    return;
  }

  // Dedicated voice rate limiter (voiceRateLimiter.ts) — deliberately
  // separate from growRateLimiter.ts's text-request limiter (see that
  // module's own header comment). Checked once per ATTEMPTED request,
  // before any upload validation or provider call, so a request that goes
  // on to fail validation still counts against the window.
  try {
    assertVoiceRateLimit(authedUser.brokerageId, authedUser.id);
  } catch (err) {
    if (err instanceof VoiceRateLimitError) {
      res.status(429).json({ error: err.message });
      return;
    }
    throw err;
  }

  try {
    acquireVoiceConcurrencySlot(authedUser.id);
  } catch (err) {
    if (err instanceof VoiceConcurrentRequestError) {
      res.status(429).json({ error: err.message });
      return;
    }
    throw err;
  }

  // Opaque per-request id for logs only — never audio or transcript
  // content. See voice/types.ts's own TranscriptionRequest.correlationId
  // doc comment.
  const correlationId = randomUUID();
  const startedAt = Date.now();
  try {
    let validated: ValidatedVoiceAudio;
    try {
      validated = validateVoiceAudioUpload(req.file.buffer, req.file.mimetype);
    } catch (err) {
      if (err instanceof VoiceUploadValidationError) {
        mapVoiceUploadError(res, err);
        return;
      }
      throw err;
    }

    const config = loadVoiceTranscriptionConfig();
    let provider: TranscriptionProvider;
    try {
      provider = buildVoiceTranscriptionProvider(config);
    } catch (err) {
      if (err instanceof TranscriptionProviderError) {
        mapTranscriptionProviderError(res, err);
        return;
      }
      throw err;
    }

    let result: TranscriptionResponse;
    try {
      // The MIME type the SERVER detected from the audio's own bytes is
      // what is forwarded to the provider — never the client's declared
      // Content-Type alone (see audioValidation.ts's detectAudioContainer).
      result = await provider.transcribe({
        audioBytes: req.file.buffer,
        mimeType: validated.detectedMimeType,
        timeoutMs: config.timeoutMs,
        correlationId,
      });
    } catch (err) {
      if (err instanceof TranscriptionProviderError) {
        mapTranscriptionProviderError(res, err);
        return;
      }
      throw err;
    }

    try {
      // Layer 3 of audioValidation.ts's duration enforcement, using the
      // provider's own reported duration now that the provider call has
      // actually happened.
      assertProviderReportedDurationWithinLimit(result.durationSeconds);
      assertTranscriptSizeIsSane(result.transcript, result.provider);
    } catch (err) {
      if (err instanceof VoiceUploadValidationError) {
        mapVoiceUploadError(res, err);
        return;
      }
      if (err instanceof TranscriptionProviderError) {
        mapTranscriptionProviderError(res, err);
        return;
      }
      throw err;
    }

    const trimmedTranscript = result.transcript.trim();
    if (trimmedTranscript.length === 0) {
      res.status(422).json({ error: "No speech was detected in that recording. Try again, or type your question instead." });
      return;
    }
    const transcript = trimmedTranscript.slice(0, MAX_RETURNED_TRANSCRIPT_LENGTH);

    // Privacy-safe operational metadata only — provider name, byte count,
    // duration, latency, a correlation id, brokerage/user ids. Never the
    // transcript itself, never the audio, never any other spoken content.
    logger.info("voice_transcription_succeeded", {
      provider: result.provider,
      correlationId,
      brokerageId: authedUser.brokerageId,
      userId: authedUser.id,
      byteCount: req.file.buffer.length,
      durationSeconds: result.durationSeconds,
      latencyMs: Date.now() - startedAt,
    });

    // This response is the entire effect of this request: no aiInteractions
    // row, no domain-object write, and no internal call to askCopilot()/
    // POST /api/ai/ask — the transcript still has to pass through the
    // existing text-question path (and the human pressing Ask/Send) like
    // any typed question.
    res.json({ transcript });
  } catch (err) {
    logger.error("voice_transcription_route_failed", {
      error: err,
      correlationId,
      brokerageId: authedUser.brokerageId,
      userId: authedUser.id,
    });
    res.status(500).json({ error: "Voice transcription failed. You can still type your question." });
  } finally {
    releaseVoiceConcurrencySlot(authedUser.id);
  }
});

aiVoiceRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    const isFileSize = error.code === "LIMIT_FILE_SIZE";
    res.status(isFileSize ? 413 : 400).json(
      isFileSize
        ? { error: "Audio exceeds the configured size limit", code: "AUDIO_TOO_LARGE" }
        : { error: "Audio upload exceeds the configured multipart limits", code: "AUDIO_UPLOAD_LIMIT" },
    );
    return;
  }
  next(error);
});
