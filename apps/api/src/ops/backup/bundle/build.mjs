#!/usr/bin/env node
// WS4-13: builds the stamped drill/operator bundles backup-backup.mjs, backup-restore.mjs and backup-sweep.mjs.
//
//   node apps/api/src/ops/backup/bundle/build.mjs --out=<dir>       build from a CLEAN checkout (refuses a dirty one)
//   node apps/api/src/ops/backup/bundle/build.mjs --print-digest    print the source digest of this checkout, build nothing
//   --allow-dirty-for-tests                                          tests only; stamps commit "<sha>-dirty", BUILD.json dirty=true
//
// Same esbuild options as the R27 bundle (BUILD.txt): cwd apps/api, --bundle --platform=node --format=esm --target=node24,
// createRequire banner, no externals. Added: --metafile (input list) and --define:__AEE_BACKUP_BUILD_STAMP__=<stamp>.
// The stamp's digest covers the union of all three bundles' inputs, so one expected value (BACKUP_CLI_EXPECTED_DIGEST)
// serves all three. Writes <out>/SHA256SUMS (sha256sum -c format) and <out>/BUILD.json.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "../../../..");
const repoRoot = path.resolve(apiRoot, "../..");
const ENTRIES = ["backup", "restore", "sweep"];
const BANNER = "import {createRequire as __cr} from 'module'; const require = __cr(import.meta.url);";

const argv = process.argv.slice(2);
const known = /^(?:--out=.+|--print-digest|--allow-dirty-for-tests)$/;
const bad = argv.find((a) => !known.test(a));
const fail = (msg, code = 64) => { process.stderr.write(`bundle-build: ${msg}\n`); process.exit(code); };
if (bad) fail(`unknown argument ${JSON.stringify(bad)}`);
const outArg = argv.find((a) => a.startsWith("--out="))?.slice(6);
const printOnly = argv.includes("--print-digest");
const allowDirty = argv.includes("--allow-dirty-for-tests");
if (!printOnly && !outArg) fail("--out=<dir> or --print-digest is required");

const git = (...args) => execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain", "--untracked-files=all") !== "";
if (dirty && !printOnly && !allowDirty) fail("working tree is dirty; commit or stash first so the stamp names a real commit", 65);

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const options = (entry) => ({
  absWorkingDir: apiRoot,
  entryPoints: [`src/ops/backup/${entry}.ts`],
  bundle: true, platform: "node", format: "esm", target: "node24",
  banner: { js: BANNER }, logLevel: "warning", metafile: true,
});
// esbuild lists virtual modules such as "<define:...>" in the metafile; they are not files.
const isVirtual = (p) => p.startsWith("<");
const toRepoPath = (p) => path.relative(repoRoot, path.resolve(apiRoot, p)).split(path.sep).join("/");

async function collectInputs() {
  const all = new Set();
  for (const entry of ENTRIES) {
    const r = await esbuild.build({ ...options(entry), write: false, outfile: `/dev/null/${entry}.mjs` });
    for (const p of Object.keys(r.metafile.inputs)) if (!isVirtual(p)) all.add(toRepoPath(p));
  }
  // The build script itself is an input: changing the esbuild options changes the digest.
  all.add(path.relative(repoRoot, fileURLToPath(import.meta.url)).split(path.sep).join("/"));
  const inputs = [];
  for (const p of [...all].sort()) {
    if (p.startsWith("../") || path.isAbsolute(p)) fail(`input outside the repository: ${p}`, 70);
    inputs.push({ path: p, sha256: sha256(await readFile(path.join(repoRoot, p))) });
  }
  return inputs;
}
const digestOf = (inputs) => sha256([...inputs].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((i) => `${i.sha256}  ${i.path}\n`).join(""));

const inputs = await collectInputs();
const digest = digestOf(inputs);
if (printOnly) { process.stdout.write(`${digest}\n`); process.exit(0); }

const out = path.resolve(outArg);
await mkdir(out, { recursive: true });
// builtAt = the commit's committer date (not wall-clock), so rebuilding the same commit gives byte-identical bundles.
const builtAt = new Date(git("log", "-1", "--format=%cI", "HEAD")).toISOString();
const stamp = { schema: 1, commit: dirty ? `${commit}-dirty` : commit, inputs, digest, esbuild: esbuild.version, builtAt };
const files = {};
for (const entry of ENTRIES) {
  const name = `backup-${entry}.mjs`;
  const r = await esbuild.build({ ...options(entry), outfile: path.join(out, name), define: { __AEE_BACKUP_BUILD_STAMP__: JSON.stringify(stamp) } });
  for (const p of Object.keys(r.metafile.inputs).filter((q) => !isVirtual(q))) {
    if (!inputs.some((i) => i.path === toRepoPath(p))) fail(`stamped build of ${name} read an unstamped input ${toRepoPath(p)}`, 70);
  }
  const body = await readFile(path.join(out, name));
  if (!body.includes(digest)) fail(`${name} does not embed the stamp (define not applied)`, 70);
  files[name] = sha256(body);
}
await writeFile(path.join(out, "SHA256SUMS"), Object.entries(files).map(([n, h]) => `${h}  ${n}\n`).join(""));
await writeFile(path.join(out, "BUILD.json"), JSON.stringify({ commit, dirty, digest, esbuild: esbuild.version, node: process.version, builtAt: stamp.builtAt, files, inputs }, null, 2) + "\n");
process.stdout.write(JSON.stringify({ event: "bundle_built", commit, dirty, digest, files }) + "\n");
