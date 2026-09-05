// Agent Engine 2.0 — Step 2: Security & Observability Hardening.
//
// Proves the central redaction module actually does what the Step 2 spec
// requires: every field on the authoritative never-log list is stripped
// regardless of nesting depth, a secret-shaped value is caught even under
// an innocuous key name, and the size/depth guards hold so a redaction bug
// can never turn into an unbounded log line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { redactForLog, NEVER_LOG_KEY_PATTERNS } from "../redaction.js";

test("redacts every field on the never-log key list at the top level", () => {
  const input = {
    password: "hunter2",
    passwordHash: "$2b$10$abcdefg",
    secret: "top-secret",
    sessionSecret: "abc123",
    cookie: "session=abc",
    authorization: "Bearer abc.def.ghi",
    accessToken: "tok_live_abc",
    refreshToken: "tok_refresh_abc",
    apiKey: "sk_live_abc",
    privateKey: "-----BEGIN PRIVATE KEY-----abc",
    hmacSecret: "whsec_abc",
    webhookSecret: "whsec_def",
    signature: "sha256=abc",
    cardNumber: "4111111111111111",
    cvv: "123",
    cvc: "123",
    accountNumber: "12345678",
    bsb: "062-000",
    iban: "GB33BUKB20201555555555",
    routingNumber: "021000021",
    ssn: "123-45-6789",
    taxFileNumber: "123456782",
    tfn: "123456782",
    medicareNumber: "2950123451",
    passportNumber: "PA1234567",
    driverLicence: "12345678",
    dateOfBirth: "1990-01-01",
    dob: "1990-01-01",
    documentContent: "base64-pdf-bytes",
    documentBase64: "base64-pdf-bytes",
    signedPdf: "base64-pdf-bytes",
    rawBody: "{\"card\":\"4111\"}",
    rawResponse: "{}",
    requestBody: "{}",
    body: "the actual SMS text",
    messageBody: "the actual message text",
    smsBody: "the actual sms text",
    emailBody: "the actual email text",
  };

  const out = redactForLog(input) as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    assert.equal(out[key], "[REDACTED]", `expected "${key}" to be redacted, got: ${JSON.stringify(out[key])}`);
  }
});

test("redacts never-log keys no matter how deeply nested", () => {
  const input = {
    level1: {
      level2: {
        level3: {
          password: "hunter2",
          safeField: "this is fine",
        },
      },
    },
  };
  const out = redactForLog(input) as any;
  assert.equal(out.level1.level2.level3.password, "[REDACTED]");
  assert.equal(out.level1.level2.level3.safeField, "this is fine");
});

test("redacts never-log keys inside arrays of objects", () => {
  const input = {
    parties: [
      { name: "Alice", ssn: "111-22-3333" },
      { name: "Bob", ssn: "444-55-6666" },
    ],
  };
  const out = redactForLog(input) as any;
  assert.equal(out.parties[0].ssn, "[REDACTED]");
  assert.equal(out.parties[1].ssn, "[REDACTED]");
  assert.equal(out.parties[0].name, "Alice");
});

test("leaves genuinely safe fields untouched", () => {
  const input = {
    correlationId: "11111111-1111-1111-1111-111111111111",
    brokerageId: 42,
    propertyId: 7,
    status: "OPEN",
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const out = redactForLog(input) as any;
  assert.equal(out.correlationId, input.correlationId);
  assert.equal(out.brokerageId, 42);
  assert.equal(out.propertyId, 7);
  assert.equal(out.status, "OPEN");
  assert.equal(out.occurredAt, "2026-01-01T00:00:00.000Z");
});

test("redacts a value that is exactly a Bearer-token-shaped string, even under an unrecognised key name", () => {
  // VALUE_SHAPE_PATTERNS are whole-value matches (the realistic case: a
  // header value or an echoed-back field whose ENTIRE content is the
  // token), not a substring search inside arbitrary prose — a free-text
  // string that merely mentions "Bearer" is covered by the separate
  // "does not redact ordinary prose" test below.
  const input = { errorDetail: "Bearer abcdefghijklmnop.qrstuv" };
  const out = redactForLog(input) as any;
  assert.equal(out.errorDetail, "[REDACTED]");
});

test("does NOT redact ordinary prose that merely mentions the word Bearer without being token-shaped", () => {
  const input = { errorDetail: "upstream rejected the request: Bearer token was missing" };
  const out = redactForLog(input) as any;
  assert.equal(out.errorDetail, input.errorDetail);
});

test("redacts a JWT-shaped value even under an unrecognised key name", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const input = { responseSummary: jwt };
  const out = redactForLog(input) as any;
  assert.equal(out.responseSummary, "[REDACTED]");
});

test("redacts a PEM private key value even under an unrecognised key name", () => {
  const input = { providerDiagnostic: "-----BEGIN RSA PRIVATE KEY-----\nMIIB...==\n-----END RSA PRIVATE KEY-----" };
  const out = redactForLog(input) as any;
  assert.equal(out.providerDiagnostic, "[REDACTED]");
});

test("does not redact an ordinary string that merely mentions a sensitive-sounding word", () => {
  // Guards against over-eager value-shape matching: this string does not
  // match any VALUE_SHAPE_PATTERNS, so it must pass through unredacted —
  // only the exact never-log KEY name should trigger redaction for prose.
  const input = { note: "the customer asked about their password reset flow" };
  const out = redactForLog(input) as any;
  assert.equal(out.note, input.note);
});

