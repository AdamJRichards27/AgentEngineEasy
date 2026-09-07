import { randomBytes, createHash } from "node:crypto";

// Critical Blocker Remediation, Phase 2/4 — shared random-token helper for
// invitations and password-reset links. The same pattern for both: a
// CSPRNG-generated random value is the thing emailed to the user (never
// persisted anywhere), and only its SHA-256 hash is stored in the
// database, in the `tokenHash` column of `invitations` /
// `passwordResetTokens` (packages/db/src/schema/authTokens.ts). This means
// a database read — backup, replica, admin query, a slow-query log —
// can never yield a usable token, the same reasoning `passwordHash` never
// stores a plaintext password.
//
// SHA-256 (not a keyed HMAC) is sufficient here specifically because the
// input is already a full-entropy 256-bit random value, not a low-entropy
// secret like a password — there is nothing for an attacker to
// dictionary-attack the hash of. This mirrors the existing use of
// `createHmac` elsewhere in this codebase (lib/session.ts,
// communications/webhooks.ts) being reserved for cases with a shared
// secret key; here there is no key, just a one-way index over
// high-entropy random data.

const TOKEN_BYTES = 32; // 256 bits

export interface GeneratedToken {
  /** The value to email to the user and embed in a link. Never persisted. */
  plaintext: string;
  /** The value to store in the database. */
  hash: string;
}

export function generateToken(): GeneratedToken {
  const plaintext = randomBytes(TOKEN_BYTES).toString("base64url");
  return { plaintext, hash: hashToken(plaintext) };
}

export function hashToken(plaintextToken: string): string {
  return createHash("sha256").update(plaintextToken).digest("hex");
}
