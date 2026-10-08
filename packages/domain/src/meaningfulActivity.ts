/**
 * D3 — what counts as meaningful contact.
 *
 * Stored activity types are the text values on grow_activities.activity_type
 * (packages/db/src/schema/grow.ts). This module does not add types and does
 * not change the table.
 *
 * Included: a logged or completed call, a meeting, an email or SMS that was
 * actually sent or received, an appraisal event, a call summary, and a
 * qualifying inbound or outbound Hub message.
 *
 * Excluded: notes, system or automated events, reschedules, task edits, and
 * a second record of an interaction that is already represented. A call and
 * its call_summary share details.callSessionId (or the call's sourceId when
 * source is grow_calls). A Hub message and a grow activity share
 * details.communicationMessageId, details.messageId, or
 * details.providerMessageId.
 */

/** Same list as GROW_ACTIVITY_TYPES in the schema. Text column, not an enum. */
export const GROW_ACTIVITY_TYPES = [
  "call",
  "call_summary",
  "email",
  "sms",
  "meeting",
  "appraisal",
  "note",
  "task_completion",
  "campaign_response",
  "property_enquiry",
  "offer_related",
  "system_event",
] as const;

export type GrowActivityType = (typeof GROW_ACTIVITY_TYPES)[number];

/** Types an agent may record by hand from Contact 360 or an opportunity row. */
export const MANUAL_LOG_ACTIVITY_TYPES = ["call", "meeting"] as const;
export type ManualLogActivityType = (typeof MANUAL_LOG_ACTIVITY_TYPES)[number];

/**
 * Types that can be meaningful contact before status and dedupe. Notes,
 * system events, task completions, and the other non-contact types are absent.
 */
export const MEANINGFUL_GROW_ACTIVITY_TYPES = [
  "call",
  "call_summary",
  "email",
  "sms",
  "meeting",
  "appraisal",
] as const;

export type MeaningfulGrowActivityType = (typeof MEANINGFUL_GROW_ACTIVITY_TYPES)[number];

/** Hub channels that can be a real email, SMS, or call. Mirrors qualifyingCommunications. */
export const QUALIFYING_HUB_CHANNELS = ["EMAIL", "SMS", "PHONE_CALL"] as const;

export const QUALIFYING_OUTBOUND_STATUSES = ["SENT", "DELIVERED"] as const;

export const QUALIFYING_INBOUND_STATUS = "RECEIVED";

/**
 * A message or call in one of these states did not happen. Same set the Hub
 * read already refuses, plus call attempts that never connected.
 */
export const NON_CONTACT_STATUSES = [
  "DRAFT",
  "AWAITING_APPROVAL",
  "APPROVED",
  "QUEUED",
  "SENDING",
  "RETRY_SCHEDULED",
  "FAILED",
  "BOUNCED",
  "UNDELIVERABLE",
  "CANCELLED",
  "CANCELED",
  "BLOCKED_BY_CONSENT",
  "BLOCKED_BY_COST_CONTROL",
  "ATTEMPTED",
  "NO_ANSWER",
  "MISSED",
  "BUSY",
] as const;

/** details.kind values that are bookkeeping, not contact. Matched by substring, lowercased. */
export const EXCLUDED_ACTIVITY_KIND_MARKERS = ["reschedul", "task_edit"] as const;

/** A logged occurred-at may sit this far ahead of the server clock. */
export const ACTIVITY_OCCURRED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** Further back than this is not a contact an agent is recording. */
export const ACTIVITY_OCCURRED_AT_MAX_PAST_MS = 100 * 365.25 * 24 * 60 * 60 * 1000;

export const ACTIVITY_SUMMARY_MAX = 2000;
export const ACTIVITY_OUTCOME_MAX = 200;
export const ACTIVITY_DURATION_MAX_MINUTES = 24 * 60;

export const ACTIVITY_FIELDS_REQUIRED = "ACTIVITY_FIELDS_REQUIRED";
export const ACTIVITY_TYPE_NOT_ALLOWED = "ACTIVITY_TYPE_NOT_ALLOWED";
export const CALL_SUMMARY_REVIEW_ONLY = "CALL_SUMMARY_REVIEW_ONLY";
export const OCCURRED_AT_INVALID = "OCCURRED_AT_INVALID";
export const OCCURRED_AT_OUT_OF_RANGE = "OCCURRED_AT_OUT_OF_RANGE";
export const ACTIVITY_SUMMARY_INVALID = "ACTIVITY_SUMMARY_INVALID";
export const ACTIVITY_DURATION_INVALID = "ACTIVITY_DURATION_INVALID";
export const ACTIVITY_OUTCOME_INVALID = "ACTIVITY_OUTCOME_INVALID";
export const ACTIVITY_DETAILS_INVALID = "ACTIVITY_DETAILS_INVALID";
export const CONTACT_REFERENCE_INVALID = "CONTACT_REFERENCE_INVALID";
export const PROPERTY_REFERENCE_INVALID = "PROPERTY_REFERENCE_INVALID";
export const OPPORTUNITY_REFERENCE_INVALID = "OPPORTUNITY_REFERENCE_INVALID";

