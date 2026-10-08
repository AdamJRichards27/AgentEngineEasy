import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * Keyset (cursor) pagination for the Grow list endpoints.
 *
 * A cursor is an opaque position in `(sort_at DESC, id DESC)`. It is not an
 * authority: it carries no brokerage id, and every query still filters on
 * the caller's brokerage. A decoded or crafted cursor can only move the
 * window. Foreign rows stay out because the brokerage predicate is applied
 * beside the keyset predicate, including on the exact count.
 *
 * `sort_at` is the column the list already ordered by (`created_at`, or
 * `occurred_at` for activities), formatted from Postgres so microsecond
 * precision survives the round trip. `timestamp without time zone` values
 * are UTC wall-clock (see packages/db's session timezone guarantee), so the
 * formatted text is compared back with `::timestamp` and no session zone.
 */

export const GROW_LIST_PAGE_DEFAULT = 50;
export const GROW_LIST_PAGE_MAX = 100;

const SORT_AT = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{6})$/;
const MAX_SIGNED_INT4 = 2_147_483_647;

export type GrowListCursor = {
  /** `YYYY-MM-DD HH24:MI:SS.US` from `to_char` of the sort column. */
  at: string;
  id: number;
};

export type GrowListPageQuery = {
  limit: number;
  cursor: GrowListCursor | null;
};

export function sortAtSql(column: AnyColumn): SQL<string> {
  return sql<string>`to_char(${column}, 'YYYY-MM-DD HH24:MI:SS.US')`;
}

/** Rows strictly before `cursor` in `(sort_at DESC, id DESC)`. */
export function descendingKeysetBefore(sortColumn: AnyColumn, idColumn: AnyColumn, cursor: GrowListCursor): SQL {
  return sql`(${sortColumn}, ${idColumn}) < (${cursor.at}::timestamp, ${cursor.id})`;
}

export function parseGrowListLimit(raw: unknown): { ok: true; limit: number } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, limit: GROW_LIST_PAGE_DEFAULT };
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) {
    return { ok: false, error: "limit must be a positive integer" };
  }
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit)) return { ok: false, error: "limit must be a positive integer" };
  return { ok: true, limit: Math.min(limit, GROW_LIST_PAGE_MAX) };
}

export function parseGrowListCursor(raw: unknown): { ok: true; cursor: GrowListCursor | null } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, cursor: null };
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) {
    return { ok: false, error: "cursor is invalid" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "cursor is invalid" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "cursor is invalid" };
  const record = parsed as { at?: unknown; id?: unknown };
  if (typeof record.at !== "string" || !isSortAt(record.at)) return { ok: false, error: "cursor is invalid" };
  if (typeof record.id !== "number" || !Number.isInteger(record.id) || record.id <= 0 || record.id > MAX_SIGNED_INT4) {
    return { ok: false, error: "cursor is invalid" };
  }
  // Any other field (including a brokerage id) is ignored. The cursor is a position.
  return { ok: true, cursor: { at: record.at, id: record.id } };
}

export function readGrowListPageQuery(query: { limit?: unknown; cursor?: unknown }): { ok: true; page: GrowListPageQuery } | { ok: false; error: string } {
  const limit = parseGrowListLimit(query.limit);
  if (!limit.ok) return limit;
  const cursor = parseGrowListCursor(query.cursor);
  if (!cursor.ok) return cursor;
  return { ok: true, page: { limit: limit.limit, cursor: cursor.cursor } };
}

export function encodeGrowListCursor(cursor: GrowListCursor): string {
  return Buffer.from(JSON.stringify({ at: cursor.at, id: cursor.id }), "utf8").toString("base64url");
}

export function sliceGrowListPage<T extends { id: number; sortAt: string }>(
  fetched: T[],
  limit: number,
): { rows: T[]; nextCursor: string | null } {
  const hasMore = fetched.length > limit;
  const rows = hasMore ? fetched.slice(0, limit) : fetched;
  const last = rows.length > 0 ? rows[rows.length - 1] : undefined;
  return {
    rows,
    nextCursor: hasMore && last ? encodeGrowListCursor({ at: last.sortAt, id: last.id }) : null,
  };
}

export function parseOptionalPositiveId(raw: unknown): { ok: true; id: number | null } | { ok: false } {
  if (raw === undefined || raw === "") return { ok: true, id: null };
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) return { ok: false };
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id > MAX_SIGNED_INT4) return { ok: false };
  return { ok: true, id };
}

/** Trimmed search text, or "" when the query param is absent or not a string. */
export function readSearchQuery(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function isSortAt(value: string): boolean {
  const match = SORT_AT.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}
