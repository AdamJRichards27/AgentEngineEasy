# AE GROW Priority 6 — Stage E: Voice as Input

**Status:** Implementation, security/privacy controls, and automated test coverage are complete. CI has run three times against successive heads and is now green on commit `6c781b7` (see §6). This commit adds the final documentation and the manual, code-level verification (§7); CI must be confirmed green on this commit's own head before the final completion verdict is issued — that check is the last remaining step, tracked separately from this document's own content. **Not merged, not deployed. No live provider credentials configured or activated.**

**Scope:** Voice as Input — an additive way to fill the existing Ask AE / Business Coach question textbox by speaking instead of typing. Voice never submits a question itself, never bypasses the existing "Ask" button, and has no awareness of Stage D's proposal/approval pipeline at all: a voice-produced transcript enters the exact same validated text-question path a typed one does, so every Stage D governance guarantee already shipped is inherited unchanged, not re-implemented.

**Governing instruction:** Project Owner Authorisation, "AE Grow Priority 6 Stage E: Voice as Input," issued after Stage D's merge to `staging`.

**Explicit exclusions for this stage (not built):** telephony/calls, call recording, stored audio of any kind, automatic question submission, a new billing entitlement, a non-Grow voice surface, and any live external transcription call — live activation requires credentials and an explicit approval flag this stage deliberately does not set (§4.1).

