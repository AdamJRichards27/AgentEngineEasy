import { test } from "node:test";
import assert from "node:assert/strict";
import { DeepgramTranscriptionProvider } from "../deepgramTranscriptionProvider.js";
import { TranscriptionProviderError } from "../types.js";

// Mirrors apps/api/src/lib/ai/__tests__/gateway.test.ts's own convention:
// mock global.fetch entirely (no real network activity from this test
// file), restore it in a finally block after every test.
const ORIGINAL_FETCH = global.fetch;

function restoreFetch(): void {
  global.fetch = ORIGINAL_FETCH;
}

test("deepgram provider calls the fixed AU endpoint, forwards the audio and bearer token, and parses a successful response", async () => {
  // A single mutable record (rather than two separate `let ... = null`
  // variables) captures what the mocked fetch call received. This also
  // sidesteps a real TypeScript control-flow-analysis quirk: a bare
  // `let x: T | null = null` that is only ever reassigned inside a closure
  // narrows to exactly `null` at any read *outside* that closure later in
  // the same enclosing scope, from the compiler's point of view (it does
  // not reason about when — or whether — a closure passed elsewhere is
  // actually invoked) — so a later property access such as `x?.headers`
  // fails to compile with "Property 'headers' does not exist on type
  // 'never'", even though the closure demonstrably runs (via
  // provider.transcribe below, which internally calls the mocked fetch)
  // well before that read. A plain value read (no property access) or a
  // function *call* through the same narrowed-to-null reference does not
  // trigger this, which is why it surfaced only here, at `.headers`/`.body`
  // access, and not for a bare captured URL string elsewhere in this file.
  // An object property is not subject to the same narrowing, so this
  // capture-object pattern is used here instead of two bare `let`s.
  const captured: { url: string | null; init: RequestInit | null } = { url: null, init: null };
  global.fetch = (async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: { channels: [{ alternatives: [{ transcript: "hello world" }] }] },
        metadata: { duration: 3.2 },
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const provider = new DeepgramTranscriptionProvider("secret-key-abc123");
    const audio = Buffer.from("audio-bytes");
    const result = await provider.transcribe({
      audioBytes: audio,
      mimeType: "audio/webm",
      timeoutMs: 5000,
      correlationId: "corr-1",
    });
    assert.equal(result.provider, "deepgram");
    assert.equal(result.transcript, "hello world");
    assert.equal(result.durationSeconds, 3.2);
    assert.equal(typeof result.latencyMs, "number");

    // Fixed-region enforcement: exactly the AU endpoint, every time, with
    // no way for any caller to route this class to a different region.
    assert.equal(captured.url, "https://api.au.deepgram.com/v1/listen?model=nova-2&punctuate=true&mip_opt_out=true");
    const headers = captured.init?.headers as Record<string, string>;
    assert.equal(headers.authorization, "Token secret-key-abc123");
    assert.equal(headers["content-type"], "audio/webm");
    assert.equal(captured.init?.body, audio);
  } finally {
    restoreFetch();
  }
});

test("deepgram provider maps a non-2xx response to a typed provider_error", async () => {
  global.fetch = (async () => ({
    ok: false,
    status: 500,
    text: async () => "internal error",
  })) as unknown as typeof fetch;
  try {
    const provider = new DeepgramTranscriptionProvider("key");
    await assert.rejects(
      () =>
        provider.transcribe({
          audioBytes: Buffer.from("x"),
          mimeType: "audio/webm",
          timeoutMs: 5000,
          correlationId: "c",
        }),
      (err: unknown) => err instanceof TranscriptionProviderError && err.code === "provider_error",
    );
  } finally {
    restoreFetch();
  }
});

test("deepgram provider maps an aborted (timed-out) request to a typed timeout error", async () => {
  global.fetch = ((_url: string, init: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signal.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  }) as unknown as typeof fetch;
  try {
    const provider = new DeepgramTranscriptionProvider("key");
    await assert.rejects(
      () =>
        provider.transcribe({
          audioBytes: Buffer.from("x"),
          mimeType: "audio/webm",
          timeoutMs: 20,
          correlationId: "c",
        }),
      (err: unknown) => err instanceof TranscriptionProviderError && err.code === "timeout",
    );
  } finally {
    restoreFetch();
  }
});

test("deepgram provider maps a non-JSON response body to malformed_response", async () => {
  global.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("not json");
    },
  })) as unknown as typeof fetch;
  try {
    const provider = new DeepgramTranscriptionProvider("key");
    await assert.rejects(
      () =>
        provider.transcribe({
          audioBytes: Buffer.from("x"),
          mimeType: "audio/webm",
          timeoutMs: 5000,
          correlationId: "c",
        }),
      (err: unknown) => err instanceof TranscriptionProviderError && err.code === "malformed_response",
    );
  } finally {
    restoreFetch();
  }
});

test("deepgram provider maps an unrecognised JSON shape (missing transcript field) to malformed_response", async () => {
  global.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ unexpected: "shape" }),
  })) as unknown as typeof fetch;
  try {
    const provider = new DeepgramTranscriptionProvider("key");
    await assert.rejects(
      () =>
        provider.transcribe({
          audioBytes: Buffer.from("x"),
          mimeType: "audio/webm",
          timeoutMs: 5000,
          correlationId: "c",
        }),
      (err: unknown) => err instanceof TranscriptionProviderError && err.code === "malformed_response",
    );
  } finally {
    restoreFetch();
  }
});

test("deepgram provider never logs the API key or audio content, on success or failure", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const logged: string[] = [];
  const capture = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.log = capture;
  console.error = capture;
  console.warn = capture;

  const apiKey = "super-secret-key-xyz";
  const audioMarker = "sensitive-audio-content-should-not-appear-in-logs";
  global.fetch = (async () => ({
    ok: false,
    status: 401,
    text: async () => "unauthorized",
  })) as unknown as typeof fetch;
  try {
    const provider = new DeepgramTranscriptionProvider(apiKey);
    await assert.rejects(() =>
      provider.transcribe({
        audioBytes: Buffer.from(audioMarker),
        mimeType: "audio/webm",
        timeoutMs: 5000,
        correlationId: "c",
      }),
    );
    for (const line of logged) {
      assert.ok(!line.includes(apiKey), `log line unexpectedly contained the API key: ${line}`);
      assert.ok(!line.includes(audioMarker), `log line unexpectedly contained audio content: ${line}`);
    }
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
    restoreFetch();
  }
});
