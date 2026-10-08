import assert from "node:assert/strict";
import test from "node:test";
import {
  GROW_LIST_PAGE_DEFAULT,
  GROW_LIST_PAGE_MAX,
  encodeGrowListCursor,
  parseGrowListCursor,
  parseGrowListLimit,
  readGrowListPageQuery,
  sliceGrowListPage,
} from "../growListPage.js";

test("page size defaults to 50 and clamps to 100", () => {
  assert.deepEqual(parseGrowListLimit(undefined), { ok: true, limit: GROW_LIST_PAGE_DEFAULT });
  assert.equal(GROW_LIST_PAGE_DEFAULT, 50);
  assert.deepEqual(parseGrowListLimit("50"), { ok: true, limit: 50 });
  assert.deepEqual(parseGrowListLimit("1"), { ok: true, limit: 1 });
  assert.deepEqual(parseGrowListLimit("100"), { ok: true, limit: 100 });
  assert.deepEqual(parseGrowListLimit("101"), { ok: true, limit: GROW_LIST_PAGE_MAX });
  assert.deepEqual(parseGrowListLimit("1000"), { ok: true, limit: 100 });
  for (const raw of ["0", "-1", "1.5", "050", "abc", "", " 50", ["50"]]) {
    const parsed = parseGrowListLimit(raw);
    assert.equal(parsed.ok, false, `expected ${JSON.stringify(raw)} to be rejected`);
  }
});

test("a cursor is an opaque position and ignores a brokerage id", () => {
  const encoded = encodeGrowListCursor({ at: "2024-06-01 00:00:00.000000", id: 42 });
  assert.equal(encoded.includes("brokerage"), false);
  const decoded = parseGrowListCursor(encoded);
  assert.deepEqual(decoded, { ok: true, cursor: { at: "2024-06-01 00:00:00.000000", id: 42 } });

  const crafted = Buffer.from(
    JSON.stringify({ at: "2024-06-01 00:00:00.000000", id: 99, brokerageId: 7 }),
    "utf8",
  ).toString("base64url");
  const fromCrafted = parseGrowListCursor(crafted);
  assert.deepEqual(fromCrafted, { ok: true, cursor: { at: "2024-06-01 00:00:00.000000", id: 99 } });
  assert.equal(JSON.parse(Buffer.from(encodeGrowListCursor({ at: "2024-06-01 00:00:00.000000", id: 99 }), "base64url").toString("utf8")).brokerageId, undefined);

  assert.deepEqual(parseGrowListCursor(undefined), { ok: true, cursor: null });
  for (const raw of ["", "not-base64", Buffer.from("[]", "utf8").toString("base64url"), Buffer.from("{}", "utf8").toString("base64url")]) {
    assert.equal(parseGrowListCursor(raw).ok, false, `expected ${raw} to be rejected`);
  }
});

test("readGrowListPageQuery rejects a bad limit before trusting a cursor", () => {
  const bad = readGrowListPageQuery({ limit: "0", cursor: encodeGrowListCursor({ at: "2024-06-01 00:00:00.000000", id: 1 }) });
  assert.deepEqual(bad, { ok: false, error: "limit must be a positive integer" });
  const page = readGrowListPageQuery({});
  assert.deepEqual(page, { ok: true, page: { limit: 50, cursor: null } });
});

test("sliceGrowListPage keeps one page and points the cursor at the last returned row", () => {
  const rows = [
    { id: 5, sortAt: "2024-01-03 00:00:00.000000" },
    { id: 4, sortAt: "2024-01-02 00:00:00.000000" },
    { id: 3, sortAt: "2024-01-02 00:00:00.000000" },
  ];
  const page = sliceGrowListPage(rows, 2);
  assert.deepEqual(page.rows.map((row) => row.id), [5, 4]);
  const cursor = parseGrowListCursor(page.nextCursor ?? undefined);
  assert.deepEqual(cursor, { ok: true, cursor: { at: "2024-01-02 00:00:00.000000", id: 4 } });
  assert.equal(sliceGrowListPage(rows.slice(0, 2), 2).nextCursor, null);
});
