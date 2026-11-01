import { test } from "node:test";
import assert from "node:assert/strict";
import { Link } from "wouter";
import { LINKING_OFF, MobileContactView, type ContactLinkingProps, type MobileContactViewProps } from "../../minimal/mobile/MobileContactView";
import { MobileLinkPicker, type MobileLinkPickerProps, type PickerCreateProps } from "../../minimal/mobile/MobileLinkPicker";
import { MobilePropertyContactsView, type MobilePropertyContactsViewProps, type PropertyAppraisalProps } from "../../minimal/mobile/MobilePropertyContactsView";
import { buildMobileContactLayout } from "../../minimal/mobile/mobileContactLayout";
import { NOT_AVAILABLE_YET, NO_PERMISSION, linkingCapabilities, roleChoices } from "../../minimal/mobile/mobileLinking";
import { GROW_PROPERTIES_LINK, GROW_RELATIONSHIPS_MANAGE, MOBILE_LINKING, type LinkingFlags } from "../../minimal/mobile/mobileLinkingConfig";
import { mobileLinkedContacts } from "../../minimal/mobile/mobilePropertyContactRows";
import type { CallOption } from "../../minimal/mobile/mobileCalling";
import type { GrowContact360 } from "../growContact360";
import { all, hrefs, links, text } from "./mobileTreeHelpers";

// AE Mobile (CC Task #64, M4 linking): the link controls on Contact 360 and on a property, as drawn.

const NOW = new Date("2026-11-02T09:00:00Z");
const ON: LinkingFlags = { contactLinkProperty: true, contactEditRole: true, contactUnlink: true, contactEditPrimary: true, contactCanonicalRead: true, propertyLinkContact: true, propertyEditRole: true, propertyEditPrimary: true, propertyUnlink: true };
const MANAGER = [GROW_RELATIONSHIPS_MANAGE, GROW_PROPERTIES_LINK];
const noop = () => {};

function data(): GrowContact360 {
  return {
    contact: { id: 12, partyType: "Person", firstName: "Maya", middleName: null, lastName: "Okafor", organisationName: null, displayName: "Maya Okafor", email: "m@example.com", mobile: null, residentialAddress: null, createdAt: "", updatedAt: "" },
    assignedAgentUserId: null, roles: [], householdRelationships: [],
    properties: [{ relationshipId: 5, propertyId: 77, propertyAddress: "7 Jacaranda Street", relationshipType: "related_party", role: "Executor", status: "Active", isPrimary: true, validFrom: "", validTo: null }],
    opportunities: [], activities: [], commitments: [], timeline: [],
    intelligence: { roles: [], relatedPropertyCount: 0, mostRecentInteractionAt: null, daysSinceLastInteraction: null, nextFollowUpAt: null, nextFollowUpDescription: null, activeOpportunityCount: 0, recentActivityCount: 0, outstandingCommitmentCount: 0, relationshipAgeDays: null },
    contactability: { evaluatedAt: "", status: "ELIGIBLE", statusReasonCode: "X", hasConsentRecords: true, awaitingPolicyApproval: false, policies: [], channels: [], activeSuppressions: [], history: [], historyTruncated: false },
  };
}
const CANON = [
  { linkId: 31, role: "Seller", isPrimary: true, propertyId: 77, address: "7 Jacaranda Street" },
  { linkId: 32, role: "Tenant", isPrimary: false, propertyId: 78, address: "22 Banksia Avenue" },
];
function picker(o: Partial<MobileLinkPickerProps> = {}): MobileLinkPickerProps {
  return { title: "Link a property", searchLabel: "Search properties", searchPlaceholder: "Address", query: "", rows: [], message: null, loading: false, selectedId: null, choiceLabel: "Their relationship to the property", choices: roleChoices(), choice: "", submitLabel: "Link property", submitting: false, error: null, onQuery: noop, onSelect: noop, onChoice: noop, onSubmit: noop, onCancel: noop, ...o };
}
function linking(o: Partial<ContactLinkingProps> = {}, entitlements: string[] = MANAGER, flags: LinkingFlags = ON): ContactLinkingProps {
  return { ...LINKING_OFF, capabilities: linkingCapabilities(entitlements, flags), roleOptions: roleChoices({ expandedRolesAccepted: true }), ...o };
}
function contactView(l: ContactLinkingProps, canonical: boolean = true) {
  const layout = buildMobileContactLayout(data(), { now: NOW, canLog: true, canonicalLinks: canonical ? CANON : null });
  const props: MobileContactViewProps = { linking: l, sectionsSlot: null, backHref: "/grow?tab=contacts", layout, historyExpanded: false, onToggleHistory: noop, form: null, formError: null, submitting: false, notice: null, pendingCommitmentId: null, onOpenForm: noop, onCloseForm: noop, onField: noop, onSubmit: noop, onComplete: noop };
  return MobileContactView(props);
}
const props = (tree: unknown) => all(tree, (e) => e.type === "section" && e.props?.["aria-label"] === "Properties")[0];
const buttons = (tree: unknown, label: string) => all(tree, (e) => e.type === "button" && text(e) === label);
const call = (fn: unknown, ...a: unknown[]) => (fn as (...x: unknown[]) => void)(...a);