test("truncates an overlong string rather than logging it in full", () => {
  const longString = "a".repeat(5000);
  const input = { note: longString };
  const out = redactForLog(input) as any;
  assert.ok((out.note as string).length < 5000);
  assert.ok((out.note as string).endsWith("…[truncated]"));
});

test("caps array length rather than logging an unbounded list", () => {
  const input = { items: Array.from({ length: 100 }, (_, i) => i) };
  const out = redactForLog(input) as any;
  // 20 kept items + one "…N more truncated" marker string.
  assert.equal(out.items.length, 21);
  assert.equal(out.items[20], "…[80 more items truncated]");
});

test("bounds recursion depth on a deeply nested object rather than recursing unboundedly", () => {
  let deep: Record<string, unknown> = { value: "bottom" };
  for (let i = 0; i < 20; i++) {
    deep = { child: deep };
  }
  // Should not throw (e.g. stack overflow) and should terminate with a
  // depth-exceeded marker somewhere in the chain.
  const out = redactForLog(deep);
  const serialised = JSON.stringify(out);
  assert.ok(serialised.includes("[MAX_DEPTH_EXCEEDED]"));
});

test("handles a cyclic-looking (self-referential) object without hanging — guarded by depth, not cycle detection", () => {
  // redactForLog does not do cycle detection; it relies on MAX_DEPTH to
  // bound recursion on any pathological input including a genuine cycle.
  const obj: Record<string, unknown> = { name: "self-referential" };
  obj.self = obj;
  assert.doesNotThrow(() => {
    const out = redactForLog(obj);
    JSON.stringify(out);
  });
});

test("passes through null and non-object primitives unchanged", () => {
  assert.equal(redactForLog(null as unknown as object), null);
  assert.equal(redactForLog(undefined as unknown as object), undefined);
  assert.equal(redactForLog("just a string" as unknown as object), "just a string");
  assert.equal(redactForLog(42 as unknown as object), 42);
});

// AE Step 2 closure — Part C (typed-error-handling audit): a plain
// `new Error(...)`'s `message`/`stack` are non-enumerable own properties,
// so `Object.entries(err)` (and a bare `JSON.stringify(err)`) produce `{}`
// — meaning every `logger.error("...", { error: err })` call site across
// this codebase was silently logging an empty object instead of the actual
// diagnostic detail, until redactValue special-cased Error instances.
test("an Error value logs its name/message/stack, not an empty object", () => {
  const err = new Error("payment provider returned a 502");
  const out = redactForLog({ error: err }) as { error: { name: string; message: string; stack: string } };
  assert.equal(out.error.name, "Error");
  assert.equal(out.error.message, "payment provider returned a 502");
  assert.ok(out.error.stack && out.error.stack.length > 0, "expected a non-empty stack trace");
  assert.notDeepEqual(out.error, {}, "must not regress to logging an empty object for an Error value");
});

test("an Error's own additional enumerable properties (e.g. a typed error's .reason/.type/.status) are preserved alongside name/message/stack", () => {
  const err = Object.assign(new Error("integration lookup failed"), { reason: "TENANT_MISMATCH", status: 404 });
  const out = redactForLog({ error: err }) as { error: { message: string; reason: string; status: number } };
  assert.equal(out.error.message, "integration lookup failed");
  assert.equal(out.error.reason, "TENANT_MISMATCH");
  assert.equal(out.error.status, 404);
});

test("an Error's message embedding (not exactly matching) a secret-shaped value is passed through unredacted — documents the existing whole-string-match limitation of value-shape detection, not a new gap this fix introduces", () => {
  const err = new Error("Bearer sk_live_abcdefghijklmnopqrstuvwxyz leaked into an error message");
  const out = redactForLog({ error: err }) as { error: { message: string } };
  // The whole message string doesn't match the exact Bearer-token shape
  // pattern (it has surrounding text), so this documents the existing,
  // pre-established boundary of value-shape detection (whole-string match,
  // not substring extraction) rather than claiming a stronger guarantee
  // than the redaction layer actually provides for embedded-not-whole
  // secret shapes.
  assert.equal(out.error.message, err.message);
});

test("an Error's message that is ITSELF exactly a secret-shaped value is redacted", () => {
  const err = new Error("Bearer sk_live_abcdefghijklmnopqrstuvwxyz1234567890");
  const out = redactForLog({ error: err }) as { error: { message: string } };
  assert.equal(out.error.message, "[REDACTED]");
});

test("a never-log-named field on an Error instance (e.g. a custom .password property) is still redacted", () => {
  const err = Object.assign(new Error("should never happen"), { password: "hunter2" });
  const out = redactForLog({ error: err }) as { error: { password: string } };
  assert.equal(out.error.password, "[REDACTED]");
});

test("NEVER_LOG_KEY_PATTERNS is non-empty and every pattern is case-insensitive", () => {
  assert.ok(NEVER_LOG_KEY_PATTERNS.length > 0);
  for (const pattern of NEVER_LOG_KEY_PATTERNS) {
    assert.ok(pattern.flags.includes("i"), `pattern ${pattern} should be case-insensitive`);
  }
});

test("never-log key matching is case-insensitive at call sites", () => {
  const input = { PASSWORD: "hunter2", ApiKey: "sk_live_abc" };
  const out = redactForLog(input) as any;
  assert.equal(out.PASSWORD, "[REDACTED]");
  assert.equal(out.ApiKey, "[REDACTED]");
});
