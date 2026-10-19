// WS4-06: pg_dump archive format version vs the pg_restore client.
//
// A custom-format archive (`pg_dump --format=custom`, the only format this tool writes) starts with the 5-byte
// magic "PGDMP" followed by the archive version bytes major, minor, rev. pg_restore can read any archive up to its own
// K_VERS_MAX = MAKE_ARCHIVE_VERSION(1, <K_VERS_MINOR>, 255) (src/bin/pg_dump/pg_backup_archiver.h), so only the
// major and minor matter. Per PostgreSQL release: 12-15 write/read 1.14 (tableam), 16 -> 1.15 (compression
// algorithm in header), 17 and 18 -> 1.16 (BLOB METADATA). A newer archive than the client can read makes
// pg_restore abort with "unsupported version (1.x) in file header", so we refuse first, with exit 69 (PREFLIGHT:
// tool incompatible), naming both versions. Unknown clients or unreadable headers fail closed.

import { open } from "node:fs/promises";

const MAGIC = Buffer.from("PGDMP");

/** Highest archive MINOR (of major 1) each pg_restore major can read. Extend when a new PostgreSQL major ships. */
const MAX_MINOR_BY_PG_RESTORE_MAJOR: Readonly<Record<number, number>> = {
  12: 14, 13: 14, 14: 14, 15: 14, 16: 15, 17: 16, 18: 16,
};

export function maxReadableArchiveMinor(pgRestoreMajor: number): number | undefined {
  return MAX_MINOR_BY_PG_RESTORE_MAJOR[pgRestoreMajor];
}

export type ArchiveVersionSource = "manifest" | "header";

export class DumpArchiveIncompatibleError extends Error {
  readonly tool = "pg_restore";
  constructor(readonly found: string, readonly required: string, readonly source: ArchiveVersionSource) {
    super(`Dump archive is not readable by this pg_restore (${source}): found ${found}, required ${required}`);
  }
}

/** "1.15.0" for a custom-format header, else null. */
export function parseCustomDumpHeader(bytes: Buffer): string | null {
  if (bytes.length < MAGIC.length + 3 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  const [major, minor, rev] = [bytes[5]!, bytes[6]!, bytes[7]!];
  return `${major}.${minor}.${rev}`;
}

/** Reads only the first bytes of the dump file. null when it is not a custom-format archive (or unreadable). */
export async function readDumpArchiveVersion(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseCustomDumpHeader(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Throws DumpArchiveIncompatibleError unless pg_restore <pgRestoreMajor> can read archive <archiveVersion>. */
export function assertArchiveReadable(archiveVersion: string, pgRestoreMajor: number, source: ArchiveVersionSource): void {
  const maxMinor = maxReadableArchiveMinor(pgRestoreMajor);
  const required = maxMinor === undefined ? `a known pg_restore major (12-18), got ${pgRestoreMajor}` : `archive<=1.${maxMinor} (pg_restore ${pgRestoreMajor})`;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(archiveVersion);
  if (!match) throw new DumpArchiveIncompatibleError(`archive ${archiveVersion}`.slice(0, 40), required, source);
  const [major, minor] = [Number(match[1]), Number(match[2])];
  if (maxMinor === undefined || major !== 1 || minor > maxMinor) {
    throw new DumpArchiveIncompatibleError(`archive ${archiveVersion}`, required, source);
  }
}
