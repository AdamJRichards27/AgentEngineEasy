// AE GROW Priority 6 Stage E — unit coverage for the voice recording
// lifecycle (apps/web/src/lib/voiceRecording.ts). Tests only the exported,
// state-independent logic (see that module's own header comment for why —
// this codebase has no React Testing Library / jsdom anywhere, matching
// every other apps/web/src/lib/__tests__/*.test.ts file). MediaRecorder and
// MediaStream are faked below rather than imported from any browser
// environment; a fake clock replaces setInterval/Date.now so nothing here
// actually sleeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RECORDING_SECONDS,
  MIME_CANDIDATES,
  selectSupportedMimeType,
  extensionForMimeType,
  hasReachedDurationLimit,
  formatElapsedTime,
  ALLOWED_TRANSITIONS,
  canTransition,
  mapGetUserMediaErrorToState,
  mapServerErrorToState,
  errorMessageForState,
  createVoiceRecordingController,
  type VoiceRecordingState,
  type VoiceRecordingControllerDeps,
  type MinimalMediaStream,
  type MinimalMediaRecorder,
  type MinimalFetchResponse,
} from "../voiceRecording";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("selectSupportedMimeType returns the first candidate the browser supports, in preference order", () => {
  const supported = new Set(["audio/ogg", "audio/mp4"]);
  const result = selectSupportedMimeType((m) => supported.has(m));
  assert.equal(result, "audio/ogg");
});

test("selectSupportedMimeType returns null when nothing in the candidate list is supported", () => {
  const result = selectSupportedMimeType(() => false);
  assert.equal(result, null);
});

test("selectSupportedMimeType respects a custom candidate list", () => {
  const result = selectSupportedMimeType((m) => m === "audio/mp4", ["audio/mp4", "audio/webm"]);
  assert.equal(result, "audio/mp4");
});

test("MIME_CANDIDATES are every one within the server's own allowlisted families (webm/ogg/mp4)", () => {
  for (const candidate of MIME_CANDIDATES) {
    const extension = extensionForMimeType(candidate);
    assert.ok(["webm", "ogg", "mp4"].includes(extension), `unexpected extension ${extension} for ${candidate}`);
  }
});

test("extensionForMimeType recognises every real-world family and falls back sanely", () => {
  assert.equal(extensionForMimeType("audio/webm;codecs=opus"), "webm");
  assert.equal(extensionForMimeType("audio/ogg;codecs=opus"), "ogg");
  assert.equal(extensionForMimeType("audio/mp4"), "mp4");
  assert.equal(extensionForMimeType("audio/wav"), "wav");
  assert.equal(extensionForMimeType("audio/mpeg"), "mp3");
  assert.equal(extensionForMimeType("audio/mp3"), "mp3");
  assert.equal(extensionForMimeType("audio/x-totally-unknown"), "webm");
});

test("hasReachedDurationLimit is true at exactly the ceiling and false one second before it", () => {
  assert.equal(hasReachedDurationLimit(60, 60), true);
  assert.equal(hasReachedDurationLimit(59, 60), false);
  assert.equal(hasReachedDurationLimit(61, 60), true);
  assert.equal(hasReachedDurationLimit(0, MAX_RECORDING_SECONDS), false);
});

test("formatElapsedTime formats mm:ss and clamps negative input to zero", () => {
  assert.equal(formatElapsedTime(0), "0:00");
  assert.equal(formatElapsedTime(5), "0:05");
  assert.equal(formatElapsedTime(65), "1:05");
  assert.equal(formatElapsedTime(-3), "0:00");
  assert.equal(formatElapsedTime(59.9), "0:59");
});

