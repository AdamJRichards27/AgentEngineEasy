// PH-7 D-9 shared, provider-neutral classifier for the version-aware delete verifiers (mc and AWS S3 adapters).
// Extracted UNCHANGED from verifyDeleteMc.mjs in R22 so the two adapters cannot drift apart (one addition: a listing error
// may carry an explicit boolean `denied`, which the S3 adapter derives from the structured AWS error code; when absent the
// R19 message regex applies exactly as before). Only the "absent" class qualifies as verified permanent deletion.
export const EXIT_CODES = Object.freeze({
  absent: 0,
  delete_marker_retained: 10,
  versions_retained: 11,
  governance_locked: 12,
  compliance_locked: 13,
  access_denied_or_incomplete: 20,
  inconclusive: 30,
});
export const DENIED = /AccessDenied|Access Denied|Forbidden|\b403\b|not authorized|InvalidAccessKeyId|SignatureDoesNotMatch|ExpiredToken/i;

/**
 * Pure classification. Input is provider-neutral:
 *   listing: { complete: boolean, error?: { message: string }, entries: [{ versionId, isDeleteMarker }] } (exact key only)
 *   locks:   { [versionId]: { status: "ok"|"denied"|"error", mode?: "GOVERNANCE"|"COMPLIANCE"|null, until?: ISO, legalHold?: boolean, message?: string } }
 * Only the "absent" result qualifies as verified permanent deletion.
 */
export function classify({ listing, locks = {}, now = new Date() }) {
  const result = (cls, detail, extra = {}) => ({ class: cls, verified: cls === "absent", exitCode: EXIT_CODES[cls], detail, ...extra });
  if (!listing || typeof listing !== "object") return result("inconclusive", "no listing result");
  if (listing.error) {
    const denied = typeof listing.error.denied === "boolean" ? listing.error.denied : DENIED.test(listing.error.message ?? "");
    return denied
      ? result("access_denied_or_incomplete", "listing refused: permission denied")
      : result("inconclusive", `listing failed: ${String(listing.error.message ?? "unknown").slice(0, 200)}`);
  }
  if (listing.complete !== true) return result("access_denied_or_incomplete", "listing is truncated or incomplete; absence cannot be established");
  if (!Array.isArray(listing.entries)) return result("inconclusive", "listing entries missing");
  const entries = listing.entries;
  const markers = entries.filter((e) => e.isDeleteMarker === true).length;
  const versions = entries.length - markers;
  const counts = { versions, deleteMarkers: markers };
  if (entries.length === 0) return result("absent", "no version and no delete marker remains", counts);
  // Something is retained. Establish why (locks) so the operator gets an actionable class.
  let governance = 0;
  let compliance = 0;
  let legalHold = 0;
  for (const entry of entries) {
    if (entry.isDeleteMarker === true) continue;
    const lock = locks[entry.versionId];
    if (!lock) return result("inconclusive", `lock state of retained version ${entry.versionId} was not determined`, counts);
    if (lock.status === "denied") return result("access_denied_or_incomplete", `lock state of version ${entry.versionId} unreadable: permission denied`, counts);
    if (lock.status !== "ok") return result("inconclusive", `lock state of version ${entry.versionId} inconclusive: ${String(lock.message ?? "").slice(0, 160)}`, counts);
    const until = lock.until ? new Date(lock.until) : undefined;
    if (lock.mode && until !== undefined && Number.isNaN(until.getTime())) return result("inconclusive", "retention date malformed", counts);
    const active = lock.mode && (until === undefined || until > now);
    if (active && lock.mode === "COMPLIANCE") compliance += 1;
    else if (active && lock.mode === "GOVERNANCE") governance += 1;
    else if (lock.mode && lock.mode !== "COMPLIANCE" && lock.mode !== "GOVERNANCE") return result("inconclusive", `unknown retention mode ${String(lock.mode).slice(0, 20)}`, counts);
    if (lock.legalHold === true) legalHold += 1;
  }
  const flags = { governanceLockedVersions: governance, complianceLockedVersions: compliance, legalHoldVersions: legalHold, ...counts };
  if (compliance > 0) return result("compliance_locked", `${compliance} version(s) under an active COMPLIANCE lock; cannot be deleted before expiry`, flags);
  if (governance > 0) return result("governance_locked", `${governance} version(s) under an active GOVERNANCE lock; needs bypass permission or expiry`, flags);
  if (markers > 0) return result("delete_marker_retained", `${markers} delete marker(s) and ${versions} version(s) retained: the object is hidden, not deleted`, flags);
  return result("versions_retained", `${versions} version(s) retained${legalHold > 0 ? ` (${legalHold} under legal hold)` : ""}`, flags);
}

