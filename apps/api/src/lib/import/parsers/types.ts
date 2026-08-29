import type { ImportSourceFileType } from "@aee/db";

// Neutral output of the ingestion layer - every parser produces the same
// shape regardless of source format, so nothing downstream needs to know
// whether the file was a CSV or a spreadsheet.
export interface ParsedImportFile {
  headers: string[];
  rows: Array<Record<string, string>>;
  sheetNames?: string[];
  totalRows: number;
  truncated: boolean; // true if the file exceeded the row cap and was cut off
}

export interface ParseOptions {
  sheetName?: string; // xlsx only - defaults to the first sheet
  maxRows?: number; // safety cap; caller decides the number (see fileValidation.ts)
}

// Pluggable parser interface. Additional formats (JSON, XML, vCard, CRM
// exports) implement this same interface and register in registry.ts -
// nothing else in the import engine needs to change.
export interface ImportSourceParser {
  readonly sourceFileType: ImportSourceFileType;
  parse(buffer: Buffer, opts?: ParseOptions): Promise<ParsedImportFile>;
}

export class ImportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportParseError";
  }
}