test("mapGetUserMediaErrorToState maps permission and device errors, and falls back safely for anything else", () => {
  assert.equal(mapGetUserMediaErrorToState({ name: "NotAllowedError" }), "permission_denied");
  assert.equal(mapGetUserMediaErrorToState({ name: "PermissionDeniedError" }), "permission_denied");
  assert.equal(mapGetUserMediaErrorToState({ name: "SecurityError" }), "permission_denied");
  assert.equal(mapGetUserMediaErrorToState({ name: "NotFoundError" }), "no_microphone");
  assert.equal(mapGetUserMediaErrorToState({ name: "DevicesNotFoundError" }), "no_microphone");
  assert.equal(mapGetUserMediaErrorToState({ name: "NotReadableError" }), "transcription_failed");
  assert.equal(mapGetUserMediaErrorToState(new Error("boom")), "transcription_failed");
  assert.equal(mapGetUserMediaErrorToState("not even an object"), "transcription_failed");
  assert.equal(mapGetUserMediaErrorToState(undefined), "transcription_failed");
});

test("mapServerErrorToState mirrors aiVoice.ts's own status/code mapping", () => {
  assert.equal(mapServerErrorToState(413), "upload_too_large");
  assert.equal(mapServerErrorToState(400, "AUDIO_TOO_LARGE"), "upload_too_large");
  assert.equal(mapServerErrorToState(429), "rate_limited");
  assert.equal(mapServerErrorToState(503), "provider_unavailable");
  assert.equal(mapServerErrorToState(504), "provider_unavailable");
  assert.equal(mapServerErrorToState(502), "provider_unavailable");
  assert.equal(mapServerErrorToState(400, "UNSUPPORTED_AUDIO_TYPE"), "transcription_failed");
  assert.equal(mapServerErrorToState(422), "transcription_failed");
  assert.equal(mapServerErrorToState(500), "transcription_failed");
  assert.equal(mapServerErrorToState(401), "transcription_failed");
});

test("errorMessageForState returns non-empty, distinct copy for every mapped error state", () => {
  const states: VoiceRecordingState[] = [
    "permission_denied",
    "no_microphone",
    "upload_too_large",
    "rate_limited",
    "provider_unavailable",
    "transcription_failed",
  ];
  const messages = new Set<string>();
  for (const s of states) {
    const message = errorMessageForState(s);
    assert.ok(message.length > 0);
    messages.add(message);
  }
  assert.equal(messages.size, states.length, "every state should have its own distinct message");
});

// ---------------------------------------------------------------------------
// State machine table
// ---------------------------------------------------------------------------

test("ALLOWED_TRANSITIONS: unsupported is permanent — no outgoing transitions", () => {
  assert.deepEqual(ALLOWED_TRANSITIONS.unsupported, []);
  assert.equal(canTransition("unsupported", "idle"), false);
  assert.equal(canTransition("unsupported", "requesting_permission"), false);
});

test("ALLOWED_TRANSITIONS: every resting state except idle can reach both idle and requesting_permission directly", () => {
  const restingExceptIdle: VoiceRecordingState[] = [
    "transcript_ready",
    "permission_denied",
    "no_microphone",
    "upload_too_large",
    "rate_limited",
    "provider_unavailable",
    "transcription_failed",
    "cancelled",
  ];
  for (const s of restingExceptIdle) {
    assert.equal(canTransition(s, "idle"), true, `${s} -> idle should be legal`);
    assert.equal(canTransition(s, "requesting_permission"), true, `${s} -> requesting_permission should be legal`);
  }
});

test("ALLOWED_TRANSITIONS: recording cannot jump straight to transcript_ready or transcribing, only through stopping", () => {
  assert.equal(canTransition("recording", "transcript_ready"), false);
  assert.equal(canTransition("recording", "transcribing"), false);
  assert.equal(canTransition("recording", "stopping"), true);
  assert.equal(canTransition("recording", "duration_limit_reached"), true);
  assert.equal(canTransition("recording", "cancelled"), true);
});

test("ALLOWED_TRANSITIONS: duration_limit_reached only ever leads to stopping", () => {
  assert.deepEqual(ALLOWED_TRANSITIONS.duration_limit_reached, ["stopping"]);
});

test("ALLOWED_TRANSITIONS: every error/terminal state this module can reach from transcribing is reachable", () => {
  const reachable = ALLOWED_TRANSITIONS.transcribing;
  for (const expected of ["transcript_ready", "upload_too_large", "rate_limited", "provider_unavailable", "transcription_failed", "cancelled"]) {
    assert.ok(reachable.includes(expected as VoiceRecordingState), `transcribing should be able to reach ${expected}`);
  }
});

