/**
 * AE GROW "Brokerage-wide Signal Sweep" stage 2 — THE EXPLAINABILITY CONTRACT.
 *
 * Every signal AE raises must be able to answer, on its own, without anyone
 * re-running a rule or reading this source file:
 *
 *   1. WHAT was observed — the specific facts, one entry each.
 *   2. WHICH records they came from — table + id + the date the fact is
 *      about (never the date the row happened to be written).
 *   3. WHEN — so an agent can tell a fresh fact from a two-year-old one.
 *   4. WHAT AE DOES NOT KNOW — the inputs the rule looked for and did not
 *      find. This is the difference between "AE checked and this is what it
 *      saw" and an unexplained score.
 *   5. WHY IT MATTERS, in plain language, and what a HUMAN might do about it.
 *
 * This module is the single definition of that shape, so no rule can ship a
 * bare score and no two rules can describe themselves differently.
 *
 * NOTHING HERE PERFORMS AN ACTION. `agentAction` is a sentence describing
 * what a person could choose to do. It is not an instruction, not a task, not
 * a queued message, and nothing in this codebase executes it — a signal can
 * never reach a customer (see sweep.ts's module header).
 *
 * =====================================================================
 * BACKWARD COMPATIBILITY
 * =====================================================================
 * The structured fields are ADDED ALONGSIDE the flat keys stage 1's rules
 * already wrote (`relationshipId`, `appraisalId`, `observationId`,
 * `provider`, `payload`, ...), never instead of them. A reader that indexes
 * `evidence.relationshipId` keeps working unchanged; a reader that wants the
 * explanation reads `evidence.observations`. Existing rows are untouched —
 * they simply carry no `schemaVersion`, which is how a consumer detects the
 * older shape.
 */

/** Bumped only when the envelope's SHAPE changes, never when a rule's content changes. */
export const SIGNAL_EVIDENCE_SCHEMA_VERSION = 1;

export interface SignalObservation {
  /** One observed fact, in plain language, complete as a sentence fragment. */
  what: string;
  /** The table the fact was read from, e.g. "grow_relationships". */
  recordType: string;
  /** That row's id. `null` only where the fact is an ABSENCE (see `what`). */
  recordId: number | string | null;
  /** The date the observed fact is ABOUT, ISO-8601, or null when the source carries no date. */
  observedAt: string | null;
  /** "internal" for AE's own records, or the provider id for a provider observation. */
  source: string;
  /** Machine-readable specifics behind `what`. */
  detail?: Record<string, unknown>;
}

export interface StructuredSignalEvidence {
  schemaVersion: number;
  /** The rule that produced this signal, e.g. "long_ownership_tenure". */
  rule: string;
  /**
   * Bumped by a rule when its MEANING changes (different inputs, different
   * thresholds), so a stored row can be told apart from one raised by an
   * older version of the same rule.
   */
  ruleVersion: number;
  observations: SignalObservation[];
  /** The exact inputs the confidence band was computed from, including the thresholds. */
  basis: Record<string, unknown>;
  /** Inputs this rule looked for and did NOT have. Empty array = the rule had everything it wanted. */
  unknowns: string[];
  /** What a person might choose to do. Never performed by AE. */
  agentAction: string;
  /** Stage 1's flat keys, preserved verbatim for existing readers. */
  [legacyKey: string]: unknown;
}

export interface BuildEvidenceInput {
  rule: string;
  ruleVersion: number;
  observations: SignalObservation[];
  basis: Record<string, unknown>;
  unknowns?: string[];
  agentAction: string;
  /** Flat keys stage 1 already emitted for this rule; spread last so they are never shadowed. */
  legacy?: Record<string, unknown>;
}

export function buildEvidence(input: BuildEvidenceInput): StructuredSignalEvidence {
  return {
    schemaVersion: SIGNAL_EVIDENCE_SCHEMA_VERSION,
    rule: input.rule,
    ruleVersion: input.ruleVersion,
    observations: input.observations,
    basis: input.basis,
    unknowns: input.unknowns ?? [],
    agentAction: input.agentAction,
    ...(input.legacy ?? {}),
  };
}