const ACTIVITY_TYPE_SET: ReadonlySet<string> = new Set(GROW_ACTIVITY_TYPES);
const MEANINGFUL_TYPE_SET: ReadonlySet<string> = new Set(MEANINGFUL_GROW_ACTIVITY_TYPES);
const NON_CONTACT_STATUS_SET: ReadonlySet<string> = new Set(NON_CONTACT_STATUSES);
const MANUAL_LOG_SET: ReadonlySet<string> = new Set(MANUAL_LOG_ACTIVITY_TYPES);

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface MeaningfulActivityInput {
  id?: string | number | null;
  /** grow_activities.activity_type, when this row is an activity. */
  activityType?: string | null;
  source?: string | null;
  sourceId?: string | null;
  occurredAt?: Date | string | null;
  details?: Record<string, unknown> | null;
  /** Set for a communication_messages row. */
  kind?: "grow_activity" | "hub_message";
  channel?: string | null;
  direction?: string | null;
  status?: string | null;
  providerMessageId?: string | null;
}

export function normalizeActivityType(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isManualLogActivityType(value: string): value is ManualLogActivityType {
  return MANUAL_LOG_SET.has(value);
}

/**
 * Allow-list for POST /grow/activities. Matching is case-insensitive and the
 * returned type is the canonical lowercase value. call_summary is in the
 * domain list; the route still refuses it because only transcription review
 * may write one.
 */
export function parsePostedActivityType(
  value: unknown,
): { ok: true; activityType: GrowActivityType } | { ok: false; code: typeof ACTIVITY_TYPE_NOT_ALLOWED; error: string } {
  const normalized = normalizeActivityType(typeof value === "string" ? value : "");
  if (!ACTIVITY_TYPE_SET.has(normalized)) {
    return {
      ok: false,
      code: ACTIVITY_TYPE_NOT_ALLOWED,
      error: `activityType must be one of ${GROW_ACTIVITY_TYPES.join(", ")}`,
    };
  }
  return { ok: true, activityType: normalized as GrowActivityType };
}

export function parseActivitySummary(
  value: unknown,
): { ok: true; summary: string } | { ok: false; code: typeof ACTIVITY_SUMMARY_INVALID | typeof ACTIVITY_FIELDS_REQUIRED; error: string } {
  if (typeof value !== "string") {
    return { ok: false, code: ACTIVITY_FIELDS_REQUIRED, error: "activityType and summary are required" };
  }
  const summary = value.trim();
  if (summary.length === 0) {
    return { ok: false, code: ACTIVITY_FIELDS_REQUIRED, error: "activityType and summary are required" };
  }
  if (summary.length > ACTIVITY_SUMMARY_MAX) {
    return {
      ok: false,
      code: ACTIVITY_SUMMARY_INVALID,
      error: `summary must be ${ACTIVITY_SUMMARY_MAX} characters or fewer`,
    };
  }
  return { ok: true, summary };
}

export function parseActivityOccurredAt(
  value: unknown,
  now: Date = new Date(),
):
  | { ok: true; occurredAt: Date }
  | { ok: false; code: typeof OCCURRED_AT_INVALID | typeof OCCURRED_AT_OUT_OF_RANGE; error: string } {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) {
    return { ok: false, code: OCCURRED_AT_INVALID, error: "occurredAt must be an ISO-8601 timestamp" };
  }
  const occurredAt = new Date(value);
  if (Number.isNaN(occurredAt.getTime())) {
    return { ok: false, code: OCCURRED_AT_INVALID, error: "occurredAt must be an ISO-8601 timestamp" };
  }
  if (occurredAt.getTime() > now.getTime() + ACTIVITY_OCCURRED_AT_FUTURE_SKEW_MS) {
    return { ok: false, code: OCCURRED_AT_OUT_OF_RANGE, error: "occurredAt cannot be in the future" };
  }
  if (now.getTime() - occurredAt.getTime() > ACTIVITY_OCCURRED_AT_MAX_PAST_MS) {
    return { ok: false, code: OCCURRED_AT_OUT_OF_RANGE, error: "occurredAt is too far in the past" };
  }
  return { ok: true, occurredAt };
}