// ---------------------------------------------------------------------------
// Controller — fakes
// ---------------------------------------------------------------------------

class FakeTrack {
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeMediaStream implements MinimalMediaStream {
  tracks: FakeTrack[];
  constructor(trackCount = 1) {
    this.tracks = Array.from({ length: trackCount }, () => new FakeTrack());
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

interface FakeMediaRecorderOptions {
  // When true, the fake's stop() fires ondataavailable with a zero-byte
  // Blob (simulating a recording that captured no actual audio data).
  emitEmptyData?: boolean;
}

class FakeMediaRecorder implements MinimalMediaRecorder {
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onstop: (() => void) | null = null;
  stopCallCount = 0;
  startCallCount = 0;
  constructor(
    public mimeType: string | undefined,
    private fakeOptions: FakeMediaRecorderOptions = {},
  ) {}
  start(): void {
    this.startCallCount += 1;
    this.state = "recording";
  }
  stop(): void {
    this.stopCallCount += 1;
    this.state = "inactive";
    if (this.ondataavailable) {
      const bytes = this.fakeOptions.emitEmptyData ? [] : ["fake-audio-bytes"];
      this.ondataavailable({ data: new Blob(bytes, { type: this.mimeType ?? "audio/webm" }) });
    }
    if (this.onstop) {
      this.onstop();
    }
  }
}

function makeFakeClock() {
  let currentMs = 0;
  const handlers = new Map<number, () => void>();
  let nextId = 1;
  return {
    now: () => currentMs,
    advanceMs(ms: number) {
      currentMs += ms;
    },
    setIntervalImpl: (handler: () => void): number => {
      const id = nextId++;
      handlers.set(id, handler);
      return id;
    },
    clearIntervalImpl: (id: number): void => {
      handlers.delete(id);
    },
    // Fires every registered interval handler once — the test's stand-in
    // for "one second of real time passing".
    fireAllIntervals(): void {
      for (const handler of Array.from(handlers.values())) {
        handler();
      }
    },
    activeIntervalCount(): number {
      return handlers.size;
    },
  };
}

interface TestHarnessOptions {
  recorderOptions?: FakeMediaRecorderOptions;
  canRecordMimeType?: (mimeType: string) => boolean;
  fetchImpl?: VoiceRecordingControllerDeps["fetchImpl"];
  getUserMediaImpl?: () => Promise<MinimalMediaStream>;
  createRecorderThrows?: boolean;
  isSupported?: boolean;
  maxRecordingSeconds?: number;
  mode?: "ask" | "coach";
}

function makeTestHarness(options: TestHarnessOptions = {}) {
  const clock = makeFakeClock();
  const streams: FakeMediaStream[] = [];
  const recorders: FakeMediaRecorder[] = [];
  let getUserMediaCallCount = 0;
  let createRecorderCallCount = 0;
  const abortCalls: boolean[] = [];

  const deps: VoiceRecordingControllerDeps = {
    isSupported: () => options.isSupported ?? true,
    getUserMedia:
      options.getUserMediaImpl ??
      (async () => {
        getUserMediaCallCount += 1;
        const s = new FakeMediaStream();
        streams.push(s);
        return s;
      }),
    createRecorder: (_stream, recOptions) => {
      createRecorderCallCount += 1;
      if (options.createRecorderThrows) {
        throw new Error("construction failed");
      }
      const rec = new FakeMediaRecorder(recOptions?.mimeType, options.recorderOptions);
      recorders.push(rec);
      return rec;
    },
    canRecordMimeType: options.canRecordMimeType ?? ((m) => m === "audio/webm;codecs=opus"),
    fetchImpl:
      options.fetchImpl ??
      (async (): Promise<MinimalFetchResponse> => ({
        status: 200,
        json: async () => ({ transcript: "hello from the mock transcript" }),
      })),
    now: clock.now,
    setIntervalImpl: clock.setIntervalImpl,
    clearIntervalImpl: clock.clearIntervalImpl,
    createAbortController: () => ({
      signal: {},
      abort: () => {
        abortCalls.push(true);
      },
    }),
    transcribeUrl: "/api/ai/voice/transcribe",
    mode: options.mode ?? "ask",
    maxRecordingSeconds: options.maxRecordingSeconds ?? 60,
  };

  return {
    deps,
    clock,
    streams,
    recorders,
    abortCalls,
    getGetUserMediaCallCount: () => getUserMediaCallCount,
    getCreateRecorderCallCount: () => createRecorderCallCount,
  };
}

function makeSpyCallbacks() {
  const states: VoiceRecordingState[] = [];
  const elapsed: number[] = [];
  const transcripts: string[] = [];
  const errors: string[] = [];
  return {
    callbacks: {
      onStateChange: (s: VoiceRecordingState) => states.push(s),
      onElapsedSecondsChange: (n: number) => elapsed.push(n),
      onTranscript: (t: string) => transcripts.push(t),
      onErrorMessage: (m: string) => errors.push(m),
    },
    states,
    elapsed,
    transcripts,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Controller — behaviour
// ---------------------------------------------------------------------------

test("controller starts in unsupported when the browser cannot record, and start() is then a permanent no-op", async () => {
  const harness = makeTestHarness({ isSupported: false });
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);
  assert.equal(controller.getState(), "unsupported");
  await controller.start();
  assert.equal(controller.getState(), "unsupported");
  assert.equal(harness.getGetUserMediaCallCount(), 0);
  assert.deepEqual(spy.states, []);
});

test("controller starts in idle when the browser can record", () => {
  const harness = makeTestHarness();
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);
  assert.equal(controller.getState(), "idle");
});

test("happy path: start -> recording -> stop -> transcribing -> transcript_ready, releasing the microphone as soon as recording stops", async () => {
  const harness = makeTestHarness();
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);

  await controller.start();
  assert.equal(controller.getState(), "recording");
  assert.equal(harness.getGetUserMediaCallCount(), 1);
  assert.equal(harness.recorders[0].startCallCount, 1);

  controller.stop();
  // The microphone must be released the moment recording stops, not only
  // once transcription later succeeds or fails.
  assert.ok(harness.streams[0].tracks.every((t) => t.stopped));

  // Allow the queued microtasks (recorder.onstop -> handleRecorderStopped
  // -> upload -> fetchImpl) to settle.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(controller.getState(), "transcript_ready");
  assert.deepEqual(spy.transcripts, ["hello from the mock transcript"]);
  assert.deepEqual(spy.states, ["requesting_permission", "recording", "stopping", "transcribing", "transcript_ready"]);
});

test("permission denied: getUserMedia rejecting with NotAllowedError moves to permission_denied with the expected message", async () => {
  const harness = makeTestHarness({
    getUserMediaImpl: async () => {
      const err = new Error("denied");
      err.name = "NotAllowedError";
      throw err;
    },
  });
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);
  await controller.start();
  assert.equal(controller.getState(), "permission_denied");
  assert.equal(spy.errors.length, 1);
  assert.match(spy.errors[0], /denied/i);
});

test("no microphone: getUserMedia rejecting with NotFoundError moves to no_microphone", async () => {
  const harness = makeTestHarness({
    getUserMediaImpl: async () => {
      const err = new Error("no device");
      err.name = "NotFoundError";
      throw err;
    },
  });
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);
  await controller.start();
  assert.equal(controller.getState(), "no_microphone");
});