**Pull request:** [#38](https://github.com/AdamJRichards27/AgentEngineEasy/pull/38), `feat/ae-grow-priority-6-stage-e-voice-input` → `staging`. Title and body both marked **DO NOT MERGE — PROJECT OWNER REVIEW REQUIRED**. Opened as a draft for CI verification and Project Owner review only.

---

## 1. Entry gate

Branch `feat/ae-grow-priority-6-stage-e-voice-input` was created from the verified `staging` tip, SHA `af50583449cd9fa65a0e4a91d110316d5e0a6765`, confirmed green on `staging` before this stage's first commit. As with every stage in this track, there is no local clone — every change in this report was made as a discrete, reviewed commit through the GitHub API, so there is no uncommitted or stray local state to account for.

Five commits carry this stage's substantive work, in the order the governing instruction required:

1. Provider-neutral transcription interface (`lib/ai/voice/types.ts`, `mockTranscriptionProvider.ts`, `deepgramTranscriptionProvider.ts`, `gateway.ts`, `audioValidation.ts`, `voiceRateLimiter.ts`).
2. `POST /api/ai/voice/transcribe` (`routes/aiVoice.ts`) plus its provider-level and route-level test suites.
3. The web recording lifecycle module (`apps/web/src/lib/voiceRecording.ts`) and the `AskAgentEngine.tsx` mic control, plus the lifecycle module's own test suite.
4. Test hardening (two genuine coverage gaps closed) and CI remediation (two real defects found and fixed under this track's standing FIX → VERIFY → CONTINUE model — see §6).
5. This document.

---

## 2. Architecture: provider abstraction

`apps/api/src/lib/ai/voice/types.ts` defines a small, provider-neutral `TranscriptionProvider` interface (`transcribe(request) -> { provider, transcript, durationSeconds, latencyMs }`), deliberately separate from the existing text-generation `AiProvider` interface (`lib/ai/providers/provider.ts`) rather than sharing one shape between an audio-in/text-out call and a text-in/text-out call. Two implementations exist:

- **`MockTranscriptionProvider`** — the default. Deterministic, offline, makes no network call of any kind. It reflects the audio's own byte length and detected MIME type back inside a fixed, clearly-labelled placeholder sentence ("This is a mock transcription of a `{n}`-byte `{mime}` audio clip. Set `AI_TRANSCRIPTION_PROVIDER=deepgram`...") — it never fabricates plausible-sounding speech, so a transcript on screen can never be mistaken for a real transcription of what the agent actually said while this provider is active.
- **`DeepgramTranscriptionProvider`** — real, but inert unless deliberately activated (§4.1). Calls Deepgram's pre-recorded transcription API directly over `fetch` against a single, hardcoded endpoint, `https://api.au.deepgram.com/v1/listen` — there is no code path in this class, and no environment variable or client input, that can reach any other Deepgram region. `mip_opt_out=true` is set unconditionally on every request, opting the brokerage's audio out of Deepgram's Model Improvement Partnership Program regardless of any account-level default.

`gateway.ts`'s `buildVoiceTranscriptionProvider()` is the single, fail-closed selection point (env-driven: `AI_TRANSCRIPTION_PROVIDER=mock|deepgram`). It deliberately does **not** mirror the existing text-AI gateway's own "missing key → silently fall back to mock" convenience behaviour: selecting `deepgram` without `LIVE_VOICE_TRANSCRIPTION_APPROVED=true` throws a typed `live_provider_disabled` error, and selecting it without `DEEPGRAM_API_KEY` throws `missing_credentials` — both surface to the UI as an honest "voice transcription unavailable" state, never a silent, unlabelled downgrade to a mock transcript. This is the code-level enforcement of the authorisation's explicit "never silently fall back from mock to live" instruction.

---

## 3. API contract: `POST /api/ai/voice/transcribe`

Implemented in `apps/api/src/routes/aiVoice.ts`. The entire client-controllable surface is one multipart request: one audio file, plus an optional `mode: "ask" | "coach"` field. Nothing else is accepted — no role, actor type, brokerage id, user id, authority level, provider, endpoint, or API key can be supplied by the client; every one of those is derived server-side.

**Entitlement gate** — deliberately the same three-part sequence the existing `askCopilot()` applies for the equivalent typed request, in the same order, using the same functions (`isRoleEnabled` → `resolveBrokerageTier`/`isRoleEntitled` → the Grow-specific STARTER gate), so voice access can never diverge from typed access for either Ask AE or the Business Coach. Voice is always Grow-scoped in this build — there is no non-Grow voice surface — so the STARTER gate applies unconditionally here, without `askCopilot()`'s own `isGrowRequest &&` guard (voice has no case where that guard would ever be false).

**Upload validation** (`audioValidation.ts`), applied in order:

| Check | Rule |
|---|---|
| Non-empty | Zero-byte upload → `EMPTY_AUDIO` (400) |
| Size ceiling | > 5 MB → `AUDIO_TOO_LARGE` (413) |
| Declared type allowlisted | Not one of webm/ogg/wav/wave/x-wav/mp4/mpeg/mp3 → `UNSUPPORTED_AUDIO_TYPE` (400) |
| Byte-signature sniff | `detectAudioContainer()` inspects the file's own bytes (EBML header for WebM, `OggS`, RIFF/WAVE, `ftyp`, ID3v2/MPEG frame sync) — a declared type the bytes don't actually match, or bytes matching no known container at all, is rejected, never trusted from the extension or declared Content-Type alone |
| Type/bytes agreement | Declared family ≠ detected family → `AUDIO_TYPE_MISMATCH` (400) |
| Plausible duration (layer 2) | Byte count too large to represent 60 seconds at any realistic encoding → `AUDIO_DURATION_EXCEEDED` (400) |

Duration is enforced in three deliberately layered places, documented as an honest limitation rather than an oversight (this codebase does not add a media-decoding dependency to compute exact playback duration for every browser-produced container before the bytes are sent to a provider): layer 1 is the client's own 60-second auto-stop (§5, never trusted alone); layer 2 is the byte-ceiling check above; layer 3 (`assertProviderReportedDurationWithinLimit`) runs after a successful transcription, using the provider's own reported duration when it supplies one.

**Rate limiting** (`voiceRateLimiter.ts`) — a dedicated limiter, separate from the existing text-request limiter: 20 attempted-or-completed requests per brokerage per hour, 8 per user per hour within that same window (so one user cannot alone consume a brokerage's whole budget), and one in-flight request per user at a time (`VoiceConcurrentRequestError`, 429). Checked before any upload validation or provider call, so even a request that goes on to fail validation still counts.

**Error mapping** — every failure the route or its dependencies can produce resolves to a distinct HTTP status and (where relevant) a machine-readable `code`, matched by `apps/web/src/lib/voiceRecording.ts`'s own `mapServerErrorToState()` on the client:

| Condition | Status | `code` |
|---|---|---|
| Not authenticated | 401 | — |
| Role disabled / tier not entitled / STARTER | 403 | — |
| Upload validation failure (other than size) | 400 | one of `EMPTY_AUDIO` / `UNSUPPORTED_AUDIO_TYPE` / `AUDIO_TYPE_MISMATCH` / `AUDIO_DURATION_EXCEEDED` |
| Upload too large | 413 | `AUDIO_TOO_LARGE` |
| Multer multipart-limit violation | 400 | `AUDIO_UPLOAD_LIMIT` |
| Rate limited / concurrent request | 429 | — |
| No speech detected (empty transcript) | 422 | `empty_transcript` |
| Provider timeout | 504 | `timeout` |
| Live provider not approved / missing credentials | 503 | `live_provider_disabled` / `missing_credentials` |
| Provider error / malformed response / oversized transcript | 502 | `provider_error` / `malformed_response` / `oversized_transcript` |
| Anything unexpected | 500 | — |

A successful response is exactly `{ transcript: string }` — the transcript is trimmed, and truncated to 2000 characters (matching the existing typed-question ceiling) before being returned; `assertTranscriptSizeIsSane` (a 20,000-character sanity ceiling, checked before truncation) rejects an implausibly large provider response outright as `oversized_transcript` rather than silently truncating something that was likely never a real transcript.

The route creates no `aiInteractions` row and never calls `POST /api/ai/ask` itself — its entire effect is the one JSON response.

---

## 4. Security and privacy

- **Audio is memory-only.** `multer.memoryStorage()` holds the upload in a `Buffer` for the lifetime of the request; nothing in this stage writes audio to disk, the database, object storage, or a log line. The buffer is released as soon as the request settles, success or failure (Node's normal garbage collection once `req.file.buffer` goes out of scope at the end of the handler — there is no explicit persistence step to omit).
- **Transcript and other spoken content are never logged.** The only logging calls in `aiVoice.ts` (`voice_transcription_succeeded` / `voice_transcription_route_failed` / `voice_transcription_tier_resolution_failed`) carry privacy-safe operational metadata only: provider name, byte count, duration, latency, a correlation id, brokerage/user ids, and (on failure) the error object's own shape — never `result.transcript` or the audio itself. This is proven, not merely asserted: `deepgramTranscriptionProvider.test.ts`'s "never logs the API key or audio content, on success or failure" test captures every `console.log`/`error`/`warn` call during a failing request and asserts none of them contain the API key or a marker string embedded in the audio bytes.
- **§4.1 — Live activation gates, unchanged and unset.** `AI_TRANSCRIPTION_PROVIDER` defaults to `mock`, and this stage does not change that default anywhere, including in this environment's own `.env.example`. Selecting `deepgram` additionally requires `DEEPGRAM_API_KEY` (never present in this repository, this PR, or any CI config — CI's own test run always uses `mock`) and `LIVE_VOICE_TRANSCRIPTION_APPROVED=true`, which is not set anywhere in this codebase. No Deepgram account was created, no credentials were requested or entered, and no live external network call to any transcription provider has occurred at any point in this stage's development or testing — every automated test that exercises `DeepgramTranscriptionProvider` mocks `global.fetch` itself (see §6.1); nothing in this stage has ever made a real outbound call to `api.au.deepgram.com`.
- **Upload validation is itself a security control**, not only a correctness one — see §3's table. In particular, `detectAudioContainer()` prevents a client from sending non-audio bytes under an audio Content-Type, and the 5 MB / 60-second ceilings bound the cost of every request regardless of what a client claims about its own payload.

---

## 5. Web experience

The recording lifecycle is extracted into `apps/web/src/lib/voiceRecording.ts` — a pure, dependency-injected state machine with no browser, jsdom, or React Testing Library dependency (this codebase has neither), so it is fully unit-testable with fake `MediaRecorder`/`MediaStream`/clock objects. `apps/web/src/components/AskAgentEngine.tsx` is a thin, mostly-declarative renderer of the state this module produces.

**States** (`VoiceRecordingState`): `unsupported`, `idle`, `requesting_permission`, `recording`, `duration_limit_reached`, `stopping`, `transcribing`, `transcript_ready`, `permission_denied`, `no_microphone`, `upload_too_large`, `rate_limited`, `provider_unavailable`, `transcription_failed`, `cancelled`. `ALLOWED_TRANSITIONS` is an explicit adjacency list enforced by every internal `setState()` call (a call outside the table is silently refused rather than throwing, so it stays safe to call from inside a `MediaRecorder` event handler mid-cleanup); every resting state can move directly to `requesting_permission` (retrying a fresh voice question needs no detour through `idle`), and every in-flight state (`requesting_permission` / `recording` / `stopping` / `transcribing`) has a `cancelled` exit that sends nothing.

**Feature detection and MIME selection** — `isBrowserVoiceRecordingSupported()` checks for `window.MediaRecorder` and `navigator.mediaDevices.getUserMedia` before the control ever renders anything but a disabled "Voice input isn't supported in this browser" button; `selectSupportedMimeType()` walks an ordered candidate list (`audio/webm;codecs=opus`, `audio/webm`, `audio/ogg;codecs=opus`, `audio/ogg`, `audio/mp4` — covering Chrome/Firefox/Edge's WebM/Opus default and Safari's MP4/AAC-only reality) via injected `MediaRecorder.isTypeSupported`, falling back to the browser's own default encoding if none of the candidates are supported rather than forcing an unsupported `mimeType` option. Every candidate is already in the server's `ALLOWED_AUDIO_MIME_TYPES` allowlist (§3) by construction — this list cannot grow on one side without the other, since they are documented against each other in both files' own header comments.

**Required states in `AskAgentEngine.tsx`**, all confirmed present by direct code inspection (§7 gives the line-level detail): a disabled "Voice" button with an explanatory `title` when unsupported; a "Requesting microphone access…" spinner with Cancel while the permission prompt is pending; a live "Recording… `m:ss` / `1:00`" readout with Stop and Cancel while recording (and while `duration_limit_reached`, the auto-stop moment, which reuses the same recording UI since the control is already mid-stop by then); "Finishing recording…" / "Transcribing…" spinners with Cancel while stopping/uploading; a dismissible, `role="alert"` error strip for every state in `VOICE_ERROR_STATES` (`permission_denied`, `no_microphone`, `upload_too_large`, `rate_limited`, `provider_unavailable`, `transcription_failed`) carrying the exact copy `errorMessageForState()` defines; and, on success, no dedicated "ready" banner at all — the transcript simply appears in the existing question input, which is the intended, minimal feedback for that state.

**The one hard guarantee this whole module exists to keep**: `onTranscript` — the controller's only success callback — does exactly one thing, `setQuestion(transcript)`. It never calls `ask.mutate`, never touches Stage D state, and the existing "Ask" button remains the only thing that ever submits a question, voice-populated or typed. `handleVoiceMicClick`/`Stop`/`Cancel`/`Dismiss` are the only handlers wired to the mic UI, and none of them submits anything either. The control is rendered only when `isGrow` (voice has no non-Grow surface, matching the server's own always-Grow-scoped gate), covering both plain Ask AE and the Business Coach identically. `dispose()` — called from the component's `useEffect` cleanup — stops any held microphone track, clears the elapsed-time timer, aborts any in-flight upload, and detaches every `MediaRecorder` event handler, so navigating away mid-recording never leaves a microphone active.

---

## 6. CI verification history

CI ran three times against this branch. The first two runs found two genuine, previously-unexercised defects — both fixed under this track's standing FIX → VERIFY → CONTINUE model, neither a change to Stage E's approved scope or boundaries.

### 6.1 Run 1 — typecheck failure (fixed)

`src/lib/ai/voice/__tests__/deepgramTranscriptionProvider.test.ts(47,35): error TS2339: Property 'headers' does not exist on type 'never'` (and the same at `.body`, line 50). Root cause: a bare `let capturedUrl: string | null = null` / `let capturedInit: RequestInit | null = null`, reassigned only inside the mocked `global.fetch` closure, narrows to exactly `null` at any *later* read in the same enclosing function from TypeScript's own control-flow analysis — it does not reason about a closure's side effects at its own, later, asynchronous call site. A plain value read doesn't expose this; a property access does, because `NonNullable<null>` is `never` and `never.headers` is a compile error. Fix: replaced the two bare `let`s with one mutable object (`const captured: { url: string | null; init: RequestInit | null }`), whose properties are not subject to the same narrowing. Every other Stage E test file was checked for the same pattern before considering this fixed; none had it (the superficially similar `resolveGetUserMedia?.()` call pattern in `voiceRecording.test.ts` doesn't trigger it, since TypeScript permits *calling* a `never`-typed value, just not accessing a property on one). Pushed as commit `45c3c23`, byte-verified after push.

### 6.2 Run 2 — API test suite failure (fixed, empirically diagnosed)

16 test failures, almost all in `routes/__tests__/aiVoice.test.ts`, every one an HTTP request that should have reached the route handler instead getting an unintended 400 `AUDIO_UPLOAD_LIMIT` — the generic response `aiVoice.ts`'s own multer-error middleware returns for any `multer.MulterError` other than a file-size violation.

This was not diagnosed by log-reading alone. The route's multer config (`{ files: 1, fields: 1, parts: 2, ... }`) was reproduced directly, in an isolated sandbox outside this repository, using the exact same request-construction pattern `aiVoice.test.ts`'s own `uploadAudio()` helper uses (native `fetch` + `FormData`, a real Express + multer HTTP server) — not a guess based on the error code alone. That reproduction showed:

- Real multer 2.4.0 (the current npm `latest`): the exact `{ files: 1, fields: 1, parts: 2 }` config works correctly for a genuine 1-file + 1-field upload.
- Real multer 2.2.0 and 2.3.0 (both satisfy this package's own declared `"multer": "^2.2.0"` range, and one of them is what this workspace's frozen lockfile resolves to): the identical config throws `LIMIT_PART_COUNT` ("Too many parts") for that same legitimate request — a genuine off-by-one in multer's own `limits.parts` boundary check, which fires once the running part count *reaches* the configured value rather than once it *exceeds* it. The same busboy version (1.6.0) is resolved under every one of these multer versions, so busboy itself is not at fault.
- `parts: 3` and `parts: 4` do not exhibit the bug against either buggy multer version.
- `files: 1` and `fields: 1` were independently confirmed to have no equivalent off-by-one — both still correctly reject a second file or a second field at exactly their configured value, including the specific "no client-supplied override" test case (2 fields + 1 file), which is now confirmed to be rejected by `LIMIT_FIELD_COUNT`, not `LIMIT_PART_COUNT`.

Fix: raised `parts` from 2 to 4 in `aiVoice.ts`, with the reasoning above recorded directly at the call site so a future reader does not re-tighten it without knowing why. Pushed as commit `6c781b7`, byte-verified after push. This is a one-line configuration change to this stage's own new route; it does not touch the pinned dependency version, any other route, or any security boundary.

### 6.3 Run 3 — green

Commit `6c781b7`: **succeeded in 18m 42s.** Every step individually inspected via the Actions UI: Set up job, Initialize containers, Checkout, Install pnpm, Install Node.js, Verify vendored dependencies, Install dependencies (frozen lockfile), Workspace typecheck (29s), Deterministic clean-database migration check (3s), Schema drift check (2s), **API automated test suite (17m 25s, all tests passing)**, API production build, Web production build, Synthetic production startup and storage readiness, and every post-step — all green. The one annotation is an unrelated, pre-existing GitHub Actions platform warning ("Node.js 20 is deprecated" — about the Actions runner's own action shims, e.g. `actions/checkout@v4`, not about this project's own Node 24 runtime, which is unaffected and unchanged by anything in this stage).

---

## 7. Manual verification

A live, running-app-and-database click-through of the mic control is a mandatory pre-pilot gate, consistent with every prior AE GROW Priority 6 stage's own report (Stage D §8 names the same gate for its own UI, still outstanding at that stage's writing) — this environment has no way to run this monorepo's dev server against a live browser and a live microphone, so, as Stage D's own remediation pass did for its UI (Stage D §7), this section is a direct, line-level code inspection proving each required behaviour, not a substitute for that eventual live walkthrough.

