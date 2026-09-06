import argon2 from "argon2";

// Critical Blocker Remediation, Phase 2/4 — password hashing.
//
// Argon2id via the `argon2` npm package: a native binding to the reference
// Argon2 implementation, actively maintained, and OWASP's current
// recommended default for interactive-login password hashing. No
// hand-rolled cryptography — this module is a thin, fixed-parameter
// wrapper around that library's own hash()/verify(), nothing more.
//
// Parameters below match OWASP's current minimum-recommended Argon2id
// profile for an interactive login path (memoryCost 19 MiB, timeCost 2,
// parallelism 1). They are deliberately centralised here (not
// per-call-site) so a future deployment can raise them without touching
// any route; because Argon2id encodes its salt and every parameter inside
// the stored hash string itself, raising these constants never invalidates
// hashes already stored under the old parameters — argon2.verify() reads
// the parameters it needs back out of the hash it's checking against, not
// from these constants.
const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hashes a plaintext password. The returned string already contains the
 * algorithm identifier, all parameters, and a fresh random salt — nothing
 * else needs to be stored alongside it. Never log the input to this
 * function or its return value beyond the users.passwordHash column.
 */
export async function hashPassword(plaintextPassword: string): Promise<string> {
  return argon2.hash(plaintextPassword, ARGON2ID_OPTIONS);
}

/**
 * Verifies a plaintext password against a previously stored Argon2id hash.
 * Uses the library's own comparison (which itself uses the parameters
 * embedded in `storedHash`, not ARGON2ID_OPTIONS) — never a manual string
 * comparison of any derived value. Returns false (never throws) for a
 * malformed/foreign hash so a corrupted row fails closed as "wrong
 * password" rather than crashing the request.
 */
export async function verifyPassword(storedHash: string, candidatePlaintextPassword: string): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, candidatePlaintextPassword);
  } catch {
    return false;
  }
}

// Deliberately short, dependency-free list — not a full breach-corpus
// check (Phase 2 design doc §8: recorded as a pre-GA hardening item). This
// only exists to reject the handful of passwords an attacker would try
// first against any account, given this is an invitation-only pilot where
// the realistic threat is a guessed weak password, not large-scale
// credential stuffing against a public signup form.
const COMMON_PASSWORD_DENYLIST = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "qwerty123",
  "letmein123",
  "welcome123",
  "changeme123",
  "admin1234",
]);

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Server-side password strength check, applied on invitation acceptance,
 * password reset, and password change — never trust a frontend-only check.
 * Returns a user-facing reason string, or null if the password is
 * acceptable. Never includes the candidate password itself in the
 * response or in any log line.
 */
export function passwordPolicyViolation(candidatePlaintextPassword: string): string | null {
  if (candidatePlaintextPassword.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (COMMON_PASSWORD_DENYLIST.has(candidatePlaintextPassword.toLowerCase())) {
    return "That password is too common. Choose something harder to guess.";
  }
  return null;
}
