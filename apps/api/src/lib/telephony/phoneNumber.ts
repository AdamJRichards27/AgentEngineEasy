// AE GROW Priority 6 Stage F1 — Call Foundation.
//
// §5 — canonical phone-number layer for telephony, deliberately separate
// from `parties.mobile` (property.ts), which remains the raw, user-entered
// contact field and is never mutated by anything in this module. This is a
// pure, side-effect-free normalisation/validation service — no database
// access, no call-session awareness — so it can be unit-tested in
// isolation (see __tests__/phoneNumber.test.ts) and reused anywhere a
// number needs to be validated before a call session is initiated (§5).
//
// AU and NZ national ("0"-prefixed) formats genuinely overlap: a 10-digit
// number starting "02" is valid AU landline (Sydney/NSW/ACT) AND a
// plausible NZ mobile shape (021/022/027/029 + 7 digits). This module does
// NOT guess in that case — a national-format number requires an explicit
// `assumedCountry`, and its absence is reported as the distinct
// `AMBIGUOUS` error code rather than silently defaulting to either
// country. This is a deliberate fail-closed design choice, independent of
// (and not a reuse of) apps/api/src/lib/communications/consent.ts's
// normalizeDestination() — that function normalises for SMS/email
// marketing-consent matching, not for telephony, and the governing
// authorisation explicitly warns against assuming SMS normalisation is
// sufficient for telephony (§5).
//
// An already-international ("+61.../+64...") number never needs
// `assumedCountry` — the prefix itself is authoritative.

export const PHONE_COUNTRIES = ["AU", "NZ"] as const;
export type PhoneCountry = (typeof PHONE_COUNTRIES)[number];

export const PHONE_NUMBER_TYPES = ["MOBILE", "LANDLINE"] as const;
export type PhoneNumberType = (typeof PHONE_NUMBER_TYPES)[number];

export type PhoneNumberValidationErrorCode = "EMPTY" | "INVALID_FORMAT" | "AMBIGUOUS" | "UNSUPPORTED_COUNTRY";

export class PhoneNumberValidationError extends Error {
  readonly code: PhoneNumberValidationErrorCode;
  constructor(code: PhoneNumberValidationErrorCode, message: string) {
    super(message);
    this.name = "PhoneNumberValidationError";
    this.code = code;
  }
}

export interface NormalizedPhoneNumber {
  /** E.164 form, e.g. "+61412345678" — the value grow_call_sessions.destinationNormalized stores. */
  e164: string;
  country: PhoneCountry;
  numberType: PhoneNumberType;
  /** The original input, unmodified, for audit/display alongside the normalized form. */
  raw: string;
}

export interface NormalizePhoneNumberOptions {
  /**
   * Required for a national ("0"-prefixed) number; ignored (and never
   * needed) for an already-international ("+61"/"+64") number. Absence on
   * a national-format number produces AMBIGUOUS, never a silent guess.
   */
  assumedCountry?: PhoneCountry;
}

function stripFormatting(raw: string): string {
  return raw.replace(/[\s().-]/g, "");
}

function classifyAu(nationalDigits: string): { numberType: PhoneNumberType } | null {
  // nationalDigits excludes the leading trunk "0" — 9 digits total.
  if (nationalDigits.length !== 9) return null;
  const first = nationalDigits[0];
  if (first === "4") return { numberType: "MOBILE" };
  if (first === "2" || first === "3" || first === "7" || first === "8") return { numberType: "LANDLINE" };
  return null;
}

function classifyNz(nationalDigits: string): { numberType: PhoneNumberType } | null {
  // NZ mobile national numbers (0 + 2 + 7-8 digits) run 8-9 digits after
  // the trunk "0"; NZ landline national numbers (0 + area digit + 7
  // digits) are always exactly 8 digits after the trunk "0".
  const first = nationalDigits[0];
  if (first === "2") {
    if (nationalDigits.length === 8 || nationalDigits.length === 9) return { numberType: "MOBILE" };
    return null;
  }
  if (first === "3" || first === "4" || first === "6" || first === "7" || first === "9") {
    if (nationalDigits.length === 8) return { numberType: "LANDLINE" };
    return null;
  }
  return null;
}

/**
 * Validates and normalizes a phone number for telephony use (§5). Throws
 * PhoneNumberValidationError — never returns a partial/best-guess result —
 * on empty input, an unrecognised format, or an ambiguous national-format
 * number with no assumedCountry.
 */
export function normalizePhoneNumber(rawInput: string | null | undefined, options: NormalizePhoneNumberOptions = {}): NormalizedPhoneNumber {
  const raw = typeof rawInput === "string" ? rawInput.trim() : "";
  if (raw.length === 0) {
    throw new PhoneNumberValidationError("EMPTY", "A phone number is required.");
  }

  const compact = stripFormatting(raw);

  if (compact.startsWith("+")) {
    const digits = compact.slice(1);
    if (!/^\d+$/.test(digits)) {
      throw new PhoneNumberValidationError("INVALID_FORMAT", `"${raw}" is not a valid phone number.`);
    }
    if (digits.startsWith("61")) {
      const national = digits.slice(2);
      const classified = classifyAu(national);
      if (!classified) throw new PhoneNumberValidationError("INVALID_FORMAT", `"${raw}" is not a recognised Australian number.`);
      return { e164: `+${digits}`, country: "AU", numberType: classified.numberType, raw };
    }
    if (digits.startsWith("64")) {
      const national = digits.slice(2);
      const classified = classifyNz(national);
      if (!classified) throw new PhoneNumberValidationError("INVALID_FORMAT", `"${raw}" is not a recognised New Zealand number.`);
      return { e164: `+${digits}`, country: "NZ", numberType: classified.numberType, raw };
    }
    throw new PhoneNumberValidationError("UNSUPPORTED_COUNTRY", `"${raw}" is not an Australian or New Zealand number — only AU/NZ are supported in F1.`);
  }

  if (!/^0\d+$/.test(compact)) {
    throw new PhoneNumberValidationError("INVALID_FORMAT", `"${raw}" is not a valid phone number.`);
  }
  const national = compact.slice(1);

  if (!options.assumedCountry) {
    // Genuinely ambiguous: AU and NZ national formats overlap (see this
    // file's own header comment) and this input carries no international
    // prefix to disambiguate it.
    throw new PhoneNumberValidationError(
      "AMBIGUOUS",
      `"${raw}" is in national format and could be either an Australian or New Zealand number — specify assumedCountry.`,
    );
  }

  if (options.assumedCountry === "AU") {
    const classified = classifyAu(national);
    if (!classified) throw new PhoneNumberValidationError("INVALID_FORMAT", `"${raw}" is not a recognised Australian number.`);
    return { e164: `+61${national}`, country: "AU", numberType: classified.numberType, raw };
  }

  const classified = classifyNz(national);
  if (!classified) throw new PhoneNumberValidationError("INVALID_FORMAT", `"${raw}" is not a recognised New Zealand number.`);
  return { e164: `+64${national}`, country: "NZ", numberType: classified.numberType, raw };
}