export function parseOptionalDurationMinutes(
  value: unknown,
): { ok: true; durationMinutes: number | null } | { ok: false; code: typeof ACTIVITY_DURATION_INVALID; error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, durationMinutes: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > ACTIVITY_DURATION_MAX_MINUTES) {
    return {
      ok: false,
      code: ACTIVITY_DURATION_INVALID,
      error: `durationMinutes must be a whole number of minutes from 1 to ${ACTIVITY_DURATION_MAX_MINUTES}`,
    };
  }
  return { ok: true, durationMinutes: value };
}

export function parseOptionalOutcome(
  value: unknown,
): { ok: true; outcome: string | null } | { ok: false; code: typeof ACTIVITY_OUTCOME_INVALID; error: string } {
  if (value === undefined || value === null) return { ok: true, outcome: null };
  if (typeof value !== "string") {
    return { ok: false, code: ACTIVITY_OUTCOME_INVALID, error: `outcome must be ${ACTIVITY_OUTCOME_MAX} characters or fewer` };
  }
  const outcome = value.trim();
  if (outcome.length === 0) return { ok: true, outcome: null };
  if (outcome.length > ACTIVITY_OUTCOME_MAX) {
    return {
      ok: false,
      code: ACTIVITY_OUTCOME_INVALID,
      error: `outcome must be ${ACTIVITY_OUTCOME_MAX} characters or fewer`,
    };
  }
  return { ok: true, outcome };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function upper(value: unknown): string {
  return text(value).toUpperCase();
}

function lower(value: unknown): string {
  return text(value).toLowerCase();
}

function detailsOf(activity: MeaningfulActivityInput): Record<string, unknown> {
  const details = activity.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return {};
  return details;
}

function readId(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return null;
}

function statusOf(activity: MeaningfulActivityInput): string {
  const details = detailsOf(activity);
  return upper(activity.status ?? details.status);
}

function isExcludedKind(activity: MeaningfulActivityInput): boolean {
  const kind = lower(detailsOf(activity).kind);
  if (kind.length === 0) return false;
  return EXCLUDED_ACTIVITY_KIND_MARKERS.some((marker) => kind.includes(marker));
}

function hasNonContactStatus(activity: MeaningfulActivityInput): boolean {
  const status = statusOf(activity);
  return status.length > 0 && NON_CONTACT_STATUS_SET.has(status);
}

function isHubRecord(activity: MeaningfulActivityInput): boolean {
  if (activity.kind === "hub_message") return true;
  if (activity.kind === "grow_activity") return false;
  return text(activity.activityType).length === 0 && text(activity.channel).length > 0;
}

function hubQualifies(activity: MeaningfulActivityInput): boolean {
  const channel = upper(activity.channel);
  if (!(QUALIFYING_HUB_CHANNELS as readonly string[]).includes(channel)) return false;
  const direction = upper(activity.direction);
  const status = statusOf(activity);
  if (direction === "OUTBOUND") return (QUALIFYING_OUTBOUND_STATUSES as readonly string[]).includes(status);
  if (direction === "INBOUND") return status === QUALIFYING_INBOUND_STATUS;
  return false;
}

/** Single-record D3 classification. Dedupe is applied by the peers argument. */
export function classifiesAsMeaningful(activity: MeaningfulActivityInput): boolean {
  if (isExcludedKind(activity)) return false;
  if (isHubRecord(activity)) return hubQualifies(activity);

  const type = normalizeActivityType(activity.activityType);
  if (!MEANINGFUL_TYPE_SET.has(type)) return false;
  if (type === "email" || type === "sms") return !hasNonContactStatus(activity);
  if (type === "call") {
    if (lower(activity.source) === "manual") return true;
    return !hasNonContactStatus(activity);
  }
  return true;
}

function callSessionKey(activity: MeaningfulActivityInput): string | null {
  const type = normalizeActivityType(activity.activityType);
  const details = detailsOf(activity);
  const fromDetails = readId(details.callSessionId);
  if (fromDetails && (type === "call" || type === "call_summary" || upper(activity.channel) === "PHONE_CALL")) {
    return `call-session:${fromDetails}`;
  }
  if (type === "call" && lower(activity.source) === "grow_calls") {
    const sourceId = readId(activity.sourceId);
    if (sourceId) return `call-session:${sourceId}`;
  }
  return null;
}

function messageKey(activity: MeaningfulActivityInput): string | null {
  if (isHubRecord(activity)) {
    const id = readId(activity.id);
    if (id) return `message:${id}`;
  }
  const details = detailsOf(activity);
  const linked = readId(details.communicationMessageId) ?? readId(details.messageId);
  if (linked) return `message:${linked}`;
  return null;
}

function providerKey(activity: MeaningfulActivityInput): string | null {
  const details = detailsOf(activity);
  const provider = readId(activity.providerMessageId) ?? readId(details.providerMessageId);
  if (!provider) return null;
  return `provider:${provider}`;
}

/** Linkage keys already stored on the row. An empty list means "not a duplicate of anything else". */
export function activityLinkageKeys(activity: MeaningfulActivityInput): string[] {
  const keys = [callSessionKey(activity), messageKey(activity), providerKey(activity)].filter(
    (key): key is string => key !== null,
  );
  return [...new Set(keys)];
}

function occurredAtMillis(activity: MeaningfulActivityInput): number {
  const value = activity.occurredAt;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
  }
  return Number.POSITIVE_INFINITY;
}