test("recorder construction failure releases the microphone and reports transcription_failed", async () => {
  const harness = makeTestHarness({ createRecorderThrows: true });
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);
  await controller.start();
  assert.equal(controller.getState(), "transcription_failed");
  assert.ok(harness.streams[0].tracks.every((t) => t.stopped));
});

test("cancel during recording sends nothing: fetchImpl is never called and the microphone is released", async () => {
  let fetchCallCount = 0;
  const harness = makeTestHarness({
    fetchImpl: async () => {
      fetchCallCount += 1;
      return { status: 200, json: async () => ({ transcript: "should never be seen" }) };
    },
  });
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);

  await controller.start();
  assert.equal(controller.getState(), "recording");
  controller.cancel();

  assert.equal(controller.getState(), "cancelled");
  assert.ok(harness.streams[0].tracks.every((t) => t.stopped));

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(fetchCallCount, 0, "cancellation must never upload the recording");
  assert.equal(controller.getState(), "cancelled");
});

test("cancel while waiting for the permission prompt releases the stream once getUserMedia eventually resolves, without ever recording", async () => {
  let resolveGetUserMedia: ((stream: MinimalMediaStream) => void) | null = null;
  const pendingStream = new FakeMediaStream();
  const harness = makeTestHarness({
    getUserMediaImpl: () =>
      new Promise<MinimalMediaStream>((resolve) => {
        resolveGetUserMedia = resolve;
      }),
  });
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);

  const startPromise = controller.start();
  assert.equal(controller.getState(), "requesting_permission");
  controller.cancel();
  assert.equal(controller.getState(), "cancelled");

  resolveGetUserMedia?.(pendingStream);
  await startPromise;

  assert.equal(controller.getState(), "cancelled", "a late-resolving permission grant must not override an explicit cancel");
  assert.ok(pendingStream.getTracks().every((t) => (t as FakeTrack).stopped), "the now-unwanted stream must be released immediately");
  assert.equal(harness.getCreateRecorderCallCount(), 0, "recording must never start after a cancel");
});