// ── Contact 360 ──────────────────────────────────────────────────────────

test("Contact 360 lists each canonical link with its role in plain words, and opens the property in one tap", () => {
  const section = props(contactView(LINKING_OFF));
  assert.match(text(section), /7 Jacaranda Street/);
  assert.match(text(section), /Seller \/ owner · Primary/);
  assert.match(text(section), /Tenant/);
  assert.deepEqual(hrefs(section), ["/grow/properties/77", "/grow/properties/78"]);
  assert.deepEqual(links(section).map((l) => l.props?.["aria-label"]), ["Open 7 Jacaranda Street", "Open 22 Banksia Avenue"]);
});

test("while the backend cannot read canonical links, the screen shows what the payload carries, read-only: never merged, never editable", () => {
  const section = props(contactView(linking(), false));
  assert.match(text(section), /Related party · Executor/);
  assert.equal(/Seller|Tenant/.test(text(section)), false, "no canonical row mixed in");
  for (const b of [...buttons(section, "Edit role"), ...buttons(section, "Unlink")]) assert.equal(b.props?.disabled, true, "a legacy row has no canonical link to act on, even with every flag on");
  assert.equal(buttons(section, "Link a property")[0].props?.disabled, false, "linking a new canonical link is separate from showing old rows");
});

test("as shipped every control is disabled, says why once, and opens nothing", () => {
  const opened: unknown[] = [];
  const section = props(contactView({ ...LINKING_OFF, onOpen: (p) => opened.push(p) }));
  for (const label of ["Edit role", "Unlink", "Link a property"]) for (const b of buttons(section, label)) assert.equal(b.props?.disabled, true, label);
  assert.equal(buttons(section, "Edit role").length, 2, "one per property");
  assert.deepEqual(all(section, (e) => e.props?.id === "mob-c-link-reason").map((e) => text(e)), [NOT_AVAILABLE_YET]);
  assert.equal(all(section, (e) => e.type === "form" || e.props?.role === "alertdialog").length, 0);
  assert.deepEqual(opened, []);
});

test("a read-only agent sees the same controls disabled with a permission reason", () => {
  const section = props(contactView(linking({}, ["grow.access", "grow.contacts.read"])));
  for (const b of all(section, (e) => e.type === "button" && ["Edit role", "Unlink", "Link a property"].includes(text(e)))) assert.equal(b.props?.disabled, true);
  assert.deepEqual(all(section, (e) => e.props?.id === "mob-c-link-reason").map((e) => text(e)), [NO_PERMISSION]);
});

test("an authorised agent: buttons are enabled and open the right panel for the right link", () => {
  const opened: unknown[] = [];
  const section = props(contactView(linking({ onOpen: (p) => opened.push(p) })));
  assert.equal(all(section, (e) => e.props?.id === "mob-c-link-reason").length, 0, "nothing to explain");
  const edit = buttons(section, "Edit role");
  const unlink = buttons(section, "Unlink");
  for (const b of [...edit, ...unlink, ...buttons(section, "Link a property")]) assert.equal(b.props?.disabled, false);
  call(edit[1].props?.onClick);
  call(unlink[0].props?.onClick);
  call(buttons(section, "Link a property")[0].props?.onClick);
  assert.deepEqual(opened, [{ kind: "edit", relationshipId: 32 }, { kind: "unlink", relationshipId: 31 }, { kind: "link" }], "the canonical link id");
});

