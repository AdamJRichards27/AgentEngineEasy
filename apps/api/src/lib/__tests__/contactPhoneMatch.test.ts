// The SQL phone key must agree with normalisePhoneAUNZ. Manual duplicate
// detection compares the key in the query, so a drift here would let
// "0400 000 103" and "+61400000103" through as two contacts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db } from "@aee/db";
import { contactPhoneMatchKey, contactPhoneMatchKeySql } from "../contactPhoneMatch.js";

const SAMPLES: Array<string | null> = [
  "0400 000 103",
  "0400000103",
  "+61400000103",
  "+61 400 000 103",
  "  0400 000 103  ",
  "(04) 0000 0103",
  "61400000103",
  "0499888777",
  "021 123 456",
  "0211234567",
  "+64 21 123 4567",
  "(07) 3333 4444",
  "not-a-phone",
  "123 456",
  "",
  "   ",
  null,
];

test("the query expression normalises a phone the same way import does", async () => {
  for (const raw of SAMPLES) {
    // Cast so Postgres can type a bare parameter. parties.mobile is already text.
    const value = sql`${raw}::text`;
    const result = await db.execute(sql`SELECT ${contactPhoneMatchKeySql(value)} AS key`);
    const row = result.rows[0] as { key: string | null };
    assert.equal(row.key, contactPhoneMatchKey(raw), JSON.stringify(raw));
  }
});