test("cancel during transcribing aborts the in-flight request and never processes its eventual response", async () => {
  let resolveFetch: ((value: MinimalFetchResponse) => void) | null = null;
  const harness = makeTestHarness({
    fetchImpl: () =>
      new Promise<MinimalFetchResponse>((resolve) => {
        resolveFetch = resolve;
      }),
  });
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);

  await controller.start();
  controller.stop();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.getState(), "transcribing");

  controller.cancel();
  assert.equal(controller.getState(), "cancelled");
  assert.equal(harness.abortCalls.length, 1, "cancelling mid-upload must abort the underlying request");

  // The request resolves anyway (a real AbortController would instead
  // reject, but a stale success must be just as safely discarded).
  resolveFetch?.({ status: 200, json: async () => ({ transcript: "stale, must be ignored" }) });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(controller.getState(), "cancelled");
  assert.deepEqual(spy.transcripts, [], "a transcript that arrives after cancellation must never populate anything");
});

test("duration limit: reaching the configured ceiling auto-stops and uploads without a manual stop() call", async () => {
  const harness = makeTestHarness({ maxRecordingSeconds: 3 });
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);

  await controller.start();
  for (let second = 1; second <= 3; second++) {
    harness.clock.advanceMs(1000);
    harness.clock.fireAllIntervals();
  }

  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.recorders[0].stopCallCount, 1, "the recorder must be stopped automatically exactly once");
  assert.equal(controller.getState(), "transcript_ready");
  assert.ok(spy.states.includes("duration_limit_reached"));
  assert.ok(spy.states.indexOf("duration_limit_reached") < spy.states.indexOf("stopping"));
});

test("an empty recording (zero-byte blob) is reported as a failure and never uploaded", async () => {
  let fetchCallCount = 0;
  const harness = makeTestHarness({
    recorderOptions: { emitEmptyData: true },
    fetchImpl: async () => {
      fetchCallCount += 1;
      return { status: 200, json: async () => ({ transcript: "unused" }) };
    },
  });
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);

  await controller.start();
  controller.stop();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(controller.getState(), "transcription_failed");
  assert.equal(fetchCallCount, 0);
  assert.match(spy.errors[spy.errors.length - 1], /no audio was captured/i);
});

test("server error mapping end to end: a 429 response moves the controller to rate_limited using the server's own message", async () => {
  const harness = makeTestHarness({
    fetchImpl: async () => ({ status: 429, json: async () => ({ error: "Too many voice requests. Try again in a few minutes." }) }),
  });
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);

  await controller.start();
  controller.stop();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(controller.getState(), "rate_limited");
  assert.equal(spy.errors[spy.errors.length - 1], "Too many voice requests. Try again in a few minutes.");
});