test("unlink asks first, names both sides, shows only on its own link, and a failure is announced", () => {
  let confirmed = 0;
  let kept = 0;
  const section = props(contactView(linking({ panel: { kind: "unlink", relationshipId: 31 }, error: "That contact is already linked.", onConfirmUnlink: () => { confirmed++; }, onClose: () => { kept++; } })));
  const dialogs = all(section, (e) => e.props?.role === "alertdialog");
  assert.equal(dialogs.length, 1);
  assert.equal(text(dialogs[0]).startsWith("Unlink Maya Okafor from 7 Jacaranda Street? This ends the link. The contact and the property stay."), true);
  assert.equal(text(section).includes("Unlink Maya Okafor from 22 Banksia Avenue"), false);
  assert.deepEqual(all(dialogs[0], (e) => e.props?.role === "alert").map((e) => text(e)), ["That contact is already linked."]);
  call(buttons(dialogs[0], "Unlink")[0].props?.onClick);
  call(buttons(dialogs[0], "Keep link")[0].props?.onClick);
  assert.deepEqual([confirmed, kept], [1, 1]);
  assert.equal(all(props(contactView(linking({ panel: { kind: "unlink", relationshipId: 31 }, submitting: true }))), (e) => e.type === "button" && /Unlinking/.test(text(e)))[0].props?.disabled, true);
});

test("edit role: a choice from the role list, saved through the form; the expanded roles appear when the server validates them", () => {
  const changed: string[] = [];
  let saved = 0;
  const section = props(contactView(linking({ panel: { kind: "edit", relationshipId: 32 }, roleValue: "Tenant", onRoleChange: (v) => changed.push(v), onSubmitRole: () => { saved++; } })));
  const form = all(section, (e) => e.type === "form")[0];
  assert.equal(form.props?.["aria-label"], "Edit role");
  const select = all(form, (e) => e.type === "select")[0];
  assert.equal(select.props?.value, "Tenant");
  assert.match(text(select), /Landlord/);
  assert.match(text(form), /Currently: Tenant\./);
  call(select.props?.onChange, { target: { value: "Landlord" } });
  call(form.props?.onSubmit, { preventDefault: () => {} });
  assert.deepEqual([changed, saved], [["Landlord"], 1]);
  assert.equal(all(section, (e) => e.type === "input").length, 0, "no free-text role: property_parties holds a role from the list");
  const asShipped = props(contactView(linking({ panel: { kind: "edit", relationshipId: 32 }, roleOptions: roleChoices() })));
  assert.equal(/Landlord/.test(text(asShipped)), false, "Owner, Landlord and Tenant are not offered ahead of the server");
});

test("link a property opens a picker; the agent picks a result and a role before Link is possible", () => {
  const l = linking({ panel: { kind: "link" }, picker: picker({ query: "jac", rows: [{ id: 91, title: "9 Jacaranda Street", subtitle: "Paddington QLD 4064" }] }) });
  const form = all(props(contactView(l)), (e) => e.type === "form")[0];
  assert.equal(form.props?.["aria-label"], "Link a property");
  assert.match(text(form), /9 Jacaranda Street/);
  assert.equal(all(form, (e) => e.type === "button" && e.props?.type === "submit")[0].props?.disabled, true, "nothing selected, nothing chosen");
});

// ── The picker ───────────────────────────────────────────────────────────

