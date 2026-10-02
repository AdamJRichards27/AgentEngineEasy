// UAT-OB1 — shared rules for a person's own first and last name.
//
// The users table already has first_name and last_name (both NOT NULL,
// default ""). There is no display-name column. These rules trim, reject
// blank, and cap length. They do not add a column or a migration.

export const PERSON_NAME_MAX_LENGTH = 80;

export type PersonNameResult = { ok: true; value: string } | { ok: false; error: string };

export function normalizePersonName(value: unknown, label: string): PersonNameResult {
  if (typeof value !== "string") return { ok: false, error: `${label} is required.` };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, error: `${label} is required.` };
  if (trimmed.length > PERSON_NAME_MAX_LENGTH) {
    return { ok: false, error: `${label} must be ${PERSON_NAME_MAX_LENGTH} characters or fewer.` };
  }
  return { ok: true, value: trimmed };
}