/**
 * AE GROW Completion W2-D — the READ side of the contract above.
 *
 * `grow_opportunity_signals.evidence` is jsonb. Most rows carry the
 * structured envelope buildEvidence() writes, but rows written before
 * schemaVersion 1 (and any row a future rule writes differently) do not, so a
 * surfacing path must be able to ask "what was observed, and what does AE not
 * know?" without trusting the shape.
 *
 * Total by construction: every field degrades to empty rather than throwing,
 * and nothing is invented to fill a gap. An empty `unknowns` from a legacy row
 * means "this row does not record its unknowns", which the caller renders as
 * silence — never as "AE knows everything".
 */
export interface ReadableSignalEvidence {
  observations: SignalObservation[];
  unknowns: string[];
  agentAction: string | null;
}

function isObservation(value: unknown): value is SignalObservation {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return typeof o.what === "string" && o.what.trim() !== "";
}

export function readEvidence(raw: unknown): ReadableSignalEvidence {
  const evidence = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

  const observations = Array.isArray(evidence.observations) ? evidence.observations.filter(isObservation) : [];
  const unknowns = Array.isArray(evidence.unknowns) ? evidence.unknowns.filter((u): u is string => typeof u === "string" && u.trim() !== "") : [];
  const agentAction = typeof evidence.agentAction === "string" && evidence.agentAction.trim() !== "" ? evidence.agentAction : null;

  return { observations, unknowns, agentAction };
}

/* ---------------------------------------------------------------------
 * Bounding an untrusted provider payload before it enters evidence.
 *
 * WHY THIS EXISTS. A provider observation's `payload` is raw provider-shaped
 * jsonb with NO SIZE BOUND anywhere in the schema or in
 * observations.ts's write path. Embedding it whole into every candidate's
 * evidence put an unbounded, externally-controlled blob into the same heap
 * that serves HTTP requests, once per candidate, for up to a whole
 * brokerage's worth of observations at a time — and then wrote it back out
 * again into grow_opportunity_signals.evidence.
 *
 * WHAT IS KEPT. Enough to explain the signal without a second lookup: the
 * top-level keys, in a deterministic order, with long strings clamped and
 * large nested structures replaced by a descriptor. Nothing is lost — the
 * complete, untouched payload is still exactly where it always was, on the
 * property_provider_observations row, and `fullValueAt` says so explicitly.
 *
 * FINGERPRINT SAFETY. No observation rule's fingerprint is built from the
 * payload (it is band + sourceTimestamp — see buildEvidenceFingerprint() in
 * ./evaluation.ts), so bounding can never churn a fingerprint and can never
 * defeat the re-review policy. This function is also deterministic: the same
 * payload always bounds to the same result, keys sorted, so it would be safe
 * to fingerprint even if a future rule chose to.
 * -----------------------------------------------------------------*/

/** Top-level keys retained. Beyond this, key names are listed in `omittedKeys` and the values dropped. */
export const EVIDENCE_PAYLOAD_MAX_KEYS = 24;
/** Approximate serialised ceiling for the retained payload. */
export const EVIDENCE_PAYLOAD_MAX_BYTES = 4096;
/** Longest string value kept intact. */
export const EVIDENCE_PAYLOAD_MAX_STRING_CHARS = 512;
/** A single nested object/array larger than this is replaced by a descriptor rather than inlined. */
export const EVIDENCE_PAYLOAD_MAX_NESTED_BYTES = 512;

export interface BoundedPayloadRef {
  recordType: string;
  recordId: number | string;
  column: string;
}

export interface BoundedPayload {
  /** The retained, size-bounded view. */
  payload: Record<string, unknown>;
  /** True when anything at all was clamped, dropped or summarised. */
  bounded: boolean;
  /** Top-level keys whose values were dropped entirely, in sorted order. */
  omittedKeys: string[];
  /** Approximate serialised size of the ORIGINAL value, so a reader can see what was cut. */
  originalBytes: number;
  /** Where the complete, untouched value still lives. */
  fullValueAt: BoundedPayloadRef;
}

function approxBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 0 : json.length;
  } catch {
    // A payload containing a cycle cannot have come from jsonb, but never
    // let evidence construction be the thing that throws.
    return Number.MAX_SAFE_INTEGER;
  }
}

