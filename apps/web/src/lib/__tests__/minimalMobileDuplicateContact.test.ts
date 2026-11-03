import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MobileLinkPicker, type MobileLinkPickerProps, type PickerCreateProps } from "../../minimal/mobile/MobileLinkPicker";
import { DUPLICATE_HIDDEN_TEXT, DUPLICATE_VISIBLE_TEXT, duplicateContactWarning, linkingCapabilities, roleChoices } from "../../minimal/mobile/mobileLinking";
import { GROW_PROPERTIES_LINK, GROW_RELATIONSHIPS_MANAGE, type LinkingFlags } from "../../minimal/mobile/mobileLinkingConfig";
import { all, hrefs, text } from "./mobileTreeHelpers";

// t256u: the mobile "Add new contact" duplicate warning offers exactly "Open existing contact" (only when the server
// returned the matched contactId, i.e. the caller has contact-read) and "Create anyway". Never "Link existing".

const noop = () => {};
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const ON: LinkingFlags = { contactLinkProperty: true, contactEditRole: true, contactUnlink: true, contactEditPrimary: true, contactCanonicalRead: false, propertyLinkContact: true, propertyEditRole: true, propertyEditPrimary: true, propertyUnlink: true };
const DUP = (contactId?: number) => ({ status: 409, code: "POTENTIAL_DUPLICATE_CONTACT", ...(contactId === undefined ? {} : { contactId }) });

function create(o: Partial<PickerCreateProps> = {}): PickerCreateProps {
  return { open: true, name: "Dup Licate", email: "d@example.com", phone: "", creating: false, error: null, onOpen: noop, onField: noop, onSubmit: noop, onCancel: noop, ...o };
}
function picker(c: PickerCreateProps): MobileLinkPickerProps {
  return { title: "Link a contact", searchLabel: "Search contacts", searchPlaceholder: "Name", query: "", rows: [], message: null, loading: false, selectedId: null, choiceLabel: "Their relationship", choices: roleChoices(), choice: "", submitLabel: "Link contact", submitting: false, error: null, create: c, onQuery: noop, onSelect: noop, onChoice: noop, onSubmit: noop, onCancel: noop };
}
const warning = (tree: unknown) => all(tree, (e) => e.props?.["data-ae-duplicate-warning"] !== undefined)[0];
const actionLabels = (w: unknown) => all(w, (e) => e.type === "button" || e.props?.href !== undefined).map((e) => text(e).trim());

test("model: visible duplicate exposes the id and the contact link; invisible exposes neither; non-duplicates are not warnings", () => {
  assert.deepEqual(duplicateContactWarning(DUP(41)), { text: DUPLICATE_VISIBLE_TEXT, existingContactId: 41, existingHref: "/grow/contacts/41" });
  assert.deepEqual(duplicateContactWarning(DUP()), { text: DUPLICATE_HIDDEN_TEXT, existingContactId: null, existingHref: null });
  assert.deepEqual(duplicateContactWarning({ status: 409, code: "POTENTIAL_DUPLICATE_CONTACT", contactId: -3 }), { text: DUPLICATE_HIDDEN_TEXT, existingContactId: null, existingHref: null });
  assert.equal(duplicateContactWarning({ status: 409, code: "LINK_ALREADY_EXISTS" }), null);
  assert.equal(duplicateContactWarning({ status: 400 }), null);
  assert.equal(duplicateContactWarning(null), null);
  assert.doesNotMatch(DUPLICATE_HIDDEN_TEXT + DUPLICATE_VISIBLE_TEXT, /link/i);
});

for (const [who, ents] of [["with relationship-manage", [GROW_RELATIONSHIPS_MANAGE, GROW_PROPERTIES_LINK]], ["without relationship-manage", [GROW_PROPERTIES_LINK]]] as const) {
  test(`view (${who}): visible duplicate shows the id, Open existing contact and Create anyway, never Link existing`, () => {
    void linkingCapabilities([...ents], ON); // the duplicate panel does not depend on relationship-manage
    const w = warning(MobileLinkPicker(picker(create({ duplicate: duplicateContactWarning(DUP(41)), onCreateAnyway: noop }))));
    assert.ok(w);
    assert.match(text(w), /Contact #41/);
    assert.deepEqual(actionLabels(w), ["Open existing contact", "Create anyway"]);
    assert.deepEqual(hrefs(w), ["/grow/contacts/41"]);
    assert.doesNotMatch(text(w), /link existing/i);
  });
  test(`view (${who}): invisible duplicate shows no identity and no navigation, only Create anyway`, () => {
    const w = warning(MobileLinkPicker(picker(create({ duplicate: duplicateContactWarning(DUP()), onCreateAnyway: noop }))));
    assert.ok(w);
    assert.deepEqual(actionLabels(w), ["Create anyway"]);
    assert.deepEqual(hrefs(w), []);
    assert.doesNotMatch(text(w), /#\d|link existing/i);
  });
}

test("view: Create anyway calls the handler and is disabled while creating; no warning without a duplicate", () => {
  let n = 0;
  const w = warning(MobileLinkPicker(picker(create({ duplicate: duplicateContactWarning(DUP()), onCreateAnyway: () => n++ }))));
  const btn = all(w, (e) => e.type === "button")[0];
  (btn.props?.onClick as () => void)();
  assert.equal(n, 1);
  const busy = warning(MobileLinkPicker(picker(create({ creating: true, duplicate: duplicateContactWarning(DUP(5)), onCreateAnyway: noop }))));
  assert.equal(all(busy, (e) => e.type === "button")[0].props?.disabled, true);
  assert.equal(warning(MobileLinkPicker(picker(create()))), undefined);
});

test("container: Create anyway resubmits with confirmDuplicate; the old 'link the existing contact' advice is gone", () => {
  const src = read("../../minimal/mobile/MobilePropertyContacts.tsx");
  assert.match(src, /duplicateContactWarning\(err\)/);
  assert.match(src, /confirmDuplicate: true/);
  assert.doesNotMatch(src, /link the existing contact instead/);
  assert.doesNotMatch(read("../../minimal/mobile/MobileLinkPicker.tsx"), /Link existing/);
});
