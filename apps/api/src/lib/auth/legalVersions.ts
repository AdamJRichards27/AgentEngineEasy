// Critical Blocker Remediation, Phase 8 — the single source of truth for
// "what version of the Terms of Use / Privacy Policy is currently in
// effect." Bumping these constants is the only correct way to require
// existing users to re-consent to a changed document — see
// docs/legal/PILOT_TERMS_OF_USE.md / PILOT_PRIVACY_POLICY.md, both of
// which are still marked DRAFT — LEGAL REVIEW REQUIRED (see
// docs/legal/LEGAL_APPROVAL_REGISTER.md) and must not be presented to a
// real pilot participant as final until that changes.
//
// Deliberately NOT taken from request input anywhere this is used
// (routes/auth.ts, routes/privacy.ts): the server always stamps consent
// records with ITS OWN idea of the current version, never a
// client-supplied string, so a client cannot claim to have accepted a
// version that was never actually shown to them.
import { isProductionEnvironment } from "../env.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const CURRENT_TERMS_VERSION = "2026-09-06-draft-1";
export const CURRENT_PRIVACY_VERSION = "2026-09-06-draft-1";

export interface ActiveLegalVersions {
  termsVersion: string;
  privacyVersion: string;
  approved: boolean;
}

export interface ActiveLegalDocuments extends ActiveLegalVersions {
  termsContent: string;
  privacyContent: string;
}

type ArtifactReader = (path: string) => Buffer;
let artifactReader: ArtifactReader = readFileSync;

function approvedArtifact(pathVariable: string, hashVariable: string): { content: string; version: string } {
  const path = process.env[pathVariable]?.trim();
  const expectedHash = process.env[hashVariable]?.trim().toLowerCase();
  if (!path || !/^[a-f0-9]{64}$/.test(expectedHash ?? "")) {
    throw new Error(`Production legal document ${pathVariable} and a SHA-256 ${hashVariable} are required.`);
  }
  let bytes: Buffer;
  try {
    bytes = artifactReader(path);
  } catch {
    throw new Error(`Configured production legal document artifact cannot be read: ${pathVariable}.`);
  }
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  if (actualHash !== expectedHash) {
    throw new Error(`Configured production legal document artifact hash does not match ${hashVariable}.`);
  }
  const content = bytes.toString("utf8");
  if (content.includes("DRAFT — LEGAL REVIEW REQUIRED")) {
    throw new Error("Configured production legal document artifact is a draft and cannot be activated.");
  }
  // The digest is the version identity: unlike a deployment label, it is
  // cryptographically bound to the exact bytes presented to the participant.
  return { content, version: `sha256:${actualHash}` };
}

/**
 * Approval is an explicit deployment input, never inferred from a version
 * string or from the presence of the draft files. Draft versions are usable
 * only by local and automated-test environments.
 */
export function getActiveLegalVersions(): ActiveLegalVersions {
  if (!isProductionEnvironment()) {
    return {
      termsVersion: CURRENT_TERMS_VERSION,
      privacyVersion: CURRENT_PRIVACY_VERSION,
      approved: false,
    };
  }

  if (process.env.LEGAL_DOCUMENTS_APPROVED !== "true") {
    throw new Error(
      "Approved active Terms of Use and Privacy Policy versions are required in production. " +
        "Refusing to use draft or implicitly approved legal documents.",
    );
  }
  const terms = approvedArtifact("APPROVED_TERMS_ARTIFACT_PATH", "APPROVED_TERMS_SHA256");
  const privacy = approvedArtifact("APPROVED_PRIVACY_ARTIFACT_PATH", "APPROVED_PRIVACY_SHA256");
  return { termsVersion: terms.version, privacyVersion: privacy.version, approved: true };
}

export function getActiveLegalDocuments(): ActiveLegalDocuments {
  if (!isProductionEnvironment()) {
    return {
      termsVersion: CURRENT_TERMS_VERSION,
      privacyVersion: CURRENT_PRIVACY_VERSION,
      approved: false,
      termsContent: "Draft Terms of Use — local/test only.",
      privacyContent: "Draft Privacy Policy — local/test only.",
    };
  }
  const terms = approvedArtifact("APPROVED_TERMS_ARTIFACT_PATH", "APPROVED_TERMS_SHA256");
  const privacy = approvedArtifact("APPROVED_PRIVACY_ARTIFACT_PATH", "APPROVED_PRIVACY_SHA256");
  if (process.env.LEGAL_DOCUMENTS_APPROVED !== "true") {
    throw new Error("Approved active Terms of Use and Privacy Policy versions are required in production.");
  }
  return { termsVersion: terms.version, privacyVersion: privacy.version, approved: true, termsContent: terms.content, privacyContent: privacy.content };
}

export function assertApprovedLegalVersionsConfigured(): void {
  if (isProductionEnvironment()) getActiveLegalVersions();
}

/** Test-only injection; production always uses immutable filesystem bytes. */
export function __setLegalArtifactReaderForTesting(reader: ArtifactReader): void {
  artifactReader = reader;
}

export function __resetLegalArtifactReaderForTesting(): void {
  artifactReader = readFileSync;
}