| Required property | Code evidence | Finding |
|---|---|---|
| Voice never auto-submits a question | `onTranscript: (transcript) => setQuestion(transcript)` is the controller's entire success callback (`AskAgentEngine.tsx`); no code path from `voiceRecording.ts` calls `ask.mutate` or references the mutation at all. | Confirmed — submission requires the agent to press the pre-existing "Ask" button, unchanged. |
| Voice only ever renders for Grow | Every voice-related JSX block is gated `isGrow && ...`; the controller itself is only constructed inside the `useEffect` when `isGrow` is true, and is set to `null` otherwise. | Confirmed — matches the server's own unconditional STARTER/Grow gate in `aiVoice.ts`. |
| Unsupported browsers get an honest, disabled control | `voiceState === "unsupported"` renders a `disabled`, `aria-disabled="true"` button with an explanatory `title`, computed once from `isBrowserVoiceRecordingSupported()` at controller construction. | Confirmed. |
| Every required UI state is distinguishable | Six mutually exclusive JSX branches cover `unsupported` / `requesting_permission` / (`recording` or `duration_limit_reached`) / (`stopping` or `transcribing`) / every remaining resting state (mic button re-shown) / the `VOICE_ERROR_STATES` error strip — the last `isGrow && ...` condition's negated list explicitly excludes every busy state, so exactly one of these renders for any given `voiceState`. | Confirmed by direct enumeration — no state is unhandled and none double-renders. |
| Cancel always sends nothing | `handleVoiceCancelClick` calls only `voiceControllerRef.current?.cancel()`; `cancel()` (`voiceRecording.ts`) detaches the recorder's `onstop` handler *before* stopping it while `recording`, aborts the in-flight `fetch` via its own `AbortController` while `transcribing`, and in every other in-flight state simply transitions to `cancelled` — there is no branch of `cancel()` that calls `upload()`. | Confirmed. |
| The 60-second ceiling is enforced without agent action | `tick()` (a 1-second interval started in `start()`) calls `hasReachedDurationLimit(elapsed, maxRecordingSeconds)` and, once true, clears the interval and calls `beginStop()` itself — no click is required to stop a recording that hits the limit. | Confirmed — this is layer 1 of the three-layer duration enforcement described in §3. |
| A transcript failure never leaves the mic silently stuck | Every failure branch inside `start()`/`upload()`/the recorder's own `onerror` calls both `setState(...)` to a resting error state and `callbacks.onErrorMessage(...)`, and every one of those states is a member of `RESTING_STATES`, from which `start()` can be called again immediately. | Confirmed — no failure path leaves the controller in a busy state forever. |
| A stray double-click can't layer a second recording or upload | `start()`'s first check is `if (state === "unsupported" || !RESTING_STATES.includes(state)) return;` — a click while already busy is a silent no-op. | Confirmed. |
| Unmounting mid-recording releases the microphone | The owning `useEffect`'s cleanup calls `controller.dispose()`, which stops every held `MediaStreamTrack`, clears the tick interval, aborts any in-flight upload, and detaches every recorder event handler. | Confirmed. |

No defect was found, and no code change resulted from this inspection. The one item this section cannot itself close is the live browser/microphone/network walkthrough — carried forward as a pre-pilot gate in §8, exactly as Stage D carried its own equivalent forward.

---

## 8. Boundaries confirmed, not crossed

- No live provider credentials exist anywhere in this repository, this PR, or CI; `LIVE_VOICE_TRANSCRIPTION_APPROVED` is unset everywhere.
- No Deepgram (or other) provider account was created, and no live external transcription call has been made at any point in this stage's development.
- No new billing entitlement was introduced — voice reuses the existing Grow Ask AE / Business Coach entitlement resolution exactly (§3).
- Stage D's proposal/approval pipeline is untouched: `routes/aiVoice.ts` never creates an `aiActionRequests` row and never calls `POST /api/ai/ask`; a voice transcript reaches Stage D's governance only by the same path a typed question already does, after the agent presses Ask.
- No audio is stored anywhere, at any point, by design (§4) — not on disk, not in the database, not in object storage, not in a log line.
- The PR is a draft, explicitly titled and bodied "DO NOT MERGE — PROJECT OWNER REVIEW REQUIRED," and has not been merged.

---

## 9. Carried-forward and new pre-pilot items

1. **New, this stage:** a live, in-browser microphone walkthrough against a running app and database — recording, stopping, a real transcription round-trip (mock provider), and at least one deliberately-denied microphone permission — remains outstanding as a pre-pilot gate; §7 above is its code-level substitute, not a replacement for it.
2. **New, this stage:** before `AI_TRANSCRIPTION_PROVIDER=deepgram` is ever set in any real environment, `LIVE_VOICE_TRANSCRIPTION_APPROVED=true` and a real `DEEPGRAM_API_KEY` must be deliberately provisioned by the Project Owner — this stage does neither, and this report is not that approval.
3. **Carried forward from Stage D** (unchanged by this stage): Stage B/C/D/E collectively still require a live app-and-database smoke test before pilot release; every brokerage's IANA timezone must be confirmed during provisioning; the in-memory rate limiters (growRateLimiter, and now voiceRateLimiter) must become distributed before horizontal scaling; the product-wide 32px `.btn-small` touch target requires later accessibility review; live property enrichment remains blocked pending Project Owner/legal approval.

These items do not block this stage's own completion and are recorded here only for continuity.
