import * as XLSX from "xlsx";
import type { ImportSourceParser, ParsedImportFile, ParseOptions } from "./types";
import { ImportParseError } from "./types";

const DEFAULT_MAX_ROWS = 50_000;

// SheetJS's community build is a pure data reader - it does not evaluate
// formulas as code and does not execute VBA macros (macro bytecode, if
// present, is left as an opaque, unparsed blob). We additionally never
// request formula recalculation, so nothing in this file executes anything
// from the workbook.
export class ExcelParser implements ImportSourceParser {
  readonly sourceFileType = "xlsx" as const;

  async parse(buffer: Buffer, opts: ParseOptions = {}): Promise<ParsedImportFile> {
    const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;

    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(buffer, { type: "buffer" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : "unknown error";
      if (/password|encrypt/i.test(detail)) {
        throw new ImportParseError("This spreadsheet is password-protected. Remove the password in Excel and try again.");
      }
      throw new ImportParseError(
        `This spreadsheet could not be read (${detail}). It may be corrupted, password-protected, or not a real .xlsx file - re-save it from Excel and try again.`,
      );
    }

    const sheetNames = workbook.SheetNames;
    if (!sheetNames || sheetNames.length === 0) {
      throw new ImportParseError("This spreadsheet has no sheets.");
    }

    const sheetName = opts.sheetName && sheetNames.includes(opts.sheetName) ? opts.sheetName : sheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: "",
      blankrows: false,
    });

    if (json.length === 0) {
      throw new ImportParseError(`Sheet "${sheetName}" has no rows.`);
    }

    const headerRow = json[0];
    const headers = headerRow.map((h, i) => {
      const s = h == null ? "" : String(h).trim();
      return s.length > 0 ? s : `Column ${i + 1}`;
    });

    const dataRows = json.slice(1);
    const truncated = dataRows.length > maxRows;
    const limited = truncated ? dataRows.slice(0, maxRows) : dataRows;

    const rows = limited.map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        const v = row[i];
        obj[h] = v == null ? "" : String(v).trim();
      });
      return obj;
    });

    return { headers, rows, sheetNames, totalRows: dataRows.length, truncated };
  }
}
