import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CURRENT_PRIVACY_VERSION,
  CURRENT_TERMS_VERSION,
  __resetLegalArtifactReaderForTesting,
  __setLegalArtifactReaderForTesting,
  assertApprovedLegalVersionsConfigured,
  getActiveLegalDocuments,
  getActiveLegalVersions,
} from "../legalVersions.js";
import { createHash } from "node:crypto";
import { afterEach } from "node:test";

afterEach(() => __resetLegalArtifactReaderForTesting());

async function withLegalEnv(
  values: Record<string, string | undefined>,
  run: () => void | Promise<void>,
): Promise<void> {
  const original = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("draft legal versions are available only outside production and are never marked approved", async () => {
  await withLegalEnv({ NODE_ENV: "test" }, () => {
    assert.deepEqual(getActiveLegalVersions(), {
      termsVersion: CURRENT_TERMS_VERSION,
      privacyVersion: CURRENT_PRIVACY_VERSION,
      approved: false,
    });
  });
});

test("production fails closed when approval is absent, partial, implicit, or names a draft", async () => {
  const cases = [
    {},
    { LEGAL_DOCUMENTS_APPROVED: "true" },
    { APPROVED_TERMS_ARTIFACT_PATH: "terms" },
    { APPROVED_TERMS_SHA256: "a".repeat(64), APPROVED_PRIVACY_SHA256: "b".repeat(64) },
  ];
  for (const values of cases) {
    await withLegalEnv(
      {
        NODE_ENV: "production",
        LEGAL_DOCUMENTS_APPROVED: undefined,
        APPROVED_TERMS_ARTIFACT_PATH: undefined,
        APPROVED_PRIVACY_ARTIFACT_PATH: undefined,
        APPROVED_TERMS_SHA256: undefined,
        APPROVED_PRIVACY_SHA256: undefined,
        ...values,
      },
      () => {
        assert.throws(() => assertApprovedLegalVersionsConfigured());
      },
    );
  }
});

test("production accepts only explicitly approved SHA-256-bound non-draft artifacts", async () => {
  const terms = Buffer.from("Approved Terms\n");
  const privacy = Buffer.from("Approved Privacy\n");
  const termsHash = createHash("sha256").update(terms).digest("hex");
  const privacyHash = createHash("sha256").update(privacy).digest("hex");
  __setLegalArtifactReaderForTesting((path) => {
    if (path === "terms-fixture") return terms;
    if (path === "privacy-fixture") return privacy;
    throw new Error("not found");
  });
  await withLegalEnv(
    {
      NODE_ENV: "production",
      LEGAL_DOCUMENTS_APPROVED: "true",
      APPROVED_TERMS_ARTIFACT_PATH: "terms-fixture",
      APPROVED_PRIVACY_ARTIFACT_PATH: "privacy-fixture",
      APPROVED_TERMS_SHA256: termsHash,
      APPROVED_PRIVACY_SHA256: privacyHash,
    },
    () => {
      assert.deepEqual(getActiveLegalVersions(), {
        termsVersion: `sha256:${termsHash}`,
        privacyVersion: `sha256:${privacyHash}`,
        approved: true,
      });
      assert.deepEqual(getActiveLegalDocuments(), {
        termsVersion: `sha256:${termsHash}`,
        privacyVersion: `sha256:${privacyHash}`,
        approved: true,
        termsContent: terms.toString("utf8"),
        privacyContent: privacy.toString("utf8"),
      });
      assert.doesNotThrow(() => assertApprovedLegalVersionsConfigured());
    },
  );
});

test("production rejects mismatched hashes and draft content even when approval is explicitly enabled", async () => {
  const draft = Buffer.from("DRAFT — LEGAL REVIEW REQUIRED\n");
  const approved = Buffer.from("Approved Privacy\n");
  __setLegalArtifactReaderForTesting((path) => (path === "terms" ? draft : approved));
  await withLegalEnv(
    {
      NODE_ENV: "production",
      LEGAL_DOCUMENTS_APPROVED: "true",
      APPROVED_TERMS_ARTIFACT_PATH: "terms",
      APPROVED_PRIVACY_ARTIFACT_PATH: "privacy",
      APPROVED_TERMS_SHA256: createHash("sha256").update(draft).digest("hex"),
      APPROVED_PRIVACY_SHA256: createHash("sha256").update(approved).digest("hex"),
    },
    () => assert.throws(() => getActiveLegalVersions(), /draft/),
  );
  await withLegalEnv(
    {
      NODE_ENV: "production",
      LEGAL_DOCUMENTS_APPROVED: "true",
      APPROVED_TERMS_ARTIFACT_PATH: "terms",
      APPROVED_PRIVACY_ARTIFACT_PATH: "privacy",
      APPROVED_TERMS_SHA256: "0".repeat(64),
      APPROVED_PRIVACY_SHA256: createHash("sha256").update(approved).digest("hex"),
    },
    () => assert.throws(() => getActiveLegalVersions(), /hash does not match/),
  );
});