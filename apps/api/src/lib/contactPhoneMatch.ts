// Phone duplicate matching for hand-typed contacts.
//
// Import already stores Australian mobiles as +61400000103 (normalisePhoneAUNZ).
// A contact typed as "0400 000 103" or "0400000103" is the same number, so
// duplicate detection compares that normalised form rather than the raw text.
// The key is computed in the query from parties.mobile. There is no stored
// column and no migration: the expression below is the SQL form of
// normalisePhoneAUNZ, and contactPhoneMatch.test.ts checks they agree.

import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { normalisePhoneAUNZ } from "./import/normalise.js";

/** Comparable phone key. Null when there is no number to compare. */
export function contactPhoneMatchKey(raw: string | null | undefined): string | null {
  return normalisePhoneAUNZ(raw).value;
}

/**
 * SQL expression with the same result as contactPhoneMatchKey for one text
 * value. Australian shapes are tried before New Zealand, matching
 * normalisePhoneAUNZ. Anything that is not a confident AU/NZ number stays
 * the trimmed original, so two identical non-AU numbers still match and two
 * different spellings of an unrecognised number do not.
 */
export function contactPhoneMatchKeySql(column: SQLWrapper): SQL {
  const digits = sql`regexp_replace(btrim(${column}), '[^0-9+]', '', 'g')`;
  return sql`(CASE
    WHEN ${column} IS NULL OR btrim(${column}) = '' THEN NULL
    WHEN (${digits}) ~ '^(?:[+]{0,1}61|0)[0-9]{9}$'
      THEN regexp_replace(${digits}, '^(?:[+]{0,1}61|0)([0-9]{9})$', '+61\\1')
    WHEN (${digits}) ~ '^(?:[+]{0,1}64|0)[0-9]{7,9}$'
      THEN regexp_replace(${digits}, '^(?:[+]{0,1}64|0)([0-9]{7,9})$', '+64\\1')
    ELSE btrim(${column})
  END)`;
}
