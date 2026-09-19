// AE GROW Priority 6 Stage E — Voice as Input: the recording lifecycle
// itself, extracted into pure, dependency-injected logic so it can be unit
// tested without a browser, jsdom, or a real microphone (this codebase has
// no React Testing Library / jsdom anywhere — every existing apps/web/src/
// lib/__tests__/*.test.ts file only tests plain exported functions, never
// a mounted component; see this module's own test file for how the
// controller below is exercised with fake MediaRecorder/MediaStream
// objects and a fake clock instead). apps/web/src/components/
// AskAgentEngine.tsx is a thin, mostly-declarative renderer of the state
// this module produces — every decision that could plausibly be gotten
// wrong (is the browser even capable of recording, which MIME type to
// record in, when the 60-second limit has been reached, which state a
// permission/provider/HTTP error maps to, which state transitions are
// even legal) lives here, where it can be proven correct with real tests.
//
// Scope reminder (see the Stage E authorisation): this module only ever
// fills the existing Ask AE / Business Coach question textbox with a
// transcript. It never submits the question itself, never calls
// POST /api/ai/ask, and has no notion of Stage D proposals/approvals at
// all — those remain entirely the caller's concern, unchanged. Voice input
// is always Grow-scoped (there is no non-Grow voice surface — see
// apps/api/src/routes/aiVoice.ts's own header comment), so
// AskAgentEngine.tsx only ever instantiates this controller when
// contextType === "grow".

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// The complete set of UI states the Stage E authorisation requires this
// control to distinguish. Deliberately omits a separate "recording paused"
// state — pause/resume was explicitly optional ("only if intentionally
// supported") and is not implemented in this stage: adding it would also
// complicate the 60-second duration accounting (elapsed *recording* time
// vs. elapsed *wall-clock* time since Start) for a control most agents will
// use for a single short question. Every other required state is present:
// unsupported browser, idle, requesting permission, recording, stopping,
// transcribing, transcript ready, permission denied, no microphone,
// duration limit reached, upload too large, rate limited, provider
// unavailable, transcription failed, cancelled.
export type VoiceRecordingState =
  | "unsupported"
  | "idle"
  | "requesting_permission"
  | "recording"
  | "duration_limit_reached"
  | "stopping"
  | "transcribing"
  | "transcript_ready"
  | "permission_denied"
  | "no_microphone"
  | "upload_too_large"
  | "rate_limited"
  | "provider_unavailable"
  | "transcription_failed"
  | "cancelled";

// Matches apps/api/src/lib/ai/voice/audioValidation.ts's own
// MAX_AUDIO_DURATION_SECONDS exactly. Kept as a separate constant (rather
// than importing across the apps/api / apps/web boundary, which this
// monorepo does not do for app-local code) so both layers document the
// same number independently — this is the client-side half of Stage E's
// layered duration control (client auto-stop here; server byte ceiling +
// provider-reported-duration validation + rejection of over-limit
// transcripts on the API side).
export const MAX_RECORDING_SECONDS = 60;

// ---------------------------------------------------------------------------
// MIME selection
// ---------------------------------------------------------------------------

// Ordered by preference: a widely-supported, small, well-understood format
// first, with a couple of realistic per-browser fallbacks. Every one of
// these is already in the server's ALLOWED_AUDIO_MIME_TYPES allowlist
// (apps/api/src/lib/ai/voice/audioValidation.ts) — this list must never
// grow without that allowlist growing too, since recording in a MIME type
// the server does not accept would otherwise fail 400 only after a full
// recording, which is a strictly worse experience than never recording in
// that format to begin with.
export const MIME_CANDIDATES: readonly string[] = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

// Never assume every browser records the same container/codec — Chrome and
// Firefox default to WebM/Opus, Safari (desktop and iOS) supports neither
// and instead records MP4/AAC. `canRecordMimeType` is injected (rather than
// this function calling `MediaRecorder.isTypeSupported` itself) purely so
// it can be unit tested without a real MediaRecorder implementation; the
// real caller passes a thin wrapper around `MediaRecorder.isTypeSupported`
// (see createBrowserVoiceRecordingDeps below). Returns null (rather than
// throwing) when nothing in the candidate list is supported — the caller
// then lets MediaRecorder pick its own default instead of forcing a
// mimeType option it doesn't support.
export function selectSupportedMimeType(
  canRecordMimeType: (mimeType: string) => boolean,
  candidates: readonly string[] = MIME_CANDIDATES,
): string | null {
  for (const candidate of candidates) {
    if (canRecordMimeType(candidate)) {
      return candidate;
    }
  }
  return null;
}