function sameRecord(left: MeaningfulActivityInput, right: MeaningfulActivityInput): boolean {
  if (left === right) return true;
  if (left.id == null || right.id == null) return false;
  const leftKind = left.kind ?? "grow_activity";
  const rightKind = right.kind ?? "grow_activity";
  return leftKind === rightKind && String(left.id) === String(right.id);
}

/** Lower is kept. A call beats its summary and a Hub mirror of the same interaction. */
function canonicalRank(activity: MeaningfulActivityInput): number {
  const type = normalizeActivityType(activity.activityType);
  if (!isHubRecord(activity) && type === "call") return 0;
  if (isHubRecord(activity)) return 1;
  if (type === "call_summary") return 3;
  return 2;
}

function preferCanonical(current: MeaningfulActivityInput, candidate: MeaningfulActivityInput): MeaningfulActivityInput {
  const rankDiff = canonicalRank(candidate) - canonicalRank(current);
  if (rankDiff !== 0) return rankDiff < 0 ? candidate : current;
  const timeDiff = occurredAtMillis(candidate) - occurredAtMillis(current);
  if (timeDiff !== 0) return timeDiff < 0 ? candidate : current;
  const candidateId = typeof candidate.id === "number" ? candidate.id : Number.MAX_SAFE_INTEGER;
  const currentId = typeof current.id === "number" ? current.id : Number.MAX_SAFE_INTEGER;
  return candidateId < currentId ? candidate : current;
}

/**
 * One record per interaction. Records that share a linkage key collapse to
 * the canonical one: the call when a call is present, otherwise the Hub
 * message, otherwise the earliest remaining record. A call summary is kept
 * only when it is the only record of that interaction.
 */
export function selectMeaningfulActivities(activities: readonly MeaningfulActivityInput[]): MeaningfulActivityInput[] {
  const meaningful = activities.filter(classifiesAsMeaningful);
  const count = meaningful.length;
  const parent = Array.from({ length: count }, (_, index) => index);
  const find = (index: number): number => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]!]!;
      cursor = parent[cursor]!;
    }
    return cursor;
  };
  const unite = (left: number, right: number) => {
    const rootLeft = find(left);
    const rootRight = find(right);
    if (rootLeft !== rootRight) parent[rootRight] = rootLeft;
  };
  const firstForKey = new Map<string, number>();
  for (let index = 0; index < count; index++) {
    for (const key of activityLinkageKeys(meaningful[index]!)) {
      const existing = firstForKey.get(key);
      if (existing === undefined) firstForKey.set(key, index);
      else unite(existing, index);
    }
  }
  const groups = new Map<number, MeaningfulActivityInput>();
  for (let index = 0; index < count; index++) {
    const root = find(index);
    const current = groups.get(root);
    const candidate = meaningful[index]!;
    groups.set(root, current === undefined ? candidate : preferCanonical(current, candidate));
  }
  return [...groups.values()];
}

/**
 * D3. With no peers, this is the single-record classification. With peers,
 * a duplicate of an interaction already in that set is not meaningful.
 */
export function isMeaningfulActivity(
  activity: MeaningfulActivityInput,
  peers: readonly MeaningfulActivityInput[] = [],
): boolean {
  if (!classifiesAsMeaningful(activity)) return false;
  if (peers.length === 0) return true;
  const pool = peers.some((peer) => sameRecord(peer, activity)) ? peers : [activity, ...peers];
  return selectMeaningfulActivities(pool).some((kept) => sameRecord(kept, activity));
}

/** Latest canonical contact moment. Notes, reschedules, and duplicates do not move it. */
export function lastMeaningfulContactAt(activities: readonly MeaningfulActivityInput[]): Date | null {
  let latest: Date | null = null;
  for (const activity of selectMeaningfulActivities(activities)) {
    const millis = occurredAtMillis(activity);
    if (!Number.isFinite(millis)) continue;
    if (latest === null || millis > latest.getTime()) latest = new Date(millis);
  }
  return latest;
}
