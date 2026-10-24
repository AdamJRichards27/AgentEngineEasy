import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { promisify } from "node:util";
import { EXIT_CODES, classify } from "../verifiers/verifyDeleteMc.mjs";

// PH-7 R19 / D-9: classification of the version-aware verifier. Unit cases use fixtures (including what MinIO cannot
// produce); MinIO integration cases run only when D9_MINIO_MC and D9_MINIO_ALIAS point at a disposable local MinIO.
const NOW = new Date("2026-06-01T00:00:00Z");
const FUTURE = "2026-06-02T00:00:00Z";
const PAST = "2026-05-01T00:00:00Z";
const ver = (id: string) => ({ versionId: id, isDeleteMarker: false });
const marker = (id: string) => ({ versionId: id, isDeleteMarker: true });
const ok = (extra: object = {}) => ({ status: "ok" as const, mode: null, legalHold: false, ...extra });
const c = (listing: any, locks: any = {}) => classify({ listing, locks, now: NOW });

test("VC1 absent: complete empty listing is the ONLY verified class", () => {
  const r = c({ complete: true, entries: [] });
  assert.equal(r.class, "absent"); assert.equal(r.verified, true); assert.equal(r.exitCode, 0);
  const others = [
    c({ complete: true, entries: [marker("m1")] }),
    c({ complete: true, entries: [ver("v1")] }, { v1: ok() }),
    c({ complete: true, entries: [ver("v1")] }, { v1: ok({ mode: "GOVERNANCE", until: FUTURE }) }),
    c({ complete: true, entries: [ver("v1")] }, { v1: ok({ mode: "COMPLIANCE", until: FUTURE }) }),
    c({ complete: false, entries: [] }), c({ complete: true, error: { message: "AccessDenied" }, entries: [] } as any), c(undefined), c({ complete: true } as any),
  ];
  for (const o of others) { assert.equal(o.verified, false); assert.notEqual(o.exitCode, 0); assert.notEqual(o.class, "absent"); }
});

test("VC2 delete marker hides retained older versions", () => {
  const r = c({ complete: true, entries: [marker("m1"), ver("v1")] }, { v1: ok() });
  assert.equal(r.class, "delete_marker_retained"); assert.equal(r.exitCode, EXIT_CODES.delete_marker_retained); assert.equal(r.verified, false);
  assert.equal(c({ complete: true, entries: [marker("m1")] }).class, "delete_marker_retained", "a lone delete marker is also not absent");
});

test("VC3 governance-locked version (even with a delete marker on top)", () => {
  const r = c({ complete: true, entries: [marker("m1"), ver("v1")] }, { v1: ok({ mode: "GOVERNANCE", until: FUTURE }) });
  assert.equal(r.class, "governance_locked"); assert.equal(r.exitCode, 12); assert.equal(r.verified, false);
});

test("VC4 compliance-locked version outranks governance", () => {
  const r = c({ complete: true, entries: [ver("v1"), ver("v2")] }, { v1: ok({ mode: "GOVERNANCE", until: FUTURE }), v2: ok({ mode: "COMPLIANCE", until: FUTURE }) });
  assert.equal(r.class, "compliance_locked"); assert.equal(r.exitCode, 13);
});

test("VC4b an expired lock no longer blocks, but the retained version still is not absent", () => {
  const r = c({ complete: true, entries: [ver("v1")] }, { v1: ok({ mode: "COMPLIANCE", until: PAST }) });
  assert.equal(r.class, "versions_retained"); assert.equal(r.verified, false);
  assert.equal(c({ complete: true, entries: [ver("v1")] }, { v1: ok({ legalHold: true }) }).class, "versions_retained");
});

test("VC5 permission denied or incomplete (truncated) listing is never absent", () => {
  assert.equal(c({ complete: true, error: { message: "mc: <ERROR> AccessDenied: Access Denied" }, entries: [] }).class, "access_denied_or_incomplete");
  assert.equal(c({ complete: false, entries: [] }).class, "access_denied_or_incomplete");
  assert.equal(c({ complete: false, entries: [ver("v1")] }).class, "access_denied_or_incomplete", "truncated listing that happens to show an entry is still incomplete");
  assert.equal(c({ complete: true, entries: [ver("v1")] }, { v1: { status: "denied" } }).class, "access_denied_or_incomplete");
});

test("VC6 inconclusive provider responses", () => {
  assert.equal(c({ complete: true, error: { message: "InternalError 500" }, entries: [] }).class, "inconclusive");
  assert.equal(c({ complete: true, entries: [ver("v1")] }, { v1: { status: "error", message: "weird" } }).class, "inconclusive");
  assert.equal(c({ complete: true, entries: [ver("v1")] }, {}).class, "inconclusive", "missing lock state");
  assert.equal(c({ complete: true, entries: [ver("v1")] }, { v1: ok({ mode: "WEIRD", until: FUTURE }) }).class, "inconclusive");
  assert.equal(c({ complete: true, entries: [ver("v1")] }, { v1: ok({ mode: "GOVERNANCE", until: "garbage" }) }).class, "inconclusive");
});