// The file extension used purely for the multipart filename hint sent to
// the server (the server never trusts a filename/extension alone — see
// audioValidation.ts's detectAudioContainer — this is only so the upload
// looks like a normal file to any logging/debugging tooling in between).
export function extensionForMimeType(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  return "webm";
}

// ---------------------------------------------------------------------------
// Duration
// ---------------------------------------------------------------------------

export function hasReachedDurationLimit(elapsedSeconds: number, maxSeconds: number = MAX_RECORDING_SECONDS): boolean {
  return elapsedSeconds >= maxSeconds;
}

// mm:ss. Never more than two digits of minutes needed at the 60-second
// ceiling this control actually enforces, but formatted generally rather
// than hardcoded to always show "0:" in case maxSeconds is ever raised.
export function formatElapsedTime(elapsedSeconds: number): string {
  const clamped = Math.max(0, Math.floor(elapsedSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

// Every state a completed or abandoned recording/transcription attempt
// settles into, from which a fresh attempt can be started directly (via
// "requesting_permission") or explicitly dismissed back to "idle". Used
// both by ALLOWED_TRANSITIONS below and by the controller's own start()/
// reset() to decide when those calls are legal.
const RESTING_STATES: readonly VoiceRecordingState[] = [
  "idle",
  "transcript_ready",
  "permission_denied",
  "no_microphone",
  "upload_too_large",
  "rate_limited",
  "provider_unavailable",
  "transcription_failed",
  "cancelled",
];

// The legal state transitions, expressed as an adjacency list. Every
// resting state (see RESTING_STATES above) can move straight to
// "requesting_permission" — the agent retrying or asking a fresh voice
// question does not need to pass back through "idle" first — as well as to
// "idle" itself for an explicit dismiss. "unsupported" is permanent for
// the life of the controller (the browser's own capability cannot change
// mid-session); everything else is a single, deliberate, in-flight
// pipeline with a cancel exit at every step, matching the Stage E
// requirement that cancellation must always be available and must never
// upload anything.
export const ALLOWED_TRANSITIONS: Readonly<Record<VoiceRecordingState, readonly VoiceRecordingState[]>> = {
  unsupported: [],
  idle: ["requesting_permission"],
  requesting_permission: ["recording", "permission_denied", "no_microphone", "cancelled", "transcription_failed"],
  // "transcription_failed" is reachable from every in-flight recording state,
  // not only from "transcribing": the MediaRecorder can fail mid-recording
  // (rec.onerror), and a stop can produce a zero-byte blob that must never be
  // uploaded. Without those edges setState() silently refused the transition,
  // so the control stayed on "recording"/"stopping" for good — the agent saw
  // the error text under a spinner that never cleared, with no way back.
  recording: ["stopping", "duration_limit_reached", "cancelled", "transcription_failed"],
  duration_limit_reached: ["stopping"],
  stopping: ["transcribing", "cancelled", "transcription_failed"],
  transcribing: [
    "transcript_ready",
    "upload_too_large",
    "rate_limited",
    "provider_unavailable",
    "transcription_failed",
    "cancelled",
  ],
  transcript_ready: ["idle", "requesting_permission"],
  permission_denied: ["idle", "requesting_permission"],
  no_microphone: ["idle", "requesting_permission"],
  upload_too_large: ["idle", "requesting_permission"],
  rate_limited: ["idle", "requesting_permission"],
  provider_unavailable: ["idle", "requesting_permission"],
  transcription_failed: ["idle", "requesting_permission"],
  cancelled: ["idle", "requesting_permission"],
};

export function canTransition(from: VoiceRecordingState, to: VoiceRecordingState): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

// getUserMedia rejects with a DOMException whose `.name` identifies the
// failure. Mapped narrowly — only the names that mean something
// actionably different to the agent get their own state; anything else (a
// generic NotReadableError from an OS-level device conflict, a
// SecurityError from an insecure context, an AbortError, etc.) falls back
// to transcription_failed with a generic "couldn't access your microphone"
// message, since this control has no more specific, actionable state for
// those.
export function mapGetUserMediaErrorToState(error: unknown): VoiceRecordingState {
  const name =
    error instanceof Error
      ? error.name
      : typeof error === "object" && error !== null && "name" in error
        ? String((error as { name: unknown }).name)
        : undefined;
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") {
    return "permission_denied";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "no_microphone";
  }
  return "transcription_failed";
}

// Maps a POST /api/ai/voice/transcribe response (status + the optional
// server-provided `code`) to a state. Mirrors apps/api/src/routes/
// aiVoice.ts's own status mapping (mapVoiceUploadError /
// mapTranscriptionProviderError) so the two never drift apart — HTTP
// status is the primary signal; `code` only disambiguates the one status
// (400) the server uses for more than one reason, since the different
// 400 reasons here (bad MIME, duration exceeded, etc.) all collapse to the
// same generic "transcription_failed" UI treatment on this client — none
// of them are actionable enough to warrant their own dedicated UI state on
// top of the ones the Stage E authorisation already enumerates.
export function mapServerErrorToState(status: number, code?: string): VoiceRecordingState {
  if (status === 413 || code === "AUDIO_TOO_LARGE") {
    return "upload_too_large";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status === 503 || status === 504 || status === 502) {
    return "provider_unavailable";
  }
  return "transcription_failed";
}

// Default, safe-to-show copy for a state this module reached without a
// more specific server- or browser-supplied message already in hand (a
// getUserMedia rejection, a network-level fetch failure, an empty
// recording). Exported so both the controller and its tests can assert
// against the same source of truth instead of duplicating copy.
export function errorMessageForState(state: VoiceRecordingState): string {
  switch (state) {
    case "permission_denied":
      return "Microphone access was denied. Allow microphone access in your browser to use voice input, or type your question instead.";
    case "no_microphone":
      return "No microphone was found. You can still type your question.";
    case "upload_too_large":
      return "That recording is too large to send. Try a shorter recording.";
    case "rate_limited":
      return "You've reached the voice limit for now. Try again shortly, or type your question instead.";
    case "provider_unavailable":
      return "Voice transcription is temporarily unavailable right now. You can still type your question.";
    default:
      return "Voice transcription failed. You can still type your question.";
  }
}

// ---------------------------------------------------------------------------
// Minimal structural types the controller depends on
// ---------------------------------------------------------------------------
//
// Deliberately narrower than the DOM lib's own MediaStream/MediaRecorder
// types — only the members this module actually calls — so a test's fake
// implementations don't need to satisfy the full, browser-only surface
// (dozens of members this controller never touches). The real browser
// objects already satisfy these structurally; createBrowserVoiceRecordingDeps
// below bridges the two with narrow `as unknown as` casts at the one place
// that matters, rather than this module fighting DOM lib typing throughout.

export interface MinimalMediaStreamTrack {
  stop(): void;
}

export interface MinimalMediaStream {
  getTracks(): MinimalMediaStreamTrack[];
}

export interface MinimalMediaRecorder {
  state: "inactive" | "recording" | "paused";
  start(timeslice?: number): void;
  stop(): void;
  ondataavailable: ((event: { data: Blob }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onstop: (() => void) | null;
}

export type MediaRecorderFactory = (
  stream: MinimalMediaStream,
  options?: { mimeType?: string },
) => MinimalMediaRecorder;

export interface MinimalAbortController {
  signal: unknown;
  abort(): void;
}

export interface MinimalFetchResponse {
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { method: "POST"; body: FormData; credentials: "include"; signal?: unknown },
) => Promise<MinimalFetchResponse>;

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export interface VoiceRecordingControllerDeps {
  // Evaluated once, at controller creation, to decide the initial state
  // ("unsupported" vs "idle"). The browser's own recording capability
  // cannot change mid-session, so this is never re-checked afterwards.
  isSupported: () => boolean;
  getUserMedia: () => Promise<MinimalMediaStream>;
  createRecorder: MediaRecorderFactory;
  canRecordMimeType: (mimeType: string) => boolean;
  fetchImpl: FetchLike;
  now: () => number;
  setIntervalImpl: (handler: () => void, ms: number) => number;
  clearIntervalImpl: (id: number) => void;
  // Optional — when omitted, cancelling mid-upload still moves the UI to
  // "cancelled" immediately (the state guard in upload() below discards
  // the eventual response), it just can't also abort the in-flight network
  // request itself.
  createAbortController?: () => MinimalAbortController;
  transcribeUrl: string;
  mode: "ask" | "coach";
  maxRecordingSeconds?: number;
}

export interface VoiceRecordingCallbacks {
  onStateChange: (state: VoiceRecordingState) => void;
  onElapsedSecondsChange: (elapsedSeconds: number) => void;
  onTranscript: (transcript: string) => void;
  onErrorMessage: (message: string) => void;
}

export interface VoiceRecordingController {
  getState(): VoiceRecordingState;
  // Begins a new attempt from any resting state (see RESTING_STATES) — a
  // no-op while already busy (requesting permission / recording /
  // stopping / transcribing), so a duplicate click can never layer a
  // second recording or upload on top of one already in flight.
  start(): Promise<void>;
  // Ends recording and begins transcription. A no-op unless currently
  // recording.
  stop(): void;
  // Cancels whatever is currently happening — waiting for a permission
  // prompt, recording, or an in-flight upload — and sends nothing. A
  // no-op from any resting state (nothing in flight to cancel).
  cancel(): void;
  // Explicit dismiss from a resting, non-idle state (an error banner's own
  // "Dismiss" control) back to "idle". A no-op from "idle" itself and from
  // any busy state.
  reset(): void;
  // Full cleanup: stops any held microphone track, clears the elapsed-time
  // timer, aborts any in-flight upload, and detaches every MediaRecorder
  // event handler. Must be called on unmount so voice input never leaves
  // the microphone active after the agent navigates away.
  dispose(): void;
}

export function createVoiceRecordingController(
  deps: VoiceRecordingControllerDeps,
  callbacks: VoiceRecordingCallbacks,
): VoiceRecordingController {
  const maxRecordingSeconds = deps.maxRecordingSeconds ?? MAX_RECORDING_SECONDS;

  let state: VoiceRecordingState = deps.isSupported() ? "idle" : "unsupported";
  let stream: MinimalMediaStream | null = null;
  let recorder: MinimalMediaRecorder | null = null;
  let chunks: Blob[] = [];
  let chosenMimeType = "audio/webm";
  let intervalId: number | null = null;
  let startedAtMs = 0;
  let activeAbort: MinimalAbortController | null = null;

  function setState(next: VoiceRecordingState): void {
    if (!canTransition(state, next)) {
      // Defensive only — every internal call site below only ever
      // requests a transition the table above already allows. Refusing
      // (rather than throwing) keeps this safe to call from a
      // MediaRecorder event handler mid-cleanup without risking an
      // unhandled exception inside a browser callback.
      return;
    }
    state = next;
    callbacks.onStateChange(state);
  }

  function releaseStream(): void {
    if (stream !== null) {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Already stopped — nothing further to do.
        }
      }
      stream = null;
    }
  }

  function clearTick(): void {
    if (intervalId !== null) {
      deps.clearIntervalImpl(intervalId);
      intervalId = null;
    }
  }

  function detachRecorderHandlers(): void {
    if (recorder !== null) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
    }
  }

  function tick(): void {
    if (state !== "recording") {
      return;
    }
    const elapsed = Math.floor((deps.now() - startedAtMs) / 1000);
    callbacks.onElapsedSecondsChange(elapsed);
    if (hasReachedDurationLimit(elapsed, maxRecordingSeconds)) {
      clearTick();
      setState("duration_limit_reached");
      beginStop();
    }
  }

  function beginStop(): void {
    setState("stopping");
    if (recorder !== null && recorder.state !== "inactive") {
      recorder.stop();
    } else {
      void handleRecorderStopped();
    }
  }

  async function handleRecorderStopped(): Promise<void> {
    releaseStream();
    if (state !== "stopping") {
      // Reached via cancel() while "stopping" (legal per ALLOWED_TRANSITIONS)
      // — the recording is already discarded, so there is nothing left to
      // upload.
      return;
    }
    const blob = new Blob(chunks, { type: chosenMimeType });
    chunks = [];
    if (blob.size === 0) {
      setState("transcription_failed");
      callbacks.onErrorMessage("No audio was captured. Try again, or type your question instead.");
      return;
    }
    setState("transcribing");
    await upload(blob);
  }

  async function upload(blob: Blob): Promise<void> {
    const abortController = deps.createAbortController ? deps.createAbortController() : null;
    activeAbort = abortController;
    const form = new FormData();
    form.set("audio", blob, `recording.${extensionForMimeType(chosenMimeType)}`);
    form.set("mode", deps.mode);

    let response: MinimalFetchResponse;
    try {
      response = await deps.fetchImpl(deps.transcribeUrl, {
        method: "POST",
        credentials: "include",
        body: form,
        signal: abortController?.signal,
      });
    } catch {
      activeAbort = null;
      if (state !== "transcribing") {
        // cancel() already moved state away (e.g. aborted this exact
        // request) — the resulting rejection is expected, not a real
        // failure to report.
        return;
      }
      setState("transcription_failed");
      callbacks.onErrorMessage(errorMessageForState("transcription_failed"));
      return;
    }
    activeAbort = null;
    if (state !== "transcribing") {
      // Cancelled after the response already resolved but before this
      // continuation ran — discard it rather than surfacing a stale
      // transcript or error for an attempt the agent already cancelled.
      return;
    }

    let body: { transcript?: unknown; error?: unknown; code?: unknown } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // Non-JSON body — fall through to the status-based mapping below.
    }

    if (response.status >= 200 && response.status < 300 && typeof body.transcript === "string") {
      setState("transcript_ready");
      callbacks.onTranscript(body.transcript);
      return;
    }

    const code = typeof body.code === "string" ? body.code : undefined;
    const nextState = mapServerErrorToState(response.status, code);
    setState(nextState);
    callbacks.onErrorMessage(typeof body.error === "string" ? body.error : errorMessageForState(nextState));
  }

  async function start(): Promise<void> {
    if (state === "unsupported" || !RESTING_STATES.includes(state)) {
      // Already busy, or the browser can't record at all — ignore a
      // duplicate/stray Start.
      return;
    }
    setState("requesting_permission");

    let mediaStream: MinimalMediaStream;
    try {
      mediaStream = await deps.getUserMedia();
    } catch (err) {
      if (state !== "requesting_permission") {
        // cancel() already fired while the permission prompt was pending.
        return;
      }
      const nextState = mapGetUserMediaErrorToState(err);
      setState(nextState);
      callbacks.onErrorMessage(errorMessageForState(nextState));
      return;
    }

    if (state !== "requesting_permission") {
      // cancel() fired between the getUserMedia call resolving and this
      // continuation running — the agent no longer wants to record, so
      // release the microphone immediately without ever entering
      // "recording".
      for (const track of mediaStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Already stopped.
        }
      }
      return;
    }

    stream = mediaStream;
    const supportedMimeType = selectSupportedMimeType(deps.canRecordMimeType);
    chosenMimeType = supportedMimeType ?? "audio/webm";

    let rec: MinimalMediaRecorder;
    try {
      rec = deps.createRecorder(mediaStream, supportedMimeType ? { mimeType: supportedMimeType } : undefined);
    } catch {
      releaseStream();
      setState("transcription_failed");
      callbacks.onErrorMessage("Your browser could not start recording. You can still type your question.");
      return;
    }

    recorder = rec;
    chunks = [];
    rec.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    rec.onerror = () => {
      detachRecorderHandlers();
      clearTick();
      releaseStream();
      setState("transcription_failed");
      callbacks.onErrorMessage("Recording failed unexpectedly. You can still type your question.");
    };
    rec.onstop = () => {
      void handleRecorderStopped();
    };

    startedAtMs = deps.now();
    callbacks.onElapsedSecondsChange(0);
    rec.start();
    setState("recording");
    intervalId = deps.setIntervalImpl(tick, 1000);
  }

  function stop(): void {
    if (state !== "recording") {
      return;
    }
    clearTick();
    beginStop();
  }

  function cancel(): void {
    if (state === "requesting_permission") {
      // The pending getUserMedia() promise cannot itself be aborted in
      // most browsers — start()'s own post-await state check is what
      // actually releases the microphone once it resolves.
      setState("cancelled");
      return;
    }
    if (state === "recording") {
      clearTick();
      if (recorder !== null) {
        // Detach onstop first so the normal "finish recording -> upload"
        // path never runs for a cancelled recording — cancellation must
        // send nothing, full stop.
        detachRecorderHandlers();
        if (recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            // Already inactive.
          }
        }
      }
      releaseStream();
      setState("cancelled");
      return;
    }
    if (state === "stopping") {
      // handleRecorderStopped()'s own state !== "stopping" guard discards
      // the recording once onstop eventually fires.
      setState("cancelled");
      return;
    }
    if (state === "transcribing") {
      if (activeAbort !== null) {
        try {
          activeAbort.abort();
        } catch {
          // No-op — already settled.
        }
      }
      setState("cancelled");
      return;
    }
    // idle / any resting or unsupported state: nothing in flight.
  }

  function reset(): void {
    if (state !== "idle" && RESTING_STATES.includes(state)) {
      setState("idle");
    }
  }

  function dispose(): void {
    clearTick();
    if (activeAbort !== null) {
      try {
        activeAbort.abort();
      } catch {
        // No-op.
      }
      activeAbort = null;
    }
    if (recorder !== null) {
      detachRecorderHandlers();
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // No-op.
        }
      }
      recorder = null;
    }
    releaseStream();
    chunks = [];
  }

  return {
    getState: () => state,
    start,
    stop,
    cancel,
    reset,
    dispose,
  };
}

