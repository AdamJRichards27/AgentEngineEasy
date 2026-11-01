import { test } from "node:test";
import assert from "node:assert/strict";
import { Link } from "wouter";
import { LINKING_OFF, MobileContactMessage, MobileContactView, type MobileContactViewProps } from "../../minimal/mobile/MobileContactView";
import { MobilePeopleView, type MobilePeopleViewProps } from "../../minimal/mobile/MobilePeopleView";
import { initialForm } from "../../minimal/mobile/mobileContactForms";
import { buildMobileContactLayout, type MobileContactOptions } from "../../minimal/mobile/mobileContactLayout";
import { buildPeopleRows, peopleCountLine, roleOptions } from "../../minimal/mobile/mobilePeopleLayout";
import type { GrowContact360 } from "../growContact360";
import type { GrowContactability } from "../contactability";
import { all, hrefs, links, text } from "./mobileTreeHelpers";

// AE Mobile (CC Task #64, M4): the phone People list and Contact 360, as drawn.

const NOW = new Date("2026-11-02T09:00:00Z");
const OVERDUE = "2026-10-30T00:00:00Z";
const LATER = "2026-11-06T00:00:00Z";
const noop = () => {};

function consent(status: "ELIGIBLE" | "BLOCKED" | "REVIEW_REQUIRED"): GrowContactability {
  const ch = { channel: "PHONE_CALL", status, reasonCode: "POLICY_INVALID_WINDOW", decision: { recorded: false as const, decision: status, reasonCode: "X", reasonCodes: [], jurisdiction: null, policyVersion: null, purpose: "p", scope: "s", streamRecorded: false, evaluatedAt: "" }, lastRecordedDecision: null, consentState: "UNKNOWN", consent: null, streams: [], dncrStatus: "NOT_CHECKED", dncr: null, suppressed: false, suppression: null };
  return { evaluatedAt: "", status, statusReasonCode: status === "BLOCKED" ? "SUPPRESSED" : "POLICY_INVALID_WINDOW", hasConsentRecords: true, awaitingPolicyApproval: status !== "ELIGIBLE", policies: [], channels: [ch], activeSuppressions: [], history: [], historyTruncated: false };
}
function contact(o: Partial<GrowContact360> = {}): GrowContact360 {
  return {
    contact: { id: 12, partyType: "Person", firstName: "Maya", middleName: null, lastName: "Okafor", organisationName: null, displayName: "Maya Okafor", email: "maya@example.com", mobile: "0491 570 156", residentialAddress: null, createdAt: "", updatedAt: "" },
    assignedAgentUserId: null, roles: ["Seller"], householdRelationships: [], properties: [{ relationshipId: 1, propertyId: 5, propertyAddress: "7 Jacaranda Street", relationshipType: "Owner", role: null, status: "Active", isPrimary: true, validFrom: "", validTo: null }],
    opportunities: [], activities: [],
    commitments: [{ id: 1, description: "Call back about the appraisal", dueAt: OVERDUE, status: "Open", propertyId: null, opportunityId: null, completedAt: null, cancelledAt: null, cancelReason: null }, { id: 2, description: "Send comparable sales", dueAt: LATER, status: "Open", propertyId: null, opportunityId: null, completedAt: null, cancelledAt: null, cancelReason: null }],
    timeline: [{ id: "t1", type: "call", occurredAt: "2026-10-28T00:00:00Z", summary: "Spoke for twelve minutes", propertyId: null, propertyLabel: null, opportunityId: null }],
    intelligence: { roles: [], relatedPropertyCount: 0, mostRecentInteractionAt: null, daysSinceLastInteraction: null, nextFollowUpAt: null, nextFollowUpDescription: null, activeOpportunityCount: 0, recentActivityCount: 0, outstandingCommitmentCount: 0, relationshipAgeDays: null },
    contactability: consent("REVIEW_REQUIRED"), ...o,
  };
}
function contactView(data: GrowContact360, o: Partial<MobileContactViewProps> = {}, opts: Partial<MobileContactOptions> = {}) {
  const layout = buildMobileContactLayout(data, { now: NOW, canLog: true, ...opts });
  return MobileContactView({
    linking: LINKING_OFF, sectionsSlot: null, backHref: "/grow?tab=contacts", layout, historyExpanded: false, onToggleHistory: noop, form: null, formError: null, submitting: false, notice: null,
    pendingCommitmentId: null, onOpenForm: noop, onCloseForm: noop, onField: noop, onSubmit: noop, onComplete: noop, ...o,
  });
}
const button = (tree: unknown, label: string) => all(tree, (e) => e.type === "button" && text(e) === label);