// ---- MinIO integration (disposable local fixture only) ----
const MC = process.env.D9_MINIO_MC;
const ALIAS = process.env.D9_MINIO_ALIAS;
const itMinio = MC && ALIAS ? test : test.skip;
const ADAPTER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../verifiers/verifyDeleteMc.mjs");
const sh = promisify(execFile);
async function verify(remote: string): Promise<{ code: number; out: any; stderr: string }> {
  try {
    const r = await sh(process.execPath, [ADAPTER, "--mc", MC!, "--alias", ALIAS!, remote]);
    return { code: 0, out: JSON.parse(r.stdout), stderr: r.stderr };
  } catch (e: any) { return { code: e.code, out: e.stdout ? JSON.parse(e.stdout) : null, stderr: String(e.stderr) }; }
}
const mc = (...a: string[]) => sh(MC!, ["--quiet", ...a]);
const suffix = Date.now().toString(36);

itMinio("VM1 MinIO fixtures: every class the server can produce is classified and only absent verifies", async () => {
  const put = async (b: string, k: string) => { await sh("bash", ["-c", `echo data-${k} | ${MC} --quiet pipe ${ALIAS}/${b}/${k}`]); };
  const vers = `d9v-${suffix}`, gov = `d9g-${suffix}`, comp = `d9c-${suffix}`, plain = `d9p-${suffix}`;
  await mc("mb", `${ALIAS}/${plain}`);
  await mc("mb", `${ALIAS}/${vers}`); await mc("version", "enable", `${ALIAS}/${vers}`);
  await mc("mb", "--with-lock", `${ALIAS}/${gov}`); await mc("retention", "set", "--default", "GOVERNANCE", "1d", `${ALIAS}/${gov}`);
  await mc("mb", "--with-lock", `${ALIAS}/${comp}`); await mc("retention", "set", "--default", "COMPLIANCE", "1d", `${ALIAS}/${comp}`);
  for (const b of [plain, vers, gov, comp]) { await put(b, "d/a.tar.enc"); await put(b, "d/a.tar.enc.sha256.json"); }
  // object present and never deleted
  assert.equal((await verify(`s3://${plain}/d/a.tar.enc`)).out.class, "versions_retained");
  // genuine delete on an unversioned bucket -> absent (the sibling manifest key with the same prefix must not interfere)
  await mc("rm", `${ALIAS}/${plain}/d/a.tar.enc`);
  const gone = await verify(`s3://${plain}/d/a.tar.enc`);
  assert.deepEqual([gone.code, gone.out.class, gone.out.verified], [0, "absent", true]);
  assert.match(gone.stderr, /verify_class=absent/);
  // never existed
  assert.equal((await verify(`s3://${plain}/d/never.tar.enc`)).out.class, "absent");
  // versioned plain delete -> delete marker, version retained
  await mc("rm", `${ALIAS}/${vers}/d/a.tar.enc`);
  const dm = await verify(`s3://${vers}/d/a.tar.enc`);
  assert.deepEqual([dm.code, dm.out.class, dm.out.verified], [10, "delete_marker_retained", false]);
  // governance / compliance locked (plain delete adds a marker; the locked version survives)
  await mc("rm", `${ALIAS}/${gov}/d/a.tar.enc`);
  assert.deepEqual([(await verify(`s3://${gov}/d/a.tar.enc`)).code, (await verify(`s3://${gov}/d/a.tar.enc`)).out.class], [12, "governance_locked"]);
  await mc("rm", `${ALIAS}/${comp}/d/a.tar.enc`);
  assert.deepEqual([(await verify(`s3://${comp}/d/a.tar.enc`)).code, (await verify(`s3://${comp}/d/a.tar.enc`)).out.class], [13, "compliance_locked"]);
  // explicit version delete on the versioned bucket (marker + version) -> absent
  const listing = JSON.parse("[" + (await mc("ls", "--versions", "--json", `${ALIAS}/${vers}/d/a.tar.enc`)).stdout.trim().split("\n").filter((l) => JSON.parse(l).key === "a.tar.enc").join(",") + "]");
  for (const e of listing) await mc("rm", "--version-id", e.versionId, `${ALIAS}/${vers}/d/a.tar.enc`);
  assert.equal((await verify(`s3://${vers}/d/a.tar.enc`)).out.class, "absent");
  // provider failures: missing bucket and an unreachable endpoint are never absent
  const nb = await verify(`s3://nonexistent-${suffix}/d/a.tar.enc`);
  assert.notEqual(nb.code, 0); assert.equal(nb.out.verified, false);
  // usage error
  const bad = await sh(process.execPath, [ADAPTER, "--alias", ALIAS!, "not-a-uri"]).then(() => 0, (e: any) => e.code);
  assert.equal(bad, 2);
});

itMinio("VM2 MinIO: invalid credentials are classified access_denied_or_incomplete or inconclusive, never absent", async () => {
  const dir = path.join("/tmp", `d9-badcfg-${suffix}`);
  await sh("bash", ["-c", `mkdir -p ${dir} && cp ${process.env.MC_CONFIG_DIR}/config.json ${dir}/config.json && sed -i 's/"secretKey": *"[^"]*"/"secretKey": "wrong-secret-xx"/' ${dir}/config.json`]);
  try {
    await sh(process.execPath, [ADAPTER, "--mc", MC!, "--alias", ALIAS!, `s3://d9v-${suffix}/d/a.tar.enc`], { env: { ...process.env, MC_CONFIG_DIR: dir } });
    assert.fail("verifier must not succeed with bad credentials");
  } catch (e: any) {
    assert.notEqual(e.code, 0);
    assert.ok([20, 30].includes(e.code), `exit ${e.code}`);
    assert.equal(JSON.parse(e.stdout).verified, false);
  }
});
