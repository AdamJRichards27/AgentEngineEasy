import { test } from "node:test";
import assert from "node:assert/strict";
import { SendDelegationPanelView, type SendDelegationPanelViewProps } from "../../components/SendDelegationPanel";
import { HeldImportsView, type HeldImportsViewProps } from "../../components/HeldImportsPanel";
import { ExportsView, type ExportsViewProps } from "../../pages/GrowExports";
import { AuditView, type AuditViewProps } from "../../pages/SettingsAudit";
import { CODE_WORDS, HELD_REASON_WORDS, UNAVAILABLE_REASON_WORDS, actionWords, auditValuesErrorText, authorityRefOk, codeText, delegationDetail, heldEventText, heldReasonText, parseAuditAccesses, parseAuditCapabilities, parseAuditEntries, parseAuditValues, parseDelegationStatus, parseExports, parseHeldImports, reasonOk, refusalText } from "../t280uContracts";
import { all, text } from "./mobileTreeHelpers";

// Desktop screens for delegation, exports, held imports and audit access (t280u contracts). Fixtures mirror CONTRACTS-t280u.md. Pure views, so every role
// and state is tested by what is DRAWN. The server decides who may do what and says so in fields; the screens draw an action only when a field allows it.
const noop = () => {};
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

/* ── held imports ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
const H = (o: Record<string, unknown> = {}) => ({ importJobId: 9, filename: "c.csv", jobStatus: "READY_TO_IMPORT", totalRows: 1, uploadedAt: "2026-11-01T00:00:00.000Z", initiatedByUserId: 5, recordedOwnerUserId: 5, releaseStatus: "held", reasonCode: "OWNER_NOT_ENTITLED", release: null, canAssignAnyOwner: false, canAcceptForSelf: false, ...o });
const heldView = (held: unknown[], o: Partial<HeldImportsViewProps> = {}) => HeldImportsView({ held: parseHeldImports({ held }), owners: [{ id: 4, name: "Ada Admin", role: "Brokerage Administrator" }, { id: 5, name: "Gina Agent", role: "Agent" }], drafts: {}, busyId: null, errorText: null, selfId: 5, onDraft: noop, onSubmit: noop, ...o });

test("held imports: every reason code and the status are in words; nothing when there are none", () => {
  assert.equal(heldView([]), null);
  for (const code of Object.keys(HELD_REASON_WORDS)) assert.match(text(heldView([H({ reasonCode: code })])), new RegExp(HELD_REASON_WORDS[code].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(heldReasonText("SOMETHING_NEW"), /can't be established/, "an unknown code is still a sentence");
  assert.doesNotMatch(text(heldView([H()])), /OWNER_|_/);
  assert.match(text(heldView([H()])), /Held/);
});

test("held imports, ADMINISTRATOR: assigns any owner, authority reference required; AGENT: takes ownership for themselves, authority reference required; others: neither", () => {
  const admin = heldView([H({ canAssignAnyOwner: true })]);
  assert.ok(hasAttr(admin, "data-ae-held-owner")); assert.match(text(admin), /Assign owner/);
  assert.equal(all(admin, (e) => e.props?.["data-ae-held-submit"] !== undefined)[0].props?.disabled, true, "no owner and no authority reference yet");
  const adminReady = heldView([H({ canAssignAnyOwner: true })], { drafts: { 9: { ownerUserId: "4", authorityRef: "email 2026-11-05" } } });
  assert.equal(all(adminReady, (e) => e.props?.["data-ae-held-submit"] !== undefined)[0].props?.disabled, false);
  const agent = heldView([H({ canAcceptForSelf: true })]);
  assert.equal(hasAttr(agent, "data-ae-held-owner"), false, "an Agent cannot pick another owner");
  assert.match(text(agent), /Take ownership/);
  assert.equal(all(agent, (e) => e.props?.["data-ae-held-submit"] !== undefined)[0].props?.disabled, true, "authority reference missing");
  assert.equal(all(heldView([H({ canAcceptForSelf: true })], { drafts: { 9: { ownerUserId: "", authorityRef: "ab" } } }), (e) => e.props?.["data-ae-held-submit"] !== undefined)[0].props?.disabled, true, "two characters is not enough");
  assert.equal(all(heldView([H({ canAcceptForSelf: true })], { drafts: { 9: { ownerUserId: "", authorityRef: "abc" } } }), (e) => e.props?.["data-ae-held-submit"] !== undefined)[0].props?.disabled, false);
  const none = heldView([H()]);
  assert.equal(hasAttr(none, "data-ae-held-form"), false); assert.match(text(none), /An administrator must assign the owner/);
  assert.deepEqual([authorityRefOk("ab"), authorityRefOk("abc"), authorityRefOk("x".repeat(200)), authorityRefOk("x".repeat(201))], [false, true, true, false]);
});

test("held imports: a released import shows who released it with the authority reference and offers no controls", () => {
  const t = heldView([H({ releaseStatus: "released", reasonCode: null, release: { ownerUserId: 4, releasedByUserId: 4, authorityRef: "email 2026-11-05", releasedAt: "2026-11-05T01:00:00.000Z" }, canAssignAnyOwner: true })]);
  assert.match(text(t), /Released/); assert.match(text(t), /Authority reference: email 2026-11-05/);
  assert.equal(hasAttr(t, "data-ae-held-form"), false);
});

/* ── audit ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────── */
const entry = (o: Record<string, unknown> = {}) => ({ auditId: 120, action: "grow_contact_updated_on_authority", recordType: "party", recordId: "18", userId: 8, createdAt: "2026-11-02T00:00:00.000Z", hasEncryptedValues: true, valuesExpired: false, valuesRetainedUntil: "2028-11-02T00:00:00.000Z", metadataRetainedUntil: "2033-11-02T00:00:00.000Z", ...o });
const audit = (caps: Record<string, unknown>, entries: unknown[] = [entry()], o: Partial<AuditViewProps> = {}) => AuditView({ caps: parseAuditCapabilities(caps), entries: parseAuditEntries({ entries }).entries, names: { 8: "Pat Pitcrew" }, loading: false, failed: false, hasMore: false, filter: { recordType: "", recordId: "" }, historyFor: null, accesses: [], historyLoading: false, requesting: null, shown: {}, errors: {}, busy: false, onFilterChange: noop, onApplyFilter: noop, onLoadMore: noop, onToggleHistory: noop, onRequestStart: noop, onRequestChange: noop, onRequestConfirm: noop, onRequestCancel: noop, onHideValues: noop, ...o });
const CAPS_ADMIN = { isAuditValueReader: false, canReadAuditMetadata: true, valueRetentionDays: 730, metadataRetentionDays: 2555 };
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

test("held imports page: an empty list is said in words on the page, drawn as nothing when embedded; a refused user is told who reviews them and gets no controls", () => {
  assert.equal(heldView([]), null);
  assert.match(text(heldView([], { showEmpty: true })), /No imports are held for review\./);
  const refused = heldView([], { forbidden: true });
  assert.match(text(refused), /reviewed by Administrators and Agents/);
  assert.equal(hasAttr(refused, "data-ae-held-form"), false);
});

/* ── t282u contract: held imports keep their history; the status list is closed and never drops a row; audit-values refusals are documented ──── */
const HIST = [
  { event: "owner_recorded", at: "2026-11-01T01:00:00.000Z", byUserId: 3, ownerUserId: 6, authorityRef: "Initial owner" },
  { event: "held", at: "2026-11-02T01:00:00.000Z", byUserId: 3, reasonCode: "OWNER_INACTIVE" },
  { event: "owner_recorded", at: "2026-11-03T01:00:00.000Z", byUserId: 4, ownerUserId: 4, authorityRef: "Accepted at review INSTR-A2" },
];

test("held imports (t282u): all three statuses parse; a COMPLETED import is listed with its history, its release and no controls", () => {
  const rows = parseHeldImports({ held: [H({ releaseStatus: "held" }), H({ importJobId: 10, releaseStatus: "released", reasonCode: null, release: { ownerUserId: 4, releasedByUserId: 4, authorityRef: "INSTR-A2", releasedAt: "2026-11-03T01:00:00.000Z" }, history: HIST }), H({ importJobId: 11, jobStatus: "COMPLETED", releaseStatus: "completed", reasonCode: null, release: { ownerUserId: 4, releasedByUserId: 4, authorityRef: "INSTR-A2", releasedAt: "2026-11-03T01:00:00.000Z" }, history: HIST })] });
  assert.deepEqual(rows.map((r) => r.releaseStatus), ["held", "released", "completed"]);
  const t = heldView([H({ importJobId: 11, jobStatus: "COMPLETED", releaseStatus: "completed", reasonCode: null, release: { ownerUserId: 4, releasedByUserId: 4, authorityRef: "INSTR-A2", releasedAt: "2026-11-03T01:00:00.000Z" }, history: HIST, canAssignAnyOwner: true })]);
  assert.ok(hasAttr(t, "data-ae-held-import"), "the completed import is still listed");
  assert.match(text(all(t, (e) => e.props?.["data-ae-held-pill"] !== undefined)[0]), /Completed/);
  assert.match(text(t), /Completed\./); assert.match(text(t), /Authority reference: INSTR-A2/);
  assert.equal(hasAttr(t, "data-ae-held-form"), false, "no assign or take-ownership control once it is completed, whatever flags the row carries");
  assert.equal(all(t, (e) => e.props?.["data-ae-held-event"] !== undefined).length, 3, "the three history events are shown, oldest first");
});

test("held imports (t282u): an UNKNOWN status is never dropped and never guessed: it is shown as 'Unknown status', flagged as a contract break, with no action", () => {
  const rows = parseHeldImports({ held: [H({ releaseStatus: "finished" }), H({ importJobId: 12, releaseStatus: null }), { importJobId: 13 }, null] });
  assert.equal(rows.length, 2, "only a row with no id or filename cannot be shown");
  assert.deepEqual(rows.map((r) => r.releaseStatus), ["unknown", "unknown"]);
  assert.equal(rows[0].rawStatus, "finished");
  const t = heldView([H({ releaseStatus: "finished", canAssignAnyOwner: true, canAcceptForSelf: true })]);
  assert.match(text(t), /Unknown status \("finished"\)/); assert.match(text(t), /break in its contract/);
  assert.equal(hasAttr(t, "data-ae-held-unknown"), true); assert.equal(hasAttr(t, "data-ae-held-form"), false, "an unrecognised status offers no action even if the row says it may");
  assert.match(text(all(t, (e) => e.props?.["data-ae-held-pill"] !== undefined)[0]), /Unknown status/);
});

test("held imports (t282u): history events are kept in order and read in words; an unfamiliar event is still shown; names come from the viewer's knowledge", () => {
  const r = parseHeldImports({ held: [H({ releaseStatus: "released", reasonCode: null, history: [...HIST, { event: "mystery", at: "2026-11-04T00:00:00.000Z", byUserId: 3 }, { event: "held" }] })] })[0];
  assert.deepEqual(r.history.map((e) => e.event), ["owner_recorded", "held", "owner_recorded", "unknown"], "an event with no time is dropped; an unfamiliar one is kept");
  const names = (id: number | null) => (id === 4 ? "you" : id === null ? "someone" : `User ${id}`);
  assert.equal(heldEventText(r.history[1], names), "Held for review: The recorded owner is no longer active.");
  assert.equal(heldEventText(r.history[2], names), "Owner recorded at review: you. Authority reference: Accepted at review INSTR-A2.");
  assert.equal(heldEventText({ event: "owner_set", at: "x", byUserId: 3, reasonCode: null, ownerUserId: 6, authorityRef: null }, names), "Owner set at creation: User 6.");
  const t = heldView([H({ releaseStatus: "released", reasonCode: null, history: HIST })], { names: { 3: "Gus Grow" } });
  assert.match(text(t), /Gus Grow/); assert.match(text(t), /Held for review: The recorded owner is no longer active\./);
  assert.doesNotMatch(text(t), /owner_recorded|OWNER_INACTIVE|_/, "no stored key reaches the user");
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