test("picker: results are options, selection is announced, nothing is pre-selected, Link needs both choices", () => {
  const rows = [{ id: 91, title: "9 Jacaranda Street", subtitle: "Paddington QLD 4064" }, { id: 92, title: "11 Jacaranda Street", subtitle: "Paddington QLD 4064" }];
  const submitBtn = (t: unknown) => all(t, (e) => e.type === "button" && e.props?.type === "submit")[0];
  assert.equal(submitBtn(MobileLinkPicker(picker({ rows }))).props?.disabled, true);
  assert.equal(submitBtn(MobileLinkPicker(picker({ rows, selectedId: 91 }))).props?.disabled, true, "selected but no role");
  assert.equal(submitBtn(MobileLinkPicker(picker({ rows, choice: "Seller" }))).props?.disabled, true, "a role but nothing selected");
  const ready = MobileLinkPicker(picker({ rows, selectedId: 91, choice: "Seller" }));
  assert.equal(submitBtn(ready).props?.disabled, false);
  assert.deepEqual(all(ready, (e) => e.props?.role === "option").map((o) => o.props?.["aria-selected"]), [true, false]);
  const picked: number[] = [];
  call(all(MobileLinkPicker(picker({ rows, onSelect: (id) => picked.push(id) })), (e) => e.props?.role === "option")[1].props?.onClick);
  assert.deepEqual(picked, [92]);
  assert.match(text(all(ready, (e) => e.type === "select")[0]), /Choose…/);
});

test("picker: submitting calls back once, only when ready; searching, messages, errors and Cancel", () => {
  let submitted = 0;
  let cancelled = 0;
  const ready = MobileLinkPicker(picker({ rows: [{ id: 1, title: "A", subtitle: "" }], selectedId: 1, choice: "Seller", onSubmit: () => { submitted++; }, onCancel: () => { cancelled++; } }));
  call(all(ready, (e) => e.type === "form")[0].props?.onSubmit, { preventDefault: () => {} });
  call(all(ready, (e) => e.type === "button" && text(e) === "Cancel")[0].props?.onClick);
  assert.deepEqual([submitted, cancelled], [1, 1]);
  call(all(MobileLinkPicker(picker({ onSubmit: () => { submitted++; } })), (e) => e.type === "form")[0].props?.onSubmit, { preventDefault: () => {} });
  assert.equal(submitted, 1, "an unready form submits nothing");
  assert.match(text(MobileLinkPicker(picker({ loading: true }))), /Searching…/);
  assert.match(text(MobileLinkPicker(picker({ message: "No people or properties match “zzz”." }))), /match “zzz”/);
  assert.equal(all(MobileLinkPicker(picker({ error: "That contact is already linked." })), (e) => e.props?.role === "alert").length, 1);
  assert.equal(all(MobileLinkPicker(picker()), (e) => e.type === "input")[0].props?.type, "search");
  assert.equal(text(MobileLinkPicker(picker({ submitting: true }))).includes("Linking…"), true);
});

function create(o: Partial<PickerCreateProps> = {}): PickerCreateProps {
  return { open: false, name: "", email: "", phone: "", creating: false, error: null, onOpen: noop, onField: noop, onSubmit: noop, onCancel: noop, ...o };
}

test("picker: Add new contact is the existing panel's own function: closed, a Name/Email/Phone form, a duplicate answer, and the new contact selectable", () => {
  assert.equal(all(MobileLinkPicker(picker()), (e) => e.props?.["data-ae-new-contact"] !== undefined).length, 0, "absent without the permission");
  const closed = MobileLinkPicker(picker({ create: create() }));
  const opener = all(closed, (e) => e.props?.["data-ae-new-contact"] !== undefined)[0];
  assert.equal(text(opener), "Add new contact");
  let opened = 0;
  call(all(MobileLinkPicker(picker({ create: create({ onOpen: () => { opened++; } }) })), (e) => e.props?.["data-ae-new-contact"] !== undefined)[0].props?.onClick);
  assert.equal(opened, 1);
  const fields: string[] = [];
  let submitted = 0;
  const open = MobileLinkPicker(picker({ create: create({ open: true, name: "Zed", email: "z@example.com", phone: "0400", error: "A contact with that email or phone already exists. Search for them and link the existing contact instead.", onField: (f, v) => fields.push(`${f}=${v}`), onSubmit: () => { submitted++; } }) }));
  assert.deepEqual(all(open, (e) => e.type === "input" && e.props?.type !== "search").map((e) => e.props?.["aria-label"]), ["Name", "Email", "Phone"]);
  for (const input of all(open, (e) => e.type === "input" && e.props?.type !== "search")) call(input.props?.onChange, { target: { value: "x" } });
  assert.deepEqual(fields, ["name=x", "email=x", "phone=x"]);
  call(buttons(open, "Create contact")[0].props?.onClick);
  assert.equal(submitted, 1);
  assert.match(text(open), /already exists\. Search for them and link the existing contact instead\./);
  assert.equal(all(MobileLinkPicker(picker({ create: create({ open: true, creating: true }) })), (e) => e.type === "button" && /Creating/.test(text(e)))[0].props?.disabled, true);
  const withCreated = MobileLinkPicker(picker({ createdRow: { id: 55, title: "Zed Zane", subtitle: "New contact" }, rows: [{ id: 1, title: "A", subtitle: "" }], selectedId: 55, choice: "Buyer" }));
  assert.deepEqual(all(withCreated, (e) => e.props?.role === "option").map((o) => text(o).slice(0, 8)), ["Zed Zane", "A"]);
  assert.equal(all(withCreated, (e) => e.type === "button" && e.props?.type === "submit")[0].props?.disabled, false, "the new contact can be linked straight away");
});

// ── A property's contacts ────────────────────────────────────────────────

const linked = mobileLinkedContacts([
  { linkId: 31, role: "Seller", isPrimary: true, party: { id: 12, firstName: "Maya", lastName: "Okafor", email: "m@example.com", mobile: "0491 570 156" } },
  { linkId: 32, role: "PowerOfAttorney", party: { id: 13, firstName: "Sam", lastName: "Lee" } },
]);
function appraisal(o: Partial<PropertyAppraisalProps> = {}): PropertyAppraisalProps {
  return { existingHref: null, candidates: [{ partyId: 12, name: "Maya Okafor" }, { partyId: 13, name: "Sam Lee" }], canStart: true, starting: false, error: null, onStart: noop, ...o };
}
function propertyView(o: Partial<MobilePropertyContactsViewProps> = {}) {
  return MobilePropertyContactsView({
    propertyLabel: "7 Jacaranda Street", contacts: linked, loading: false, error: null, capabilities: linkingCapabilities(MANAGER, ON), panel: null, submitting: false,
    opError: null, notice: null, roleValue: "", roleOptions: roleChoices({ expandedRolesAccepted: true }), appraisal: appraisal(), picker: null,
    callState: {}, onCall: noop, callOffer: null, onDismissOffer: noop, onMakePrimary: noop,
    onOpen: noop, onClose: noop, onRoleChange: noop, onSubmitRole: noop, onConfirmUnlink: noop, ...o,
  });
}

test("a property lists every linked contact with their role, and opens each in one tap", () => {
  const tree = propertyView();
  for (const re of [/Maya Okafor/, /Seller \/ owner/, /Power of attorney/, /0491 570 156/]) assert.match(text(tree), re);
  assert.deepEqual(hrefs(tree).filter((h) => h.startsWith("/grow/contacts")), ["/grow/contacts/12", "/grow/contacts/13"]);
  assert.match(text(propertyView({ contacts: [] })), /No contact linked yet\. Link a contact to start an appraisal\./);
});

test("as shipped, Edit role, Unlink and Link a contact are disabled with one reason; a read-only agent sees the permission reason", () => {
  const off = propertyView({ capabilities: linkingCapabilities(MANAGER) });
  for (const label of ["Unlink", "Link a contact", "Edit role"]) for (const b of buttons(off, label)) assert.equal(b.props?.disabled, true, label);
  assert.deepEqual(all(off, (e) => e.props?.id === "mob-c-link-reason").map((e) => text(e)), [NOT_AVAILABLE_YET]);
  const readOnly = propertyView({ capabilities: linkingCapabilities(["grow.access"], ON) });
  assert.deepEqual(all(readOnly, (e) => e.props?.id === "mob-c-link-reason").map((e) => text(e)), [NO_PERMISSION]);
  assert.deepEqual(Object.values(MOBILE_LINKING).filter(Boolean), []);
});

test("the same four operations are enabled together for a full-permission agent, and open the right panel for the right link", () => {
  const opened: unknown[] = [];
  const tree = propertyView({ onOpen: (p) => opened.push(p) });
  for (const label of ["Edit role", "Unlink", "Link a contact"]) for (const b of buttons(tree, label)) assert.equal(b.props?.disabled, false, label);
  call(buttons(tree, "Edit role")[1].props?.onClick);
  call(buttons(tree, "Unlink")[0].props?.onClick);
  call(buttons(tree, "Link a contact")[0].props?.onClick);
  assert.deepEqual(opened, [{ kind: "role", linkId: 32 }, { kind: "unlink", linkId: 31 }, { kind: "link" }]);
});

test("edit role on a property: a choice from the list, saved through the form, only on its own contact", () => {
  let saved = 0;
  const tree = propertyView({ panel: { kind: "role", linkId: 32 }, roleValue: "Buyer", onSubmitRole: () => { saved++; }, opError: "That is already their role." });
  const forms = all(tree, (e) => e.type === "form" && e.props?.["aria-label"] === "Edit role");
  assert.equal(forms.length, 1);
  assert.match(text(forms[0]), /Currently: Power of attorney\./);
  assert.match(text(forms[0]), /Landlord/);
  assert.equal(all(forms[0], (e) => e.type === "select")[0].props?.value, "Buyer");
  assert.equal(all(forms[0], (e) => e.props?.role === "alert").length, 1);
  call(forms[0].props?.onSubmit, { preventDefault: () => {} });
  assert.equal(saved, 1);
});

test("unlinking a contact from a property asks first, names both, and calls back only on confirm", () => {
  let confirmed = 0;
  const asking = propertyView({ panel: { kind: "unlink", linkId: 32 }, onConfirmUnlink: () => { confirmed++; } });
  const dialog = all(asking, (e) => e.props?.role === "alertdialog");
  assert.equal(dialog.length, 1);
  assert.match(text(dialog[0]), /Unlink Sam Lee from 7 Jacaranda Street\? This ends the link\. The contact and the property stay\./);
  call(buttons(dialog[0], "Unlink")[0].props?.onClick);
  assert.equal(confirmed, 1);
});

test("Start appraisal is preserved and is NOT behind the link flags: one candidate says Start appraisal, several name the contact", () => {
  const off = propertyView({ capabilities: linkingCapabilities(MANAGER), appraisal: appraisal({ candidates: [{ partyId: 12, name: "Maya Okafor" }] }) });
  const single = all(off, (e) => e.props?.["data-ae-start-appraisal"] !== undefined);
  assert.deepEqual(single.map((b) => text(b)), ["Start appraisal"]);
  assert.equal(single[0].props?.disabled, false, "the link controls being off does not disable it");
  const several = propertyView({ capabilities: linkingCapabilities(MANAGER) });
  assert.deepEqual(all(several, (e) => e.props?.["data-ae-start-appraisal"] !== undefined).map((b) => text(b)), ["Start appraisal with Maya Okafor", "Start appraisal with Sam Lee"]);
  const started: number[] = [];
  const t = propertyView({ appraisal: appraisal({ onStart: (id) => started.push(id) }) });
  call(all(t, (e) => e.props?.["data-ae-start-appraisal"] === 13)[0].props?.onClick);
  assert.deepEqual(started, [13]);
  assert.equal(all(propertyView({ appraisal: appraisal({ starting: true }) }), (e) => e.props?.["data-ae-start-appraisal"] !== undefined)[0].props?.disabled, true);
});

test("one appraisal per property: an existing one is opened instead; without permission or without a contact, nothing is offered; a failure is announced", () => {
  const existing = propertyView({ appraisal: appraisal({ existingHref: "/grow/appraisals/9/build" }) });
  assert.match(text(existing), /This property already has an appraisal\./);
  assert.deepEqual(hrefs(existing).filter((h) => h.includes("appraisals")), ["/grow/appraisals/9/build"]);
  assert.equal(all(existing, (e) => e.props?.["data-ae-start-appraisal"] !== undefined).length, 0);
  assert.equal(all(propertyView({ appraisal: appraisal({ canStart: false }) }), (e) => e.props?.["data-ae-start-appraisal"] !== undefined).length, 0);
  assert.equal(all(propertyView({ contacts: [], appraisal: appraisal({ candidates: [] }) }), (e) => e.props?.["data-ae-start-appraisal"] !== undefined).length, 0);
  assert.deepEqual(all(propertyView({ appraisal: appraisal({ error: "Link a contact to this property first. An appraisal is always prepared for a contact." }) }), (e) => e.props?.role === "alert").map((e) => text(e).slice(0, 20)), ["Link a contact to th"]);
});