function boundValue(value: unknown): { value: unknown; bounded: boolean } {
  if (typeof value === "string" && value.length > EVIDENCE_PAYLOAD_MAX_STRING_CHARS) {
    return { value: `${value.slice(0, EVIDENCE_PAYLOAD_MAX_STRING_CHARS)}…[truncated]`, bounded: true };
  }
  if (value !== null && typeof value === "object") {
    const size = approxBytes(value);
    if (size > EVIDENCE_PAYLOAD_MAX_NESTED_BYTES) {
      return {
        value: {
          omitted: Array.isArray(value) ? "array" : "object",
          ...(Array.isArray(value) ? { length: value.length } : { keys: Object.keys(value as Record<string, unknown>).length }),
          approxBytes: size,
        },
        bounded: true,
      };
    }
  }
  return { value, bounded: false };
}

/**
 * Produces a deterministic, size-bounded view of a provider payload, plus an
 * explicit pointer to where the complete value still lives.
 */
export function boundPayload(raw: unknown, fullValueAt: BoundedPayloadRef): BoundedPayload {
  const source: Record<string, unknown> =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : { value: raw };

  const keys = Object.keys(source).sort();
  const payload: Record<string, unknown> = {};
  const omittedKeys: string[] = [];
  let bounded = false;
  let originalBytes = 0;
  let usedBytes = 0;

  for (const key of keys) {
    const valueBytes = approxBytes(source[key]);
    originalBytes += key.length + valueBytes + 4; // key, value, quotes/colon/comma

    if (Object.keys(payload).length >= EVIDENCE_PAYLOAD_MAX_KEYS || usedBytes >= EVIDENCE_PAYLOAD_MAX_BYTES) {
      omittedKeys.push(key);
      bounded = true;
      continue;
    }
    const clamped = boundValue(source[key]);
    if (clamped.bounded) bounded = true;
    payload[key] = clamped.value;
    usedBytes += key.length + approxBytes(clamped.value) + 4;
  }

  return { payload, bounded, omittedKeys, originalBytes, fullValueAt };
}

/* ---------------------------------------------------------------------
 * Date presentation.
 * -----------------------------------------------------------------*/

/**
 * Renders a date at the precision it was actually recorded at, so an
 * explanation can never assert more than the source said. A source that gave
 * "2011" reads back as "2011", not "1 January 2011".
 *
 * Deliberately UTC-fixed (`timeZone: "UTC"`) rather than host-local: every
 * timestamp in this schema is stored without a zone and the whole system runs
 * with TZ=UTC, so formatting in an ambient local zone could shift a recorded
 * date across a day boundary in an explanation an agent then quotes back to a
 * customer.
 */
export function formatDateAtPrecision(date: Date, precision: string | null): string {
  if (precision === "year") return String(date.getUTCFullYear());
  if (precision === "month") {
    return new Intl.DateTimeFormat("en-AU", { month: "long", year: "numeric", timeZone: "UTC" }).format(date);
  }
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}

/**
 * "about 3 years", "about 18 months", "about 40 days" — a duration phrased at
 * the granularity it is actually meaningful at. A tenure rule that says
 * "4,015 days" is technically precise and humanly useless.
 */
export function describeDuration(days: number): string {
  if (days >= 730) return `about ${Math.floor(days / 365)} years`;
  if (days >= 365) return "about a year";
  if (days >= 60) return `about ${Math.floor(days / 30)} months`;
  return `${days} days`;
}

/**
 * THE STANDARD CLOSING CAVEAT.
 *
 * Every rule's explanation ends with this. AE observes records; it does not
 * know anybody's private intentions, and a signal is an invitation to a human
 * judgement, never a claim about a customer. Centralised so the wording
 * cannot drift rule by rule, and so it cannot be quietly dropped from one.
 */
export const NON_PREDICTION_CAVEAT =
  "This describes what AE can see in your own records. It is not a prediction about this contact's plans, and AE has no information about their private intentions.";

/** Assembles the stored `explanation`: what was seen, why it is worth a look, then the caveat. */
export function buildReason(parts: { observed: string; whyItMatters: string }): string {
  return `${parts.observed.trim()} ${parts.whyItMatters.trim()} ${NON_PREDICTION_CAVEAT}`;
}
