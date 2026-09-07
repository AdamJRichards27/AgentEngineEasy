// F-04: proves the specific safety properties the excelParser.ts header
// comment claims ("does not evaluate formulas as code... never requests
// formula recalculation") actually hold under real execution, not just as
// a comment, and proves parser failures never escape as raw exceptions.
import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import { ExcelParser } from "../parsers/excelParser.js";
import { getParserForFile } from "../parsers/registry.js";
import { ImportParseError } from "../parsers/types.js";

function xlsxBuffer(ws: XLSX.WorkSheet): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

test("uses the reviewed SheetJS CE release", () => {
  assert.equal(XLSX.version, "0.20.3");
});

test("F-04: parses a genuine workbook into headers/rows (happy path sanity check)", async () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ["First Name", "Last Name"],
    ["Jane", "Smith"],
  ]);
  const parser = new ExcelParser();
  const parsed = await parser.parse(xlsxBuffer(ws));
  assert.deepEqual(parsed.headers, ["First Name", "Last Name"]);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0]["First Name"], "Jane");
});

test("F-04: never evaluates formulas -- a stale cached value is surfaced as-is, proving the formula string itself is never executed", async () => {
  // Cell B2 carries a formula ("SUM(1,41)", which would compute to 42) but a
  // deliberately WRONG cached value (999). If the parser only reads the
  // cached value (safe) the output is "999". If it ever recalculated the
  // formula (the unsafe behaviour the header comment disclaims) the output
  // would be "42" instead.
  const ws: XLSX.WorkSheet = {
    A1: { t: "s", v: "Label" },
    B1: { t: "s", v: "Total" },
    A2: { t: "s", v: "Row1" },
    B2: { t: "n", v: 999, f: "SUM(1,41)" },
    "!ref": "A1:B2",
  };
  const parser = new ExcelParser();
  const parsed = await parser.parse(xlsxBuffer(ws));
  assert.equal(parsed.rows[0]["Total"], "999");
});

test("F-04: maxRows caps the number of parsed rows and reports truncated:true", async () => {
  const aoa: string[][] = [["Name"]];
  for (let i = 0; i < 20; i++) aoa.push([`Person ${i}`]);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const parser = new ExcelParser();
  const parsed = await parser.parse(xlsxBuffer(ws), { maxRows: 5 });
  assert.equal(parsed.rows.length, 5);
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.totalRows, 20);
});

test("F-04: a malformed zip (real PK signature, invalid internal structure) surfaces a controlled ImportParseError, never a raw crash", async () => {
  const malformed = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from("not a real ooxml package, just garbage after the zip magic bytes"),
  ]);
  const parser = new ExcelParser();
  await assert.rejects(
    () => parser.parse(malformed),
    (err: unknown) => {
      assert.ok(err instanceof ImportParseError, "expected ImportParseError, not a raw exception");
      assert.match((err as Error).message, /password-protected|could not be read/i);
      return true;
    },
  );
});

test("F-04: registry resolves .xlsx to ExcelParser and .csv to CsvParser, and rejects unknown extensions via ImportParseError", () => {
  assert.equal(getParserForFile("workbook.xlsx").sourceFileType, "xlsx");
  assert.equal(getParserForFile("contacts.csv").sourceFileType, "csv");
  assert.throws(() => getParserForFile("notes.pdf"), ImportParseError);
});