function peopleView(o: Partial<MobilePeopleViewProps> = {}) {
  const rows = buildPeopleRows([{ contacts: [{ id: 1, displayName: "Maya Okafor", partyType: "Person", email: "m@example.com", mobile: "0491 570 156", roles: ["Seller", "PastClient"], relatedPropertyCount: 2 }], total: 60, nextCursor: "c" }]);
  return MobilePeopleView({
    sectionsSlot: null, search: "", role: "", roleOptions: roleOptions(), countLine: peopleCountLine(1, 60), rows, emptyText: null, loading: false, error: null,
    canLoadMore: true, loadingMore: false, addHref: "/grow?tab=contacts&view=full", importHref: "/grow/import", onSearch: noop, onRole: noop, onLoadMore: noop, ...o,
  });
}

// ── People ───────────────────────────────────────────────────────────────

test("People: one heading, a labelled search, a role select with plain words, a count, rows that open a person", () => {
  const tree = peopleView();
  assert.equal(all(tree, (e) => e.type === "h1").length, 1);
  assert.equal(text(all(tree, (e) => e.type === "h1")[0]), "People");
  const input = all(tree, (e) => e.type === "input")[0];
  assert.equal(input.props?.["aria-label"], "Search people");
  assert.equal(input.props?.type, "search");
  assert.equal(input.props?.placeholder, "Search by name, organisation or email");
  const select = all(tree, (e) => e.type === "select")[0];
  assert.equal(select.props?.["aria-label"], "Filter by role");
  assert.match(text(select), /All roles/);
  assert.match(text(select), /Past client/);
  assert.match(text(tree), /Showing 1 of 60 people/);
  assert.deepEqual(hrefs(tree).filter((h) => h.startsWith("/grow/contacts/")), ["/grow/contacts/1"]);
  assert.match(text(tree), /0491 570 156/);
  assert.doesNotMatch(text(tree), /linked propert/i);
  assert.match(text(tree), /Past client/);
});

test("People: typing, the role and Show more call back; Add and Import show only when offered", () => {
  const seen: string[] = [];
  const tree = peopleView({ onSearch: (t) => seen.push(`s:${t}`), onRole: (r) => seen.push(`r:${r}`), onLoadMore: () => seen.push("more") });
  (all(tree, (e) => e.type === "input")[0].props?.onChange as (e: { target: { value: string } }) => void)({ target: { value: "maya" } });
  (all(tree, (e) => e.type === "select")[0].props?.onChange as (e: { target: { value: string } }) => void)({ target: { value: "Seller" } });
  (button(tree, "Show more people")[0].props?.onClick as () => void)();
  assert.deepEqual(seen, ["s:maya", "r:Seller", "more"]);
  assert.deepEqual(links(tree).filter((l) => ["Add a person", "Import contacts"].includes(text(l))).map((l) => String(l.props?.href)), ["/grow?tab=contacts&view=full", "/grow/import"]);
  const bare = peopleView({ addHref: null, importHref: null, canLoadMore: false });
  assert.equal(links(bare).some((l) => /Add a person|Import contacts/.test(text(l))), false);
  assert.equal(button(bare, "Show more people").length, 0);
  const loadingMore = peopleView({ loadingMore: true });
  assert.equal(all(loadingMore, (e) => e.type === "button" && e.props?.disabled === true).length, 1);
});

test("People: empty, loading and error states", () => {
  assert.match(text(peopleView({ rows: [], emptyText: "No people match “zzz”. Try a different name, organisation or email." })), /No people match “zzz”/);
  assert.match(text(peopleView({ loading: true, rows: [] })), /Loading people…/);
  let retried = 0;
  const err = peopleView({ rows: [], error: { text: "Couldn't load people.", onRetry: () => { retried++; } } });
  assert.equal(all(err, (e) => e.props?.role === "alert").length, 1);
  (button(err, "Try again")[0].props?.onClick as () => void)();
  assert.equal(retried, 1);
});

// ── Contact 360 ──────────────────────────────────────────────────────────

test("Contact: one heading, a way back, the name, roles in plain words", () => {
  const tree = contactView(contact());
  assert.equal(text(all(tree, (e) => e.type === "h1")[0]), "Maya Okafor");
  assert.equal(all(tree, (e) => e.type === "h1").length, 1);
  assert.equal(hrefs(tree)[0], "/grow?tab=contacts");
  assert.match(text(tree), /Seller/);
});

test("Contact: tap to call is a real tel: link for the phone's own dialler, naming the number, with no consent prompt", () => {
  const tree = contactView(contact());
  const dial = all(tree, (e) => e.type === "a" && String(e.props?.href).startsWith("tel:"));
  assert.equal(dial.length, 1);
  assert.equal(dial[0].props?.href, "tel:0491570156");
  assert.equal(text(dial[0]), "Call mobile 0491 570 156");
  assert.equal(dial[0].props?.className, "mob-c-call");
  assert.equal(dial[0].props?.["aria-label"], "Call Maya Okafor, mobile 0491 570 156");
  assert.doesNotMatch(text(tree), /Needs review before contacting/);
  assert.equal(all(tree, (e) => e.props?.role === "alert").length, 0, "nothing to confirm before a call");
});

test("Contact: a contact who must not be contacted gets no call link, and the reason is announced", () => {
  const tree = contactView(contact({ contactability: consent("BLOCKED") }));
  assert.equal(all(tree, (e) => e.type === "a" && String(e.props?.href).startsWith("tel:")).length, 0);
  const alerts = all(tree, (e) => e.props?.role === "alert").map((e) => text(e));
  assert.ok(alerts.some((a) => /^Do not contact\./.test(a)));
  assert.match(text(all(tree, (e) => e.type === "section" && e.props?.["aria-label"] === "Contactability")[0]), /Do not contact/);
});

test("Contact: tapping the call link tells the container (to offer Log call later) and does not stop the dialler", () => {
  const tapped: string[] = [];
  const tree = contactView(contact(), { onCall: (o) => { tapped.push(o.href); } });
  const dial = all(tree, (e) => e.type === "a" && String(e.props?.href).startsWith("tel:"))[0];
  const result = (dial.props?.onClick as (e?: unknown) => unknown)();
  assert.deepEqual(tapped, ["tel:0491570156"]);
  assert.equal(result, undefined, "no preventDefault, no return value: the link opens the dialler");
  assert.equal(all(contactView(contact({ contact: { ...contact().contact, mobile: null } })), (e) => e.type === "a" && String(e.props?.href).startsWith("tel:")).length, 0);
  assert.match(text(contactView(contact({ contact: { ...contact().contact, mobile: null } }))), /No phone number recorded/);
});

test("Contact: back from a call, Log call is offered and saves nothing by itself", () => {
  let logged = 0;
  let dismissed = 0;
  const offer = { partyId: 12, name: "Maya Okafor", label: "Mobile", display: "0491 570 156", startedAt: 1, hiddenAt: 2 };
  const tree = contactView(contact(), { callOffer: offer, onLogOffer: () => { logged++; }, onDismissOffer: () => { dismissed++; } });
  const box = all(tree, (e) => e.props?.["data-ae-call-return"] !== undefined)[0];
  assert.match(text(box), /Back from calling Maya Okafor\?/);
  assert.match(text(box), /mobile 0491 570 156/);
  (all(box, (e) => e.type === "button" && text(e) === "Log call")[0].props?.onClick as () => void)();
  (all(box, (e) => e.type === "button" && text(e) === "Not now")[0].props?.onClick as () => void)();
  assert.deepEqual([logged, dismissed], [1, 1]);
  assert.equal(all(contactView(contact()), (e) => e.props?.["data-ae-call-return"] !== undefined).length, 0, "no offer unless the agent has just been away on a call");
});

test("Contact: the one next step has one obvious button, and the same commitment is not listed again", () => {
  const complete: number[] = [];
  const open: Array<[string, number | undefined]> = [];
  const tree = contactView(contact(), { onComplete: (id) => complete.push(id), onOpenForm: (k, id) => open.push([k, id]) });
  const next = all(tree, (e) => e.type === "section" && e.props?.["aria-label"] === "Next step")[0];
  assert.match(text(next), /Call back about the appraisal/);
  assert.match(text(next), /Overdue/);
  (button(next, "Mark done")[0].props?.onClick as () => void)();
  (button(next, "Reschedule")[0].props?.onClick as () => void)();
  assert.deepEqual(complete, [1]);
  assert.deepEqual(open, [["reschedule", 1]]);
  const promised = all(tree, (e) => e.type === "section" && e.props?.["aria-label"] === "Commitments")[0];
  assert.match(text(promised), /Also promised/);
  assert.match(text(promised), /Send comparable sales/);
  assert.equal(text(promised).includes("Call back about the appraisal"), false, "no duplicate");
});

test("Contact: with nothing promised, the next step is to add a commitment", () => {
  let opened = "";
  const tree = contactView(contact({ commitments: [] }), { onOpenForm: (k) => { opened = k; } });
  const next = all(tree, (e) => e.type === "section" && e.props?.["aria-label"] === "Next step")[0];
  assert.match(text(next), /No next step set/);
  (button(next, "Add a commitment")[0].props?.onClick as () => void)();
  assert.equal(opened, "commitment");
  assert.match(text(tree), /No open commitments\./);
});

test("Contact: the write buttons are the four verified things plus the full record, only for users who may write", () => {
  const writer = contactView(contact());
  const labels = all(writer, (e) => (e.type === "button" || e.type === Link) && ["Add a note", "Log a call or meeting", "Add a commitment", "Open full record"].includes(text(e))).map((e) => text(e));
  assert.deepEqual(labels.sort(), ["Add a commitment", "Add a note", "Log a call or meeting", "Open full record"]);
  const reader = contactView(contact(), {}, { canLog: false });
  assert.equal(all(reader, (e) => e.type === "button" && ["Add a note", "Log a call or meeting", "Add a commitment", "Mark done", "Reschedule"].includes(text(e))).length, 0);
  assert.deepEqual(links(reader).filter((l) => text(l) === "Open full record").map((l) => l.props?.href), ["/grow/contacts/12?view=full"]);
  const body = text(writer);
  for (const absent of ["SMS", "Message", "Compose", "Edit contact", "Cancel commitment", "Set due follow-up"]) {
    assert.equal(body.includes(absent), false, `${absent}: no button without a verified route`);
  }
});

test("Contact: opening a form shows one form, labelled fields, a plain note, and Save and Cancel", () => {
  const changed: Array<[string, string]> = [];
  let submitted = 0;
  let closed = 0;
  const form = initialForm("call", NOW);
  const tree = contactView(contact(), { form, onField: (n, v) => changed.push([n, v]), onSubmit: () => { submitted++; }, onCloseForm: () => { closed++; } });
  const forms = all(tree, (e) => e.type === "form");
  assert.equal(forms.length, 1);
  assert.equal(forms[0].props?.["aria-label"], "Log a call or meeting");
  assert.match(text(forms[0]), /This records a call or meeting you already had\. AE does not place or record the call itself\./);
  const fields = all(forms[0], (e) => ["textarea", "input", "select"].includes(String(e.type)));
  assert.deepEqual(fields.map((f) => f.props?.["aria-label"]), ["What happened", "When", "What was said"]);
  (fields[2].props?.onChange as (e: { target: { value: string } }) => void)({ target: { value: "Spoke" } });
  assert.deepEqual(changed, [["summary", "Spoke"]]);
  (forms[0].props?.onSubmit as (e: { preventDefault: () => void }) => void)({ preventDefault: () => {} });
  assert.equal(submitted, 1);
  (button(forms[0], "Cancel")[0].props?.onClick as () => void)();
  assert.equal(closed, 1);
  assert.equal(button(forms[0], "Save").length, 1);
});

test("Contact: a form error is announced, saving disables the button, and a result line says what happened", () => {
  const errTree = contactView(contact(), { form: initialForm("note", NOW), formError: "A note can't be blank." });
  assert.ok(all(errTree, (e) => e.props?.role === "alert").some((e) => text(e) === "A note can't be blank."));
  const saving = contactView(contact(), { form: initialForm("note", NOW), submitting: true });
  assert.equal(all(saving, (e) => e.type === "button" && e.props?.type === "submit" && e.props?.disabled === true).length, 1);
  assert.match(text(saving), /Saving…/);
  assert.equal(all(contactView(contact(), { notice: { text: "Note saved.", failed: false } }), (e) => e.props?.role === "status" && text(e) === "Note saved.").length, 1);
  assert.equal(all(contactView(contact(), { notice: { text: "That didn't go through.", failed: true } }), (e) => e.props?.role === "alert" && text(e) === "That didn't go through.").length, 1);
});

test("Contact: the screen never says a call is, will be or can be recorded", () => {
  for (const kind of ["note", "call", "commitment", "reschedule"] as const) {
    const body = text(contactView(contact(), { form: initialForm(kind, NOW, 1) }));
    assert.doesNotMatch(body, /\b(is|are|will be|can be|was|were|being)\s+recorded\b|recording|call recording/i, kind);
  }
});

test("Contact: properties link as search does, history shows six then Show all, and the rest is the full record", () => {
  const tree = contactView(contact());
  assert.deepEqual(hrefs(tree).filter((h) => h.includes("/properties/")), ["/grow/properties/5"]);
  assert.match(text(tree), /Owner · Primary/);
  assert.match(text(tree), /Spoke for twelve minutes/);
  assert.match(text(tree), /Call/);
  const many = contact({ timeline: Array.from({ length: 9 }, (_, i) => ({ id: `e${i}`, type: "note", occurredAt: `2026-10-${10 + i}T00:00:00Z`, summary: `Event ${i}`, propertyId: null, propertyLabel: null, opportunityId: null })) });
  let toggled = 0;
  const collapsed = contactView(many, { onToggleHistory: () => { toggled++; } });
  const btn = button(collapsed, "Show all 9")[0];
  assert.equal(btn.props?.["aria-expanded"], false);
  (btn.props?.onClick as () => void)();
  assert.equal(toggled, 1);
  assert.equal(button(contactView(many, { historyExpanded: true }, { expandedHistory: true }), "Show fewer").length, 1);
});

test("Contact: loading failed states keep a way back and a retry", () => {
  let retried = 0;
  const msg = MobileContactMessage({ text: "Couldn't load this contact.", backHref: "/grow?tab=contacts", onRetry: () => { retried++; } });
  assert.equal(hrefs(msg)[0], "/grow?tab=contacts");
  assert.equal(all(msg, (e) => e.props?.role === "alert").length, 1);
  (button(msg, "Try again")[0].props?.onClick as () => void)();
  assert.equal(retried, 1);
  assert.equal(button(MobileContactMessage({ text: "x", backHref: "/y" }), "Try again").length, 0);
});

test("the word Performance never appears", () => {
  assert.doesNotMatch(text(contactView(contact())) + text(peopleView()), /performance/i);
});
