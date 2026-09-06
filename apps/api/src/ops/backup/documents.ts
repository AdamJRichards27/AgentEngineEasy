import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

async function walk(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.posix.join(relative.split(path.sep).join(path.posix.sep), entry.name);
    const absolute = path.join(root, child);
    if (entry.isSymbolicLink()) throw new Error(`Document archive refuses symbolic link: ${child}`);
    if (entry.isDirectory()) files.push(...(await walk(root, child)));
    else if (entry.isFile()) files.push(child);
  }
  return files.sort();
}

export async function documentInventory(root: string): Promise<string[]> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Document source must be a real directory");
  return walk(root);
}

export function compareDocumentKeys(
  databaseKeys: string[],
  files: string[],
): { missing: string[]; orphaned: string[] } {
  const normalise = (key: string): string => path.posix.normalize(key.replaceAll("\\", "/")).replace(/^\/+/, "");
  const referenced = new Set(databaseKeys.map(normalise));
  const present = new Set(files.map(normalise));
  return {
    missing: [...referenced].filter((key) => !present.has(key)).sort(),
    orphaned: [...present].filter((key) => !referenced.has(key)).sort(),
  };
}

export async function prepareEmptyRestoreDirectory(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true, mode: 0o700 });
}