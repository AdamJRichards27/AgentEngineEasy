import { test } from "node:test";
import assert from "node:assert/strict";
import { SendDelegationPanelView, type SendDelegationPanelViewProps } from "../../components/SendDelegationPanel";
import { AuditHistoryCardView } from "../../components/AuditHistoryCard";
import { HeldImportsView, type HeldImportsViewProps } from "../../components/HeldImportsPanel";
import { ExportsView, type ExportsViewProps } from "../../pages/GrowExports";
import { AuditView, type AuditViewProps } from "../../pages/SettingsAudit";
import { ANOTHER_USER, CODE_WORDS, HELD_REASON_WORDS, UNAVAILABLE_REASON_WORDS, actionWords, auditValuesErrorText, authorityRefOk, codeText, delegationDetail, heldEventText, heldReasonText, parseAuditAccesses, parseAuditCapabilities, parseAuditEntries, parseAuditValues, parseCompletedPage, parseDelegationStatus, parseExports, parseHeldList, personLabel, reasonOk, refusalText } from "../t280uContracts";
import { all, text } from "./mobileTreeHelpers";

// Desktop screens for delegation, exports, held imports and audit access (t280u contracts). Fixtures mirror CONTRACTS-t280u.md. Pure views, so every role
// and state is tested by what is DRAWN. The server decides who may do what and says so in fields; the screens draw an action only when a field allows it.
const noop = () => {};
const call = (fn: unknown): void => { (fn as () => void)(); };
const D = (o: Record<string, unknown> = {}) => ({ delegateUserId: 3, delegateName: "Ada Admin", delegateRole: "Brokerage Administrator", state: "active", reason: "Away on leave", grantedByUserId: 4, grantedAt: "2026-11-01T00:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z", renewedFrom: null, renewalCount: 0, revokedAt: null, revokedByUserId: null, invalidatedByOwnershipChange: false, renewable: true, revocable: true, ...o });
const STATUS = (viewer: string, delegations: unknown[], extra: Record<string, unknown> = {}) => ({ recordType: "appraisal", recordId: 12, ownerUserId: 4, viewer, canManage: viewer === "owner", ttlDays: 30, delegations, eligibleDelegates: viewer === "owner" ? [{ userId: 3, name: "Ada Admin", role: "Brokerage Administrator" }, { userId: 5, name: "Gina Agent", role: "Agent" }] : [], ...extra });
const panel = (status: unknown, o: Partial<SendDelegationPanelViewProps> = {}) => SendDelegationPanelView({ status: parseDelegationStatus(status)!, grant: { delegateUserId: "", reason: "" }, renewing: null, busy: false, errorText: null, onGrantChange: noop, onGrant: noop, onRenewStart: noop, onRenewChange: noop, onRenewConfirm: noop, onRenewCancel: noop, onRevoke: noop, ...o });
const names = (tree: unknown, type: string) => all(tree, (e) => e.type === type).map((e) => text(e).trim());
const hasAttr = (tree: unknown, attr: string) => all(tree, (e) => e.props?.[attr] !== undefined).length > 0;

test("delegation: parsing is defensive and keeps only what the screens use", () => {
  assert.equal(parseDelegationStatus(null), null);
  assert.equal(parseDelegationStatus({ viewer: "stranger", recordId: 1, recordType: "appraisal" }), null);
  const s = parseDelegationStatus(STATUS("owner", [D(), D({ state: "weird" }), { nope: true }]))!;
  assert.equal(s.delegations.length, 1, "malformed and unknown-state rows are dropped, not guessed");
  assert.equal(s.ttlDays, 30);
});

