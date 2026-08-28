import type { ImportSourceFileType } from "@aee/db";
import type { ImportSourceParser } from "./types";
import { ImportParseError } from "./types";
import { CsvParser } from "./csvParser";
import { ExcelParser } from "./excelParser";

// Pluggable registry - a future JSON/XML/vCard/CRM-export adapter registers
// here and nowhere else needs to change.
const PARSERS: Record<ImportSourceFileType, ImportSourceParser> = {
  csv: new CsvParser(),
  xlsx: new ExcelParser(),
};

const EXTENSION_TO_TYPE: Record<string, ImportSourceFileType> = {
  ".csv": "csv",
  ".xlsx": "xlsx",
};

export function detectSourceFileType(filename: string): ImportSourceFileType | null {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return null;
  const ext = filename.slice(dot).toLowerCase();
  return EXTENSION_TO_TYPE[ext] ?? null;
}

export function getParserForFile(filename: string): ImportSourceParser {
  const type = detectSourceFileType(filename);
  if (!type) {
    throw new ImportParseError(
      "Unsupported file type. Agent Engine can currently import CSV (.csv) and Excel (.xlsx) files.",
    );
  }
  return PARSERS[type];
}
