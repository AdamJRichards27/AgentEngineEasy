import type { ImportSourceFileType } from "@aee/db";
import { detectSourceFileType } from "./parsers/registry";

export const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB
export const MAX_IMPORT_ROWS = 50_000;

// Extensions that can carry macros or are the legacy OLE binary format -
// explicitly rejected rather than attempted. Stage B supports csv/xlsx only;
// this keeps that boundary a named, user-facing decision instead of a
// confusing parser crash.
const REJECTED_EXTENSIONS = [".xlsm", ".xlsb", ".xltm", ".xlam", ".xls", ".xlt"];

const SUSPICIOUS_MIME_TYPES = new Set([
  "application/x-msdownload",
  "application/x-executable",
  "application/x-sh",
  "text/html",
]);

export interface FileValidationOk {
  ok: true;
  sourceFileType: ImportSourceFileType;
}
export interface FileValidationError {
  ok: false;
  error: string;
}
export type FileValidationResult = FileValidationOk | FileValidationError;

export interface UploadedFileLike {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

// Runs BEFORE any parser touches the file. Treats the upload as untrusted
// input end to end: never executes it, only inspects size/extension/magic
// bytes, and always returns a plain user-facing message rather than letting
// a parser throw a raw stack trace up to the client.
export function validateUploadedFile(file: UploadedFileLike): FileValidationResult {
  const lowerName = file.originalname.toLowerCase();

  if (REJECTED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
    return {
      ok: false,
      error:
        "This file type isn't supported yet. Agent Engine currently imports .csv and .xlsx files only - macro-enabled and legacy Excel formats aren't accepted. Save your file as .xlsx or .csv and try again.",
    };
  }

  const sourceFileType = detectSourceFileType(file.originalname);
  if (!sourceFileType) {
    return {
      ok: false,
      error: "Unsupported file type. Agent Engine can currently import CSV (.csv) and Excel (.xlsx) files.",
    };
  }

  if (!file.buffer || file.size === 0) {
    return { ok: false, error: "This file is empty." };
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      error: `This file is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). The maximum supported size is ${Math.round(
        MAX_FILE_SIZE_BYTES / 1024 / 1024,
      )}MB - try splitting it into smaller files.`,
    };
  }

  if (SUSPICIOUS_MIME_TYPES.has(file.mimetype)) {
    return { ok: false, error: "This doesn't look like a valid CSV or Excel file. Please check the file and try again." };
  }

  if (sourceFileType === "xlsx") {
    // A real .xlsx is a zip archive and must start with the "PK" local file
    // header signature. Anything else is a renamed/corrupted file or the
    // legacy password-protected OLE container - fail with a clear message
    // rather than a parser crash several steps later.
    const isZip = file.buffer.length >= 2 && file.buffer[0] === 0x50 && file.buffer[1] === 0x4b;
    if (!isZip) {
      return {
        ok: false,
        error:
          "This .xlsx file couldn't be read. It may be password-protected, an older .xls file renamed to .xlsx, or corrupted. Remove any password, re-save as .xlsx from Excel, and try again.",
      };
    }
  }

  return { ok: true, sourceFileType };
}