test("linking a contact opens the picker with the roles; Add new contact is available inside it", () => {
  const tree = propertyView({ panel: { kind: "link" }, picker: picker({ title: "Link a contact", searchLabel: "Search contacts", create: create() }) });
  const form = all(tree, (e) => e.type === "form" && e.props?.["aria-label"] === "Link a contact")[0];
  assert.match(text(all(form, (e) => e.type === "select")[0]), /Seller \/ owner/);
  assert.equal(all(form, (e) => e.props?.["data-ae-new-contact"] !== undefined).length, 1);
});

test("loading, an error with Try again, a result line, and the word Performance never appears", () => {
  assert.match(text(propertyView({ loading: true, contacts: [] })), /Loading contacts…/);
  let retried = 0;
  const err = propertyView({ contacts: [], error: { text: "Couldn't load the contacts.", onRetry: () => { retried++; } } });
  assert.equal(all(err, (e) => e.props?.role === "alert").length, 1);
  call(buttons(err, "Try again")[0].props?.onClick);
  assert.equal(retried, 1);
  assert.equal(all(propertyView({ notice: "Contact unlinked." }), (e) => e.props?.role === "status" && text(e) === "Contact unlinked.").length, 1);
  assert.doesNotMatch(text(propertyView()) + text(props(contactView(LINKING_OFF))), /performance/i);
  assert.equal(links(propertyView()).every((l) => l.type === Link), true);
});

// ── Tap-to-call beside linked contacts, primary contact, and the preserved existing panel ───────────

const callOption = (label: string, display: string, href: string): CallOption => ({ label, display, href, text: `Call ${label.toLowerCase()} ${display}`, aria: `Call x, ${label.toLowerCase()} ${display}` });
const dialLinks = (tree: unknown) => all(tree, (e) => e.type === "a" && String(e.props?.href).startsWith("tel:"));

test("a call button sits beside each contact that has a usable number and no restriction: a real tel: link, named for the number and the person", () => {
  const tree = propertyView({ callState: { 31: { options: [callOption("Mobile", "0491 570 156", "tel:0491570156")], restricted: false } } });
  const dial = dialLinks(tree);
  assert.equal(dial.length, 1, "only the contact that has a button");
  assert.equal(dial[0].props?.href, "tel:0491570156");
  assert.equal(text(dial[0]), "Call");
  assert.equal(dial[0].props?.className, "mob-c-callbtn");
  assert.match(String(dial[0].props?.["aria-label"]), /mobile 0491 570 156/);
  assert.equal(dial[0].props?.["data-ae-call-contact"], 12);
  assert.match(text(tree), /0491 570 156/, "the number being called is visible on the row");
});

test("tapping a call button tells the container which contact and number, and never prevents the dialler", () => {
  const taps: Array<[number, string]> = [];
  const tree = propertyView({ callState: { 31: { options: [callOption("Mobile", "0491 570 156", "tel:0491570156")], restricted: false } }, onCall: (c, o) => { taps.push([c.partyId, o.href]); } });
  const result = (dialLinks(tree)[0].props?.onClick as () => unknown)();
  assert.deepEqual(taps, [[12, "tel:0491570156"]]);
  assert.equal(result, undefined);
});

test("no call button without a usable number, while the contact's answer is not in, or when a restriction applies; a restriction says so", () => {
  assert.equal(dialLinks(propertyView()).length, 0, "answer not in yet: fails closed");
  const restricted = propertyView({ callState: { 31: { options: [], restricted: true } } });
  assert.equal(dialLinks(restricted).length, 0);
  assert.match(text(restricted), /Do not call/);
  assert.equal((text(propertyView()).match(/Do not call/g) ?? []).length, 0);
});