test("delegation, OWNER: states in words; Renew and Revoke only where the server says renewable or revocable; a delegate form with a mandatory reason and the 30-day expiry", () => {
  const rows = [D(), D({ delegateUserId: 6, delegateName: "Old Delegate", state: "expired", expiresAt: "2026-10-01T00:00:00.000Z", revocable: false }), D({ delegateUserId: 7, delegateName: "Rev One", state: "revoked", revokedAt: "2026-10-20T00:00:00.000Z", renewable: false, revocable: false }), D({ delegateUserId: 8, delegateName: "Gone", state: "invalidated", renewable: false, revocable: false })];
  const t = panel(STATUS("owner", rows));
  const body = text(t);
  assert.match(body, /Can send until/); assert.match(body, /Expired on/); assert.match(body, /Revoked on/); assert.match(body, /No longer valid: the record's owner changed\./);
  assert.match(body, /Only you, as the owner of this record, can send it/);
  assert.match(body, /lasts 30 days and then expires/);
  assert.deepEqual(names(t, "button").filter((x) => /^(Renew|Revoke)$/.test(x)).sort(), ["Renew", "Renew", "Revoke"], "active: renew+revoke; expired: renew only; revoked and invalidated: neither");
  assert.ok(hasAttr(t, "data-ae-delegate-form"));
  assert.match(text(all(t, (e) => e.props?.["data-ae-delegate-select"] !== undefined)[0]), /Gina Agent \(Agent\)/, "an Agent can be chosen; Ada already holds an active delegation so she is not offered again");
  assert.match(text(all(panel(STATUS("owner", [])), (e) => e.props?.["data-ae-delegate-select"] !== undefined)[0]), /Ada Admin \(Brokerage Administrator\)/, "an Administrator can be chosen when there is no active delegation");
  const submit = all(t, (e) => e.props?.["data-ae-delegate-submit"] !== undefined)[0];
  assert.equal(submit.props?.disabled, true, "no delegate and no reason: cannot submit");
  const ready = panel(STATUS("owner", []), { grant: { delegateUserId: "5", reason: "Covering my open home" } });
  assert.equal(all(ready, (e) => e.props?.["data-ae-delegate-submit"] !== undefined)[0].props?.disabled, false);
  const shortReason = panel(STATUS("owner", []), { grant: { delegateUserId: "5", reason: "abc" } });
  assert.equal(all(shortReason, (e) => e.props?.["data-ae-delegate-submit"] !== undefined)[0].props?.disabled, true, "a reason under 5 characters is not enough");
  assert.deepEqual([reasonOk("abcd"), reasonOk("abcde"), reasonOk("x".repeat(500)), reasonOk("x".repeat(501))], [false, true, true, false]);
});

test("delegation: a delegate already holding an ACTIVE delegation is not offered again", () => {
  const t = panel(STATUS("owner", [D({ delegateUserId: 3 })]));
  const opts = text(all(t, (e) => e.props?.["data-ae-delegate-select"] !== undefined)[0]);
  assert.doesNotMatch(opts, /Ada Admin/); assert.match(opts, /Gina Agent/);
});

test("delegation, ADMINISTRATOR who is not the owner: read-only, 'Review only', no form, no Renew or Revoke", () => {
  const t = panel(STATUS("admin", [D({ renewable: false, revocable: false })]));
  assert.match(text(t), /Review only\. The owning agent sends this, or records a delegation to you\./);
  assert.equal(hasAttr(t, "data-ae-delegate-form"), false);
  assert.equal(names(t, "button").length, 0);
});

test("delegation, DELEGATE or OTHER AGENT: sees only their own row and no controls", () => {
  const t = panel(STATUS("delegate", [D({ renewable: false, revocable: false })]));
  assert.equal(names(t, "button").length, 0); assert.equal(hasAttr(t, "data-ae-delegate-form"), false);
  assert.match(text(t), /Sending authority recorded for you/);
});

test("delegation: there is NO send action in the panel for any viewer or state, and the panel shows no stored key", () => {
  for (const v of ["owner", "admin", "delegate"]) for (const st of ["active", "expired", "revoked", "invalidated"]) {
    const t = panel(STATUS(v, [D({ state: st })]));
    assert.equal(names(t, "button").some((b) => /send|issue|sign/i.test(b) && !/delegate sending/i.test(b)), false, `${v}/${st}`);
    assert.doesNotMatch(text(t), /invalidated|_/, `${v}/${st}: no stored key`);
  }
  assert.equal(delegationDetail(parseDelegationStatus(STATUS("owner", [D({ state: "invalidated" })]))!.delegations[0]), "No longer valid: the record's owner changed.");
});

test("delegation: renewing asks for a reason first; an error is shown in words", () => {
  const t = panel(STATUS("owner", [D({ state: "expired", revocable: false })]), { renewing: { delegateUserId: 3, reason: "" }, errorText: codeText({ code: "SEND_DELEGATION_NOT_RENEWABLE" }, "x") });
  assert.ok(hasAttr(t, "data-ae-renew-form"));
  assert.equal(all(t, (e) => e.props?.["data-ae-renew-confirm"] !== undefined)[0].props?.disabled, true);
  assert.match(text(t), /can't be renewed\. Record a new delegation instead/);
});

/* ── exports ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
const E = (o: Record<string, unknown> = {}) => ({ exportId: 77, owner: 4, initiatedBy: 8, rows: 16, preparedAt: "2026-11-01T00:00:00.000Z", expiresAt: "2026-11-08T00:00:00.000Z", status: "ready", ready: true, mine: true, releasedTo: [], downloadedAt: null, seen: false, seenAt: null, canDownload: true, ...o });
const exportsView = (exs: unknown[], o: Partial<ExportsViewProps> = {}) => ExportsView({ exports: parseExports({ exports: exs }), loading: false, failed: false, releasing: null, busy: false, errorText: null, onReleaseStart: noop, onReleaseChange: noop, onReleaseConfirm: noop, onReleaseCancel: noop, onDownloaded: noop, ...o });

test("exports, OWNER: scope, created, expiry and status; Download for a ready export; Release to the preparer only when it was prepared by someone else", () => {
  const t = exportsView([E()]);
  assert.match(text(t), /16 contacts/); assert.match(text(t), /available until/); assert.match(text(t), /Ready/);
  assert.deepEqual(all(t, (e) => e.props?.["data-ae-export-download"] !== undefined).map((e) => e.props?.href), ["/api/grow/contacts/exports/77/download"]);
  assert.ok(hasAttr(t, "data-ae-export-release"));
  assert.equal(hasAttr(exportsView([E({ initiatedBy: 4 })]), "data-ae-export-release"), false, "the owner prepared it themself: nothing to release");
  assert.equal(hasAttr(exportsView([E({ releasedTo: [{ userId: 8, releasedAt: "2026-11-02T00:00:00.000Z" }] })]), "data-ae-export-release"), false, "already released");
});

test("exports, EXPIRED: shown as unavailable with no download link and no release", () => {
  const t = exportsView([E({ status: "expired", ready: false, canDownload: false })]);
  assert.match(text(t), /Expired/); assert.match(text(t), /Unavailable: this export has expired/);
  assert.equal(hasAttr(t, "data-ae-export-download"), false); assert.equal(hasAttr(t, "data-ae-export-release"), false);
});

test("exports, PIT CREW (prepared it, not the owner): no download unless the owner released it; never a release control", () => {
  const prepared = exportsView([E({ mine: false, canDownload: false })]);
  assert.equal(hasAttr(prepared, "data-ae-export-download"), false);
  assert.equal(hasAttr(prepared, "data-ae-export-release"), false);
  assert.match(text(prepared), /Delivered to the owner\. Downloading it needs the owner's release\./);
  const released = exportsView([E({ mine: false, canDownload: true, releasedTo: [{ userId: 8, releasedAt: "2026-11-02T00:00:00.000Z" }] })]);
  assert.equal(hasAttr(released, "data-ae-export-download"), true, "after the owner's release the server says canDownload");
});

test("exports: empty, loading and failed states; releasing asks for a reason; refusals in words", () => {
  assert.ok(hasAttr(exportsView([]), "data-ae-no-exports"));
  assert.match(text(exportsView([], { loading: true })), /Loading/); assert.match(text(exportsView([], { failed: true })), /Couldn't load your exports/);
  const t = exportsView([E()], { releasing: { exportId: 77, reason: "" }, errorText: codeText({ code: "EXPORT_RELEASE_INVALID" }, "x") });
  assert.equal(all(t, (e) => e.props?.["data-ae-release-confirm"] !== undefined)[0].props?.disabled, true);
  assert.match(text(t), /only to the person who prepared it/);
});

/* ── audit ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
const entry = (o: Record<string, unknown> = {}) => ({ auditId: 120, action: "grow_contact_updated_on_authority", recordType: "party", recordId: "18", userId: 8, createdAt: "2026-11-02T00:00:00.000Z", hasEncryptedValues: true, valuesExpired: false, valuesRetainedUntil: "2028-11-02T00:00:00.000Z", metadataRetainedUntil: "2033-11-02T00:00:00.000Z", ...o });
const audit = (caps: Record<string, unknown>, entries: unknown[] = [entry()], o: Partial<AuditViewProps> = {}) => AuditView({ caps: parseAuditCapabilities(caps), entries: parseAuditEntries({ entries }).entries, names: { 8: "Pat Pitcrew" }, loading: false, failed: false, hasMore: false, filter: { recordType: "", recordId: "" }, historyFor: null, accesses: [], historyLoading: false, requesting: null, shown: {}, errors: {}, busy: false, onFilterChange: noop, onApplyFilter: noop, onLoadMore: noop, onToggleHistory: noop, onRequestStart: noop, onRequestChange: noop, onRequestConfirm: noop, onRequestCancel: noop, onHideValues: noop, ...o });
const CAPS_ADMIN = { isAuditValueReader: false, canReadAuditMetadata: true, canReadAuditAccessHistory: true, valueRetentionDays: 730, metadataRetentionDays: 2555 };
const CAPS_READER = { ...CAPS_ADMIN, isAuditValueReader: true };

test("audit: a non-administrator sees only a plain message and no entries", () => {
  const t = audit({ isAuditValueReader: false, canReadAuditMetadata: false }, [entry()]);
  assert.match(text(t), /The audit history is for Administrators\./); assert.equal(hasAttr(t, "data-ae-audit-entry"), false);
});

test("audit, ADMINISTRATOR (not a value reader): ordinary metadata in words, values shown as Encrypted, access history available, NO request control", () => {
  const t = audit(CAPS_ADMIN);
  assert.match(text(t), /Grow contact updated on authority/); assert.match(text(t), /Party 18/); assert.match(text(t), /Pat Pitcrew/);
  assert.match(text(all(t, (e) => e.props?.["data-ae-audit-values-state"] !== undefined)[0]), /Values: Encrypted/);
  assert.ok(hasAttr(t, "data-ae-audit-history-toggle"));
  assert.equal(hasAttr(t, "data-ae-audit-request"), false);
  assert.doesNotMatch(text(t), /_|\[encrypted\]/);
  assert.match(text(t), /kept encrypted for 730 days/);
});

test("audit, VALUE READER: Request values only for an entry that has unexpired encrypted values; a reason is mandatory; values appear only after the request", () => {
  assert.ok(hasAttr(audit(CAPS_READER), "data-ae-audit-request"));
  assert.equal(hasAttr(audit(CAPS_READER, [entry({ hasEncryptedValues: false })]), "data-ae-audit-request"), false);
  assert.equal(hasAttr(audit(CAPS_READER, [entry({ valuesExpired: true })]), "data-ae-audit-request"), false);
  // the server reports an expired entry as hasEncryptedValues:false, valuesExpired:true (seen against the real route); both shapes read "expired"
  for (const shape of [{ valuesExpired: true }, { valuesExpired: true, hasEncryptedValues: false }]) assert.match(text(audit(CAPS_READER, [entry(shape)])), /expired \(past the retention period\)/);
  assert.equal(hasAttr(audit(CAPS_READER, [entry({ valuesExpired: true, hasEncryptedValues: false })]), "data-ae-audit-request"), false);
  const form = audit(CAPS_READER, [entry()], { requesting: { auditId: 120, reason: "" } });
  assert.equal(all(form, (e) => e.props?.["data-ae-audit-confirm"] !== undefined)[0].props?.disabled, true);
  assert.equal(all(audit(CAPS_READER, [entry()], { requesting: { auditId: 120, reason: "Investigating complaint 55" } }), (e) => e.props?.["data-ae-audit-confirm"] !== undefined)[0].props?.disabled, false);
  assert.equal(hasAttr(audit(CAPS_READER), "data-ae-audit-values"), false, "no values until a reasoned request has been answered");
  // the REAL response shape (seen against the t280u route): before and after are JSON objects of the changed fields, plus who did it and on whose authority
  const real = parseAuditValues({ auditId: 120, action: "grow_contact_updated_on_authority", before: { mobile: "0491 570 158" }, after: { mobile: "0491 570 300" }, fields: ["mobile"], requestedBy: { userId: 2 }, performedBy: { userId: 8, role: "Pit Crew" }, authorityRef: "email from Gus 2026-11-05" })!;
  assert.match(real.before ?? "", /0491 570 158/); assert.match(real.after ?? "", /0491 570 300/);
  assert.equal(parseAuditValues({ auditId: 1, before: "old@x.test", after: null })!.before, "old@x.test", "a plain string still reads as it is");
  const shown = audit(CAPS_READER, [entry()], { shown: { 120: real } });
  assert.match(text(all(shown, (e) => e.props?.["data-ae-audit-before"] !== undefined)[0]), /0491 570 158/);
  assert.match(text(all(shown, (e) => e.props?.["data-ae-audit-after"] !== undefined)[0]), /0491 570 300/);
  assert.match(text(all(shown, (e) => e.props?.["data-ae-audit-performed"] !== undefined)[0]), /Done by Pat Pitcrew \(Pit Crew\) on the authority of User 2\. Authority reference: email from Gus/);
  assert.match(text(shown), /Shown for this entry only\. This access has been recorded\./);
  assert.equal(hasAttr(shown, "data-ae-audit-request"), false, "no second request while the values are showing");
});

test("audit: access history lists views and refusals in words, with the reason", () => {
  const accesses = parseAuditAccesses({ accesses: [{ id: 1, auditId: 120, userId: 8, role: "Brokerage Administrator", outcome: "accessed", refusal: null, reason: "Complaint 55", at: "2026-11-03T00:00:00.000Z" }, { id: 2, auditId: 120, userId: 9, role: "Agent", outcome: "refused", refusal: "NOT_AUTHORISED", reason: null, at: "2026-11-04T00:00:00.000Z" }, { id: 3, outcome: "weird" }] });
  assert.equal(accesses.length, 2);
  const t = audit(CAPS_ADMIN, [entry()], { historyFor: 120, accesses });
  assert.match(text(t), /viewed the values/); assert.match(text(t), /refused \(not authorised\)/); assert.match(text(t), /Reason: Complaint 55/);
  assert.equal(all(t, (e) => e.props?.["data-ae-audit-access"] !== undefined).length, 2);
  assert.ok(hasAttr(audit(CAPS_ADMIN, [entry()], { historyFor: 120, accesses: [] }), "data-ae-audit-no-access"));
  assert.equal(refusalText("KEY_MISMATCH"), "could not be decrypted"); assert.equal(actionWords("grow_contact_updated_on_authority"), "Grow contact updated on authority");
});

test("audit: refusals from the server are shown in words, per entry", () => {
  for (const code of ["AUDIT_VALUES_RESTRICTED", "AUDIT_VALUE_EXPIRED", "AUDIT_VALUE_UNAVAILABLE", "AUDIT_VALUES_REASON_REQUIRED"]) {
    const t = audit(CAPS_READER, [entry()], { errors: { 120: codeText({ code }, "x") } });
    assert.match(text(all(t, (e) => e.props?.["data-ae-audit-error"] !== undefined)[0]), new RegExp(CODE_WORDS[code].slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("wording: every server code the screens handle has a sentence, and the server's own sentence wins when it sent one", () => {
  for (const c of Object.keys(CODE_WORDS)) assert.ok(CODE_WORDS[c].length > 10 && !/_/.test(CODE_WORDS[c]), c);
  assert.equal(codeText({ code: "UNKNOWN_CODE", friendly: "The server said this." }, "fallback"), "The server said this.");
  assert.equal(codeText({ code: "UNKNOWN_CODE", friendly: "  " }, "fallback"), "fallback");
  assert.equal(codeText(new Error("x"), "fallback"), "fallback");
});

test("audit values (t282u contract C): every documented refusal has its own sentence, including each 503 reason", () => {
  const cases: Array<[unknown, RegExp]> = [
    [{ status: 403, code: "AUDIT_VALUES_RESTRICTED" }, /not authorised to read audited values/],
    [{ status: 400, code: "AUDIT_VALUES_REASON_REQUIRED" }, /reason of 5 to 500 characters/],
    [{ status: 400 }, /isn't valid/],
    [{ status: 404 }, /No readable values are recorded for this entry/],
    [{ status: 410, code: "AUDIT_VALUE_EXPIRED" }, /past their retention period/],
    [{ status: 503, code: "AUDIT_VALUE_UNAVAILABLE", reason: "NO_KEY" }, /no decryption key is configured/],
    [{ status: 503, code: "AUDIT_VALUE_UNAVAILABLE", reason: "KEY_MISMATCH" }, /can't be decrypted with the configured key/],
    [{ status: 503, code: "AUDIT_VALUE_UNAVAILABLE", reason: "EXPIRED" }, /past their retention period/],
    [{ status: 503, code: "AUDIT_VALUE_UNAVAILABLE", reason: "NOT_ENCRYPTED" }, /No encrypted values are recorded/],
    [{ status: 503, code: "AUDIT_VALUE_UNAVAILABLE" }, /can't be decrypted with the configured key/],
    [{ status: 401 }, /Sign in again/],
  ];
  for (const [err, re] of cases) assert.match(auditValuesErrorText(err), re, JSON.stringify(err));
  assert.equal(auditValuesErrorText(new Error("boom")), "Couldn't show those values.");
  for (const k of Object.keys(UNAVAILABLE_REASON_WORDS)) assert.doesNotMatch(UNAVAILABLE_REASON_WORDS[k], /_/);
  assert.equal(refusalText("NOT_ENCRYPTED"), "no encrypted values to show");
  for (const r of ["NOT_AUTHORISED", "REASON_REQUIRED", "NOT_FOUND", "EXPIRED", "NO_KEY", "KEY_MISMATCH", "NOT_ENCRYPTED"]) assert.doesNotMatch(refusalText(r), /_/, r);
});

test("audit list states (t282u contract C): the three documented combinations read correctly, and only a readable one can be requested", () => {
  const state = (o: Record<string, unknown>, caps = CAPS_READER) => audit(caps, [entry(o)]);
  const t1 = state({ hasEncryptedValues: true, valuesExpired: false });
  assert.match(text(t1), /Values: Encrypted/); assert.ok(hasAttr(t1, "data-ae-audit-request"));
  const t2 = state({ hasEncryptedValues: false, valuesExpired: true });
  assert.match(text(t2), /expired \(past the retention period\)/); assert.equal(hasAttr(t2, "data-ae-audit-request"), false);
  const t3 = state({ hasEncryptedValues: false, valuesExpired: false });
  assert.match(text(t3), /none recorded/); assert.equal(hasAttr(t3, "data-ae-audit-request"), false);
  assert.equal(hasAttr(state({ hasEncryptedValues: true, valuesExpired: false }, CAPS_ADMIN as typeof CAPS_READER), "data-ae-audit-request"), false, "an administrator who is not a value reader is never offered the request");
});

/* ── held imports (t284u contract): people are labels with no user ids; completed imports are paged ─────────────────────────────────────────── */
const PERSON = (label: string, isYou = false) => ({ label, isYou });
const YOU = PERSON("You", true);
const HELD = (o: Record<string, unknown> = {}) => ({ importJobId: 9, filename: "c.csv", jobStatus: "READY_TO_IMPORT", totalRows: 1, uploadedAt: "2026-11-01T00:00:00.000Z", initiatedBy: PERSON("Gina Grow"), recordedOwner: PERSON("Rhea Run"), releaseStatus: "held", reasonCode: "OWNER_INACTIVE", release: null, history: [], canAssignAnyOwner: false, canAcceptForSelf: false, ...o });
const HISTORY = [
  { event: "owner_set", at: "2026-11-01T01:00:00.000Z", by: PERSON("Gina Grow"), owner: PERSON("Gina Grow"), authorityRef: "Initial owner" },
  { event: "held", at: "2026-11-02T01:00:00.000Z", by: PERSON("Gus Grow"), reasonCode: "OWNER_INACTIVE" },
  { event: "owner_recorded", at: "2026-11-03T01:00:00.000Z", by: YOU, owner: YOU, authorityRef: "Accepted at review INSTR-A2" },
];
const RELEASE = { owner: YOU, releasedBy: YOU, authorityRef: "Accepted at review INSTR-A2", releasedAt: "2026-11-03T01:00:00.000Z" };
const heldView = (held: unknown[], o: Partial<HeldImportsViewProps> = {}) => {
  const list = parseHeldList({ held, completed: { items: [], limit: 20, nextCursor: null } });
  return HeldImportsView({ held: list.held, completed: list.completed.items, hasMoreCompleted: false, loadingMore: false, moreError: null, owners: [{ id: 1, name: "Ada Admin", role: "Brokerage Administrator" }, { id: 5, name: "Gina Grow", role: "Agent" }], drafts: {}, busyId: null, errorText: null, selfId: 5, onDraft: noop, onSubmit: noop, onShowMore: noop, ...o });
};

test("held imports (t284u): the response is held plus a first page of completed; both parse, and an unfamiliar status never makes a row vanish", () => {
  const list = parseHeldList({ held: [HELD(), HELD({ importJobId: 10, releaseStatus: "released", reasonCode: null, release: RELEASE }), HELD({ importJobId: 11, releaseStatus: "finished" })], completed: { items: [HELD({ importJobId: 8, releaseStatus: "completed", reasonCode: null, release: RELEASE, history: HISTORY })], limit: 20, nextCursor: 8 } });
  assert.deepEqual(list.held.map((h) => h.releaseStatus), ["held", "released", "unknown"], "an unfamiliar status is kept as unknown, not dropped");
  assert.equal(list.completed.items.length, 1); assert.equal(list.completed.nextCursor, 8); assert.equal(list.completed.limit, 20);
  assert.deepEqual(parseHeldList(null), { held: [], completed: { items: [], limit: null, nextCursor: null } });
  assert.equal(parseCompletedPage({ items: [], limit: 20, nextCursor: null }).nextCursor, null, "null on the last page");
  assert.equal(parseHeldList({ held: [{ importJobId: 1 }, null], completed: {} }).held.length, 0, "only a row with no filename cannot be shown");
});

test("held imports (t284u): people are shown by the label the server gave, with no user id anywhere; a missing person is the neutral label", () => {
  const withIds = HELD({ initiatedByUserId: 5, recordedOwnerUserId: 6, releaseStatus: "released", reasonCode: null, release: { ...RELEASE, releasedByUserId: 4, ownerUserId: 6 }, history: [{ event: "held", at: "2026-11-02T01:00:00.000Z", byUserId: 3, reasonCode: "OWNER_INACTIVE" }] });
  const parsed = parseHeldList({ held: [withIds], completed: {} });
  assert.doesNotMatch(JSON.stringify(parsed), /UserId|"id"/, "even if a server sent ids, none is kept");
  assert.equal(parsed.held[0].history[0].by.label, ANOTHER_USER.label, "a person the server did not describe reads as the neutral label");
  assert.equal(personLabel(null), "Another user"); assert.equal(personLabel(PERSON("Gina Grow")), "Gina Grow");
  const t = heldView([HELD({ releaseStatus: "released", reasonCode: null, release: { ...RELEASE, releasedBy: PERSON("Gus Grow"), owner: PERSON("Another user") }, history: HISTORY })]);
  assert.match(text(t), /Owner recorded 3 Nov 2026.*by Gus Grow\. Authority reference: Accepted at review INSTR-A2/s);
  assert.match(text(t), /Owner set at creation: Gina Grow/); assert.match(text(t), /Owner recorded at review: You\./);
  assert.match(text(t), /Held for review: The recorded owner is no longer active\./);
  assert.doesNotMatch(text(t), /User \d|owner_recorded|owner_set|OWNER_INACTIVE|_/, "no id and no stored key reaches the user");
  assert.equal(heldEventText({ event: "owner_set", at: "x", by: ANOTHER_USER, owner: null, reasonCode: null, authorityRef: null }), "Owner set at creation: Another user.");
});

test("held imports (t284u): every reason code and the status are in words; nothing when there are none", () => {
  assert.equal(heldView([]), null);
  for (const code of Object.keys(HELD_REASON_WORDS)) assert.match(text(heldView([HELD({ reasonCode: code })])), new RegExp(HELD_REASON_WORDS[code].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(heldReasonText("SOMETHING_NEW"), /can't be established/);
  assert.match(text(heldView([HELD()])), /Held/);
});

test("held imports (t284u): an ADMINISTRATOR assigns any owner and an AGENT takes ownership for themselves, each with an authority reference; nobody else gets a control", () => {
  const admin = heldView([HELD({ canAssignAnyOwner: true })]);
  assert.ok(hasAttr(admin, "data-ae-held-owner")); assert.match(text(admin), /Assign owner/);
  assert.equal(all(admin, (e) => e.props?.["data-ae-held-submit"] !== undefined)[0].props?.disabled, true);
  assert.equal(all(heldView([HELD({ canAssignAnyOwner: true })], { drafts: { 9: { ownerUserId: "1", authorityRef: "email 2026-11-05" } } }), (e) => e.props?.["data-ae-held-submit"] !== undefined)[0].props?.disabled, false);
  const agent = heldView([HELD({ canAcceptForSelf: true })]);
  assert.equal(hasAttr(agent, "data-ae-held-owner"), false, "an Agent cannot pick another owner"); assert.match(text(agent), /Take ownership/);
  assert.equal(all(agent, (e) => e.props?.["data-ae-held-submit"] !== undefined)[0].props?.disabled, true, "authority reference missing");
  assert.equal(all(heldView([HELD({ canAcceptForSelf: true })], { drafts: { 9: { ownerUserId: "", authorityRef: "abc" } } }), (e) => e.props?.["data-ae-held-submit"] !== undefined)[0].props?.disabled, false);
  assert.equal(all(heldView([HELD({ canAcceptForSelf: true })], { drafts: { 9: { ownerUserId: "", authorityRef: "abc" } }, selfId: null }), (e) => e.props?.["data-ae-held-submit"] !== undefined)[0].props?.disabled, true, "no own id, no owner to name");
  const none = heldView([HELD()]);
  assert.equal(hasAttr(none, "data-ae-held-form"), false); assert.match(text(none), /An administrator must assign the owner/);
  assert.deepEqual([authorityRefOk("ab"), authorityRefOk("abc"), authorityRefOk("x".repeat(200)), authorityRefOk("x".repeat(201))], [false, true, true, false]);
  for (const flags of [{ releaseStatus: "released" }, { releaseStatus: "completed" }, { releaseStatus: "finished" }]) assert.equal(hasAttr(heldView([HELD({ ...flags, reasonCode: null, canAssignAnyOwner: true, canAcceptForSelf: true })]), "data-ae-held-form"), false, `${flags.releaseStatus}: no control whatever the row says`);
});

test("held imports (t284u): an Agent who may not take an import is told why, in words", () => {
  assert.equal(codeText({ code: "IMPORT_OWNER_NOT_LINKED", friendly: "x" }, "fallback"), "You can only take imports you started or already own. Ask an administrator to assign it.");
  assert.match(CODE_WORDS.IMPORT_HELD_PAGE_INVALID, /Reload the page/); assert.match(CODE_WORDS.IMPORT_OWNER_ASSIGN_FORBIDDEN, /Ask an administrator/); assert.match(CODE_WORDS.IMPORT_OWNER_INVALID, /authority reference/);
  const t = heldView([HELD({ canAcceptForSelf: true })], { errorText: codeText({ code: "IMPORT_OWNER_NOT_LINKED" }, "x") });
  assert.match(text(all(t, (e) => e.props?.["data-ae-held-error"] !== undefined)[0]), /only take imports you started or already own/);
});

test("held imports (t284u): completed imports are paged: a Show more control only while the server has another page, disabled while loading, with a failure in words", () => {
  const done = (id: number) => HELD({ importJobId: id, filename: `done-${id}.csv`, releaseStatus: "completed", reasonCode: null, release: RELEASE, history: HISTORY });
  const first = heldView([], { completed: parseHeldList({ held: [], completed: { items: [done(30), done(29)], limit: 20, nextCursor: 29 } }).completed.items, hasMoreCompleted: true });
  assert.ok(hasAttr(first, "data-ae-completed-heading")); assert.equal(all(first, (e) => e.props?.["data-ae-held-import"] !== undefined).length, 2);
  const more = all(first, (e) => e.props?.["data-ae-held-more"] !== undefined)[0]; assert.match(text(more), /Show more completed imports/); assert.equal(more.props?.disabled, false);
  let clicked = 0; call(all(heldView([], { completed: parseHeldList({ held: [], completed: { items: [done(30)], limit: 20, nextCursor: 30 } }).completed.items, hasMoreCompleted: true, onShowMore: () => { clicked += 1; } }), (e) => e.props?.["data-ae-held-more"] !== undefined)[0].props?.onClick); assert.equal(clicked, 1);
  const loading = heldView([], { completed: [parseHeldList({ held: [], completed: { items: [done(30)] } }).completed.items[0]], hasMoreCompleted: true, loadingMore: true });
  assert.equal(all(loading, (e) => e.props?.["data-ae-held-more"] !== undefined)[0].props?.disabled, true); assert.match(text(loading), /Loading/);
  const last = heldView([], { completed: parseHeldList({ held: [], completed: { items: [done(30)] } }).completed.items, hasMoreCompleted: false });
  assert.equal(hasAttr(last, "data-ae-held-more"), false, "no control on the last page");
  const failed = heldView([], { completed: parseHeldList({ held: [], completed: { items: [done(30)] } }).completed.items, hasMoreCompleted: true, moreError: codeText({ code: "IMPORT_HELD_PAGE_INVALID" }, "x") });
  assert.match(text(all(failed, (e) => e.props?.["data-ae-held-more-error"] !== undefined)[0]), /Reload the page/);
  const both = heldView([HELD()], { completed: parseHeldList({ held: [], completed: { items: [done(30)] } }).completed.items });
  assert.match(text(all(both, (e) => e.props?.["data-ae-held-imports"] !== undefined)[0]), /Imports held for review \(1\)/, "the count is the imports held NOW, not the history");
});

test("held imports page: an empty list is said in words on the page, drawn as nothing when embedded; a refused user is told who reviews them and gets no controls", () => {
  assert.equal(heldView([]), null);
  assert.match(text(heldView([], { showEmpty: true })), /No imports are held for review\./);
  const refused = heldView([], { forbidden: true });
  assert.match(text(refused), /reviewed by Administrators and Agents/); assert.equal(hasAttr(refused, "data-ae-held-form"), false);
});

/* ── audit permissions (t284u): the Settings card and the access history follow the server's capability fields ───────────────────────────────── */
test("audit permissions (t284u): capabilities parse their three fields; the access history is drawn only when the server says it may be read", () => {
  const c = parseAuditCapabilities({ isAuditValueReader: false, canReadAuditMetadata: true, canReadAuditAccessHistory: true, valueRetentionDays: 730, metadataRetentionDays: 2555 });
  assert.deepEqual([c.canReadAuditMetadata, c.canReadAuditAccessHistory, c.isAuditValueReader], [true, true, false]);
  const none = parseAuditCapabilities({}); assert.deepEqual([none.canReadAuditMetadata, none.canReadAuditAccessHistory, none.isAuditValueReader], [false, false, false], "fails closed");
  assert.equal(hasAttr(audit(CAPS_ADMIN), "data-ae-audit-history-toggle"), true);
  assert.equal(hasAttr(audit({ ...CAPS_ADMIN, canReadAuditAccessHistory: false }), "data-ae-audit-history-toggle"), false, "metadata without history: no history control");
  assert.match(text(AuditHistoryCardView()), /Audit history/); assert.deepEqual(all(AuditHistoryCardView(), (e) => e.props?.href === "/settings/audit").length, 1);
});

test("audit permissions (t284u): the Settings card is driven by the server's answer, not by the role", async () => {
  const { readFileSync } = await import("node:fs");
  const card = readFileSync(new URL("../../components/AuditHistoryCard.tsx", import.meta.url), "utf8").replace(/\/\/.*$/gm, "");
  assert.match(card, /caps\.data\?\.canReadAuditMetadata/); assert.doesNotMatch(card, /role\s*===|isAdmin|Brokerage Administrator/);
  assert.match(card, /staleTime: 5 \* 60_000/); assert.match(card, /refetchOnWindowFocus: false/);
  const settings = readFileSync(new URL("../../pages/Settings.tsx", import.meta.url), "utf8");
  assert.match(settings, /<AuditHistoryCard \/>/); assert.doesNotMatch(settings, /View Audit history/, "the role-gated card is gone from the page itself");
  const page = readFileSync(new URL("../../pages/SettingsAudit.tsx", import.meta.url), "utf8");
  assert.match(page, /useQuery<AuditCapabilities>\(auditCapabilitiesQuery\)/, "one shared capabilities request"); assert.match(page, /canReadAuditAccessHistory === true/);
});