// ---------------------------------------------------------------------------
// Real-browser dependency factory
// ---------------------------------------------------------------------------

export function isBrowserVoiceRecordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.MediaRecorder === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

// The one place this module bridges its own minimal structural types to
// the real DOM lib types — every cast here is narrowing a wider real
// browser object down to the handful of members the controller above
// actually uses, never widening or fabricating capability.
export function createBrowserVoiceRecordingDeps(
  mode: "ask" | "coach",
  maxRecordingSeconds: number = MAX_RECORDING_SECONDS,
): VoiceRecordingControllerDeps {
  return {
    isSupported: isBrowserVoiceRecordingSupported,
    getUserMedia: async () => {
      const realStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      return realStream as unknown as MinimalMediaStream;
    },
    createRecorder: (stream, options) =>
      new MediaRecorder(stream as unknown as MediaStream, options) as unknown as MinimalMediaRecorder,
    canRecordMimeType: (mimeType) =>
      typeof MediaRecorder !== "undefined" && typeof MediaRecorder.isTypeSupported === "function"
        ? MediaRecorder.isTypeSupported(mimeType)
        : false,
    // Double-cast via `unknown` (rather than a direct `as RequestInit`) —
    // this init shape's `signal` is typed as the deliberately opaque
    // `unknown` (see MinimalAbortController above), which is not on its
    // own a valid single-step assertion to DOM lib's `AbortSignal | null`.
    // The real value at runtime is always a genuine AbortSignal (or
    // undefined) from createAbortController below, so this is narrowing
    // back to what it already structurally is, not fabricating capability.
    fetchImpl: (url, init) => fetch(url, init as unknown as RequestInit),
    now: () => Date.now(),
    setIntervalImpl: (handler, ms) => window.setInterval(handler, ms),
    clearIntervalImpl: (id) => window.clearInterval(id),
    createAbortController: () => new AbortController() as unknown as MinimalAbortController,
    transcribeUrl: "/api/ai/voice/transcribe",
    mode,
    maxRecordingSeconds,
  };
}