test("several numbers: one button each, each naming its number", () => {
  const tree = propertyView({ callState: { 31: { options: [callOption("Mobile", "0491 570 156", "tel:0491570156"), callOption("Work", "07 5555 1234", "tel:0755551234")], restricted: false } } });
  assert.deepEqual(dialLinks(tree).map((a) => text(a)), ["Call mobile", "Call work"]);
  assert.deepEqual(dialLinks(tree).map((a) => a.props?.href), ["tel:0491570156", "tel:0755551234"]);
});

test("back from a call on the property page: Log call opens Contact 360's call form; nothing is saved here", () => {
  const offer = { partyId: 12, name: "Maya Okafor", label: "Mobile", display: "0491 570 156", startedAt: 1, hiddenAt: 2 };
  let dismissed = 0;
  const tree = propertyView({ callOffer: offer, onDismissOffer: () => { dismissed++; } });
  const box = all(tree, (e) => e.props?.["data-ae-call-return"] !== undefined)[0];
  assert.match(text(box), /Back from calling Maya Okafor\?/);
  assert.ok(hrefs(box).includes("/grow/contacts/12?log=call"));
  (all(box, (e) => e.type === "button" && text(e) === "Not now")[0].props?.onClick as () => void)();
  assert.equal(dismissed, 1);
  assert.equal(all(propertyView(), (e) => e.props?.["data-ae-call-return"] !== undefined).length, 0);
});

test("the primary contact is marked, and Make primary is offered for the others: disabled as shipped, enabled with the backend", () => {
  const tree = propertyView({ capabilities: linkingCapabilities(MANAGER) });
  assert.equal(all(tree, (e) => e.props?.className === "mob-c-primary-chip").length, 1);
  assert.match(text(all(tree, (e) => e.props?.className === "mob-c-primary-chip")[0]), /Primary/);
  const make = buttons(tree, "Make primary");
  assert.equal(make.length, 1, "not offered on the contact that is already primary");
  assert.equal(make[0].props?.disabled, true);
  const picked: number[] = [];
  const on = propertyView({ onMakePrimary: (id) => picked.push(id) });
  assert.equal(buttons(on, "Make primary")[0].props?.disabled, false);
  call(buttons(on, "Make primary")[0].props?.onClick);
  assert.deepEqual(picked, [32]);
});

test("while the link controls are off, the existing panel stays reachable in a disclosure; once they are on, it is gone", () => {
  const legacy = "EXISTING PANEL";
  const off = propertyView({ capabilities: linkingCapabilities(MANAGER), legacyActions: legacy });
  const box = all(off, (e) => e.props?.["data-ae-legacy-contact-actions"] !== undefined)[0];
  assert.ok(box, "the disclosure is present");
  assert.equal(box.type, "details");
  assert.match(text(box), /Link or add a contact/);
  assert.match(text(box), /EXISTING PANEL/);
  assert.equal(buttons(off, "Link a contact").length, 0, "no disabled duplicate beside it");
  const on = propertyView({ legacyActions: legacy });
  assert.equal(all(on, (e) => e.props?.["data-ae-legacy-contact-actions"] !== undefined).length, 0);
  assert.equal(buttons(on, "Link a contact").length, 1);
  assert.equal(all(propertyView({ capabilities: linkingCapabilities(MANAGER) }), (e) => e.props?.["data-ae-legacy-contact-actions"] !== undefined).length, 0, "nothing extra when there is no existing panel to keep");
  const manage = all(propertyView(), (e) => e.type === "details" && String(e.props?.className) === "mob-c-manage");
  assert.equal(manage.length, 2, "each contact's role, primary and unlink controls sit in one 'Manage' disclosure");
  assert.match(text(manage[0]), /Manage/);
  assert.equal(buttons(manage[0], "Unlink").length, 1);
  const open = all(propertyView({ panel: { kind: "unlink", linkId: 32 } }), (e) => e.type === "details" && String(e.props?.className) === "mob-c-manage");
  assert.deepEqual(open.map((d) => d.props?.open), [false, true], "the one being acted on stays open");
});
