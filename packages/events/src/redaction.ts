// Agent Engine 2.0 — Step 2: Security & Observability Hardening.
//
// Central redaction for anything that might reach a structured log line.
// This is the single place that decides "is this field ever allowed to
// appear in a log" for the whole apps/api process — logger.ts calls this
// on every field object it's given, and nothing else should hand-roll its
// own redaction logic. If a new field needs to be excluded from logs, add
// its name/pattern here, once, rather than filtering it at each call site.
//
// Two layers, both applied:
//   1. NEVER_LOG_KEY_PATTERNS — field *names* that are always fully
//      redacted, regardless of what they contain or how deeply nested they
//      are. This is the authoritative "never-log list" required by the
//      Step 2 spec.
//   2. VALUE_SHAPE_PATTERNS — field *values* that look like a secret/token
//      even under an innocuous-looking key name (e.g. a provider's raw
//      response body containing an embedded bearer token) get redacted too.
//
// Deliberately fails closed: a field name we don't recognise but that
// looks sensitive (matches a shape pattern) is redacted even if its key
// isn't in the never-log list, and the recursion depth/size limits below
// exist so a redaction bug can never turn into a multi-megabyte log line
// or an infinite loop on a cyclic object.

/** Field names (case-insensitive, matched against the key, not the path) that are ALWAYS fully redacted. This is the authoritative "never-log list" for Step 2: session/auth secrets, payment and banking details, government/identity numbers, AML and e-sign document content, webhook/HMAC secrets, and raw request/response bodies that may carry any of the above. */
export const NEVER_LOG_KEY_PATTERNS: RegExp[] = [
  // Auth / session
  /^password$/i,
  /passwordhash/i,
  /^secret/i,
  /sessionsecret/i,
  /^cookie$/i,
  /^authorization$/i,
  /token/i, // accessToken, refreshToken, csrfToken, apiToken, ...
  /apikey/i,
  /privatekey/i,
  /^hmac/i,
  /webhooksecret/i,
  /signature/i, // HMAC/webhook signatures — never the verification secret's material either
  // Payments / banking
  /cardnumber/i,
  /^cvv$/i,
  /^cvc$/i,
  /accountnumber/i,
  /^bsb$/i,
  /iban/i,
  /routingnumber/i,
  // Identity / government
  /^ssn$/i,
  /taxfilenumber/i,
  /^tfn$/i,
  /medicarenumber/i,
  /passportnumber/i,
  /driverlicen[cs]e/i,
  /dateofbirth/i,
  /^dob$/i,
  // AML / e-sign document content (never the document bytes/base64, only
  // metadata like documentId/status is safe)
  /documentcontent/i,
  /documentbase64/i,
  /signedpdf/i,
  // Raw bytes that may embed any of the above (webhook payload snapshots,
  // express.json()'s verify-hook rawBody, provider request/response bodies)
  /^rawbody$/i,
  /^rawresponse$/i,
  /^requestbody$/i,
  // Full communication content — the fact that a message was sent is
  // loggable; what it said is not (Section 3's PII carve-out for
  // lib/communications)
  /^body$/i,
  /messagebody/i,
  /smsbody/i,
  /emailbody/i,
];

/** Value *shapes* that are redacted regardless of the key they're under — catches a secret embedded in a field we didn't anticipate (e.g. a provider's freeform errorDetail/responseSummary string that happens to echo back an Authorization header). */
const VALUE_SHAPE_PATTERNS: RegExp[] = [
  /^Bearer\s+[A-Za-z0-9._-]{10,}$/, // Authorization: Bearer <token>
  /^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/, // JWT-shaped
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/, // PEM private key
];

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 20;
const MAX_STRING_LENGTH = 2000;

function isNeverLogKey(key: string): boolean {
  return NEVER_LOG_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

function looksLikeSecretValue(value: string): boolean {
  return VALUE_SHAPE_PATTERNS.some((pattern) => pattern.test(value));
}

function redactValue(value: unknown, depth: number): unknown {
  if (value == null) return value;

  if (typeof value === "string") {
    if (looksLikeSecretValue(value)) return REDACTED;
    return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]` : value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (depth >= MAX_DEPTH) return "[MAX_DEPTH_EXCEEDED]";

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redactValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) items.push(`…[${value.length - MAX_ARRAY_ITEMS} more items truncated]`);
    return items;
  }

  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isNeverLogKey(key) ? REDACTED : redactValue(val, depth + 1);
    }
    return out;
  }

  // function, symbol, bigint, etc. — never useful in a log line
  return `[${typeof value}]`;
}

/**
 * Applies the central redaction policy to an arbitrary structured-log
 * fields object. Safe to call on anything — request bodies, event
 * payloads, provider responses, error objects — logger.ts calls this on
 * every `fields` argument it's given so no call site can accidentally
 * bypass it by passing an object that wasn't pre-sanitised.
 */
export function redactForLog<T>(fields: T): T {
  if (fields == null || typeof fields !== "object") return fields;
  return redactValue(fields, 0) as T;
}
