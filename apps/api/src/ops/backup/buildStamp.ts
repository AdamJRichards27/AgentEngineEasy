import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * WS4-13 build stamp for the bundled backup / restore / sweep CLIs (built by bundle/build.mjs).
 *
 * The bundler embeds a stamp: the source commit plus the repo-relative path and sha256 of every source file that
 * went into the bundle, and `digest` = sha256 over the sorted "<sha256>  <path>\n" lines (sha256sum format). At start
 * the CLI compares that digest against an expectation the operator supplies, and refuses to run if it does not match:
 *
 * - BACKUP_CLI_EXPECTED_DIGEST=<64 lowercase hex>: the digest recorded in the runbook / the bundle's BUILD.json.
 * - BACKUP_CLI_SOURCE_ROOT=<absolute path to a checkout>: rehash the stamped files in that checkout; any changed or
 *   missing file means the bundle is stale relative to that source.
 *
 * Fail closed: a bundle with no stamp, a stamp whose digest does not match its own input list, or a mismatch refuses
 * with exit 69 (incompatible tool, CLI-SPEC); no expectation, both set, or a malformed value refuses with exit 78
 * (config). Running from source (tsx, entry file ends in .ts) is not a bundle and is not checked.
 * The digest depends only on the bundled sources, so a rebuild at a later commit that did not touch them keeps it.
 */
export const BUILD_STAMP_EXPECTED_DIGEST_ENV = "BACKUP_CLI_EXPECTED_DIGEST";
export const BUILD_STAMP_SOURCE_ROOT_ENV = "BACKUP_CLI_SOURCE_ROOT";

export interface BuildStampInput {
  /** Repo-root-relative POSIX path. */
  path: string;
  sha256: string;
}
export interface BuildStamp {
  schema: 1;
  /** Source commit (`<sha>-dirty` only for --allow-dirty-for-tests builds). */
  commit: string;
  inputs: BuildStampInput[];
  digest: string;
  esbuild: string;
  /** Committer date of `commit` (deterministic: same commit, same bytes). */
  builtAt: string;
}

export type BuildStampErrorKind = "unstamped" | "inconsistent" | "stale" | "config";
export class BuildStampError extends Error {
  readonly exitCode: 69 | 78;
  constructor(readonly kind: BuildStampErrorKind, message: string, readonly found = "", readonly required = "") {
    super(message);
    this.exitCode = kind === "config" ? 78 : 69;
  }
}

export type BuildStampResult = { status: "source" } | { status: "ok"; digest: string; via: "expected_digest" | "source_root" };

const HEX64 = /^[0-9a-f]{64}$/;

export function computeInputsDigest(inputs: readonly BuildStampInput[]): string {
  const lines = [...inputs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((i) => `${i.sha256}  ${i.path}\n`);
  return createHash("sha256").update(lines.join("")).digest("hex");
}

declare const __AEE_BACKUP_BUILD_STAMP__: BuildStamp | undefined;
/** The stamp embedded by bundle/build.mjs (esbuild --define); undefined when running from source or an unstamped build. */
export const EMBEDDED_BUILD_STAMP: BuildStamp | undefined =
  typeof __AEE_BACKUP_BUILD_STAMP__ === "undefined" ? undefined : __AEE_BACKUP_BUILD_STAMP__;

function safeRelative(p: unknown): p is string {
  return typeof p === "string" && p.length > 0 && !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes("..") && !p.includes("\0");
}

function assertConsistent(stamp: BuildStamp): void {
  const ok = stamp && stamp.schema === 1 && Array.isArray(stamp.inputs) && stamp.inputs.length > 0
    && stamp.inputs.every((i) => safeRelative(i?.path) && typeof i.sha256 === "string" && HEX64.test(i.sha256))
    && new Set(stamp.inputs.map((i) => i.path)).size === stamp.inputs.length
    && typeof stamp.digest === "string" && HEX64.test(stamp.digest) && computeInputsDigest(stamp.inputs) === stamp.digest;
  if (!ok) throw new BuildStampError("inconsistent", "Embedded build stamp is malformed or its digest does not match its own input list; rebuild with bundle/build.mjs", String(stamp?.digest ?? "").slice(0, 64), "a consistent schema-1 stamp");
}

export function checkBuildStamp(input: { stamp: BuildStamp | undefined; entryUrl: string; env: Record<string, string | undefined> }): BuildStampResult {
  const { stamp, env } = input;
  if (stamp === undefined) {
    if (/\.ts$/.test(new URL(input.entryUrl).pathname)) return { status: "source" };
    throw new BuildStampError("unstamped", "This bundled CLI has no build stamp; rebuild it with apps/api/src/ops/backup/bundle/build.mjs", "no stamp", "a stamped bundle");
  }
  assertConsistent(stamp);
  const expected = env[BUILD_STAMP_EXPECTED_DIGEST_ENV];
  const root = env[BUILD_STAMP_SOURCE_ROOT_ENV];
  if (expected !== undefined && root !== undefined) {
    throw new BuildStampError("config", `Set exactly one of ${BUILD_STAMP_EXPECTED_DIGEST_ENV} or ${BUILD_STAMP_SOURCE_ROOT_ENV}, not both`);
  }
  if (expected !== undefined) {
    if (!HEX64.test(expected)) throw new BuildStampError("config", `${BUILD_STAMP_EXPECTED_DIGEST_ENV} must be 64 lowercase hex characters`);
    if (expected !== stamp.digest) {
      throw new BuildStampError("stale", `Bundled CLI is stale: its source digest does not match ${BUILD_STAMP_EXPECTED_DIGEST_ENV}; rebuild from the expected commit`, stamp.digest, expected);
    }
    return { status: "ok", digest: stamp.digest, via: "expected_digest" };
  }
  if (root !== undefined) {
    let isDir = false;
    try { isDir = path.isAbsolute(root) && statSync(root).isDirectory(); } catch { isDir = false; }
    if (!isDir) throw new BuildStampError("config", `${BUILD_STAMP_SOURCE_ROOT_ENV} must be an absolute path to an existing source checkout`);
    const changed: string[] = [];
    for (const item of stamp.inputs) {
      let hash: string | undefined;
      try { hash = createHash("sha256").update(readFileSync(path.join(root, item.path))).digest("hex"); } catch { hash = undefined; }
      if (hash !== item.sha256) changed.push(`${item.path}${hash === undefined ? " (missing)" : ""}`);
    }
    if (changed.length) {
      throw new BuildStampError("stale", `Bundled CLI is stale relative to ${BUILD_STAMP_SOURCE_ROOT_ENV}: ${changed.length} source file(s) differ: ${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", ..." : ""}`, stamp.digest, `sources at ${BUILD_STAMP_SOURCE_ROOT_ENV}`);
    }
    return { status: "ok", digest: stamp.digest, via: "source_root" };
  }
  throw new BuildStampError("config", `A bundled CLI needs ${BUILD_STAMP_EXPECTED_DIGEST_ENV} (digest from the runbook / BUILD.json) or ${BUILD_STAMP_SOURCE_ROOT_ENV} (source checkout) to prove it is current`, stamp.digest, "an expectation");
}
