import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checksumPath = resolve(root, "vendor/xlsx-0.20.3.tgz.sha512");
const checksumRecord = (await readFile(checksumPath, "utf8")).trim();
const match = checksumRecord.match(/^([a-f0-9]{128}) {2}(.+)$/);

if (!match) {
  throw new Error(`Invalid SHA-512 record: ${checksumPath}`);
}

const [, expected, relativeArchivePath] = match;
const archivePath = resolve(dirname(checksumPath), relativeArchivePath);
const actual = createHash("sha512").update(await readFile(archivePath)).digest("hex");

if (actual !== expected) {
  throw new Error(
    `Vendored dependency checksum mismatch for ${basename(archivePath)}: expected ${expected}, received ${actual}`,
  );
}

console.log(`Verified ${basename(archivePath)} (SHA-512 ${actual})`);