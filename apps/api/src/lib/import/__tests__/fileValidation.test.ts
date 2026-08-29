// F-04: fileValidation.ts is the sole compensating control gate that runs
// BEFORE any buffer reaches XLSX.read() (see pipeline.ts:80, called ahead of
// getParserForFile/parser.parse() at pipeline.ts:83-84). xlsx@0.18.5 carries
// two HIGH-severity advisories (ReDoS + Prototype Pollution) with no patched
// version published to the npm registry (`pnpm audit` shows
// "Patched versions: <0.0.0" for both). These tests prove each compensating
// control actually rejects the class of input it claims to reject, so the
// fail-closed gate in front of the vulnerable parser is verified, not just
// asserted in a comment.
import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";
import {
  validateUploadedFile,
  MAX_FILE_SIZE_BYTES,
  type UploadedFileLike,
} from "../fileValidation.js";
import { detectSourceFileType } from "../parsers/registry.js";

function file(overrides: Partial<UploadedFileLike>): UploadedFileLike {
  return {
    originalname: "import.xlsx",
    mimetype: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size: 1024,
    buffer: Buffer.from("PK\x03\x04placeholder"),
    ...overrides,
  };
}

function realXlsxBuffer(): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["First Name", "Last Name", "Email"],
    ["Jane", "Smith", "jane@example.com"],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

test("F-04: rejects a file with no buffer / zero size", () => {
  const result = validateUploadedFile(
    file({ buffer: Buffer.alloc(0), size: 0 }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /empty/i);
});

test("F-04: rejects a file larger than MAX_FILE_SIZE_BYTES without ever needing to read the whole buffer", () => {
  // `size` is checked independently of buffer length, so this proves the
  // cap is enforced without allocating a real 25MB+ buffer in the test.
  const result = validateUploadedFile(
    file({ size: MAX_FILE_SIZE_BYTES + 1 }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /too large/i);
});

test("F-04: rejects every macro-capable / legacy Excel extension by name, before content is inspected", () => {
  const rejected = [".xlsm", ".xlsb", ".xltm", ".xlam", ".xls", ".xlt"];
  for (const ext of rejected) {
    const result = validateUploadedFile(
      file({ originalname: `workbook${ext}`, buffer: realXlsxBuffer() }),
    );
    assert.equal(result.ok, false, `expected ${ext} to be rejected`);
    if (!result.ok) assert.match(result.error, /not supported|macro-enabled|legacy/i);
  }
});

test("F-04: rejects known-suspicious MIME types regardless of extension", () => {
  const suspicious = [
    "application/x-msdownload",
    "application/x-executable",
    "application/x-sh",
    "text/html",
  ];
  for (const mimetype of suspicious) {
    const result = validateUploadedFile(file({ mimetype }));
    assert.equal(result.ok, false, `expected ${mimetype} to be rejected`);
    if (!result.ok) assert.match(result.error, /doesn't look like a valid/i);
  }
});

test("F-04: rejects a file named .xlsx whose buffer is not a real zip, before XLSX.read() ever runs", () => {
  const result = validateUploadedFile(
    file({ buffer: Buffer.from("this is not a zip file at all") }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /couldn't be read/i);
});

test("F-04: accepts a genuine .xlsx file (real zip/PK signature) and resolves sourceFileType", () => {
  const result = validateUploadedFile(
    file({ buffer: realXlsxBuffer(), size: realXlsxBuffer().length }),
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.sourceFileType, "xlsx");
});

test("F-04: extension detection is case-insensitive (bypassing the gate by casing does not work)", () => {
  assert.equal(detectSourceFileType("REPORT.XLSX"), "xlsx");
  assert.equal(detectSourceFileType("Contacts.Csv"), "csv");
});

test("F-04: rejects an unsupported extension before any parser is selected", () => {
  const result = validateUploadedFile(
    file({ originalname: "notes.txt", mimetype: "text/plain", buffer: Buffer.from("hello") }),
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /unsupported/i);
});

test("F-04: a genuine .csv file is never subjected to the xlsx zip-signature check", () => {
  const csvBuffer = Buffer.from("First Name,Last Name\nJane,Smith\n", "utf-8");
  const result = validateUploadedFile(
    file({
      originalname: "contacts.csv",
      mimetype: "text/csv",
      buffer: csvBuffer,
      size: csvBuffer.length,
    }),
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.sourceFileType, "csv");
});