test("a response with an unparseable body still resolves to a safe, generic error state instead of throwing", async () => {
  const harness = makeTestHarness({
    fetchImpl: async () => ({
      status: 502,
      json: async () => {
        throw new Error("not json");
      },
    }),
  });
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);

  await controller.start();
  controller.stop();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(controller.getState(), "provider_unavailable");
  assert.equal(spy.errors[spy.errors.length - 1], errorMessageForState("provider_unavailable"));
});

test("a network-level fetch failure (not just a non-2xx response) is reported as transcription_failed, not thrown", async () => {
  const harness = makeTestHarness({
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);

  await controller.start();
  controller.stop();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(controller.getState(), "transcription_failed");
});

test("duplicate start() calls while already recording are ignored — the microphone is only requested once", async () => {
  const harness = makeTestHarness();
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);

  await controller.start();
  assert.equal(controller.getState(), "recording");
  await controller.start();

  assert.equal(harness.getGetUserMediaCallCount(), 1);
  assert.equal(controller.getState(), "recording");
});

test("stop() is a no-op outside the recording state", async () => {
  const harness = makeTestHarness();
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);
  controller.stop();
  assert.equal(controller.getState(), "idle");
});

test("reset() clears an error/resting state back to idle, and is a no-op from idle or a busy state", async () => {
  const harness = makeTestHarness({
    getUserMediaImpl: async () => {
      const err = new Error("denied");
      err.name = "NotAllowedError";
      throw err;
    },
  });
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);

  await controller.start();
  assert.equal(controller.getState(), "permission_denied");
  controller.reset();
  assert.equal(controller.getState(), "idle");

  // No-op from idle itself.
  controller.reset();
  assert.equal(controller.getState(), "idle");
});

test("reset() does not interrupt an in-flight recording", async () => {
  const harness = makeTestHarness();
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);
  await controller.start();
  controller.reset();
  assert.equal(controller.getState(), "recording", "reset() must never cancel an active recording");
});

test("dispose() during an active recording releases the microphone and stops the elapsed-time timer", async () => {
  const harness = makeTestHarness();
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);

  await controller.start();
  assert.equal(harness.clock.activeIntervalCount(), 1);

  controller.dispose();

  assert.ok(harness.streams[0].tracks.every((t) => t.stopped));
  assert.equal(harness.clock.activeIntervalCount(), 0);

  const elapsedCallsBeforeTick = spy.elapsed.length;
  harness.clock.fireAllIntervals();
  assert.equal(spy.elapsed.length, elapsedCallsBeforeTick, "no further ticks should fire once disposed");
});

test("dispose() aborts an in-flight upload", async () => {
  const harness = makeTestHarness({
    fetchImpl: () => new Promise<MinimalFetchResponse>(() => {}),
  });
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);

  await controller.start();
  controller.stop();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(controller.getState(), "transcribing");

  controller.dispose();
  assert.equal(harness.abortCalls.length, 1);
});

test("dispose() is safe to call from idle (e.g. an unmount that never recorded anything)", () => {
  const harness = makeTestHarness();
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);
  assert.doesNotThrow(() => controller.dispose());
});

test("the mode passed to createVoiceRecordingController is sent as the multipart 'mode' field", async () => {
  let capturedForm: FormData | null = null;
  const harness = makeTestHarness({
    mode: "coach",
    fetchImpl: async (_url, init) => {
      capturedForm = init.body;
      return { status: 200, json: async () => ({ transcript: "coach mode transcript" }) };
    },
  });
  const spy = makeSpyCallbacks();
  const controller = createVoiceRecordingController(harness.deps, spy.callbacks);

  await controller.start();
  controller.stop();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(capturedForm !== null);
  assert.equal((capturedForm as FormData).get("mode"), "coach");
  assert.ok((capturedForm as FormData).get("audio") instanceof Blob);
});
