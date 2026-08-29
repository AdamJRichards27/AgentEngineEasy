import { parse } from "csv-parse/sync";
import type { ImportSourceParser, ParsedImportFile, ParseOptions } from "./types";
import { ImportParseError } from "./types";

const DEFAULT_MAX_ROWS = 50_000;

// Wraps csv-parse rather than hand-rolling quoting/escaping/embedded-newline
// handling, which is easy to get subtly wrong against real spreadsheet
// exports. Treats the file strictly as data - no formula or macro concept
// exists for CSV, so there is nothing to execute.
export class CsvParser implements ImportSourceParser {
  readonly sourceFileType = "csv" as const;

  async parse(buffer: Buffer, opts: ParseOptions = {}): Promise<ParsedImportFile> {
    const maxRows = opts.maxRows ?? DEFAULT_MAX_ROWS;
    let text = buffer.toString("utf-8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM (common from Excel "Save As CSV")

    if (text.trim().length === 0) {
      throw new ImportParseError("This file is empty.");
    }

    let records: string[][];
    try {
      records = parse(text, {
        skip_empty_lines: true,
        relax_column_count: true,
        trim: false,
      }) as string[][];
    } catch (err) {
      const detail = err instanceof Error ? err.message : "malformed content";
      throw new ImportParseError(
        `This CSV file could not be read (${detail}). Check it opens correctly in a spreadsheet program and try again.`,
      );
    }

    if (records.length === 0) {
      throw new ImportParseError("This file has no rows.");
    }

    const headers = records[0].map((h, i) => (h && h.trim().length > 0 ? h.trim() : `Column ${i + 1}`));
    const dataRows = records.slice(1).filter((row) => row.some((cell) => (cell ?? "").trim().length > 0));
    const truncated = dataRows.length > maxRows;
    const limited = truncated ? dataRows.slice(0, maxRows) : dataRows;

    const rows = limited.map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((h, i) => {
        obj[h] = (row[i] ?? "").toString().trim();
      });
      return obj;
    });

    return { headers, rows, totalRows: dataRows.length, truncated };
  }
}
