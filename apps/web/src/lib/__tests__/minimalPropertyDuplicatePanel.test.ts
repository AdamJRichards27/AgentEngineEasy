import { test } from "node:test";
import assert from "node:assert/strict";
import { DuplicatePanelView } from "../../minimal/properties/MinimalPropertyContacts";
import { DUPLICATE_HIDDEN_TEXT, duplicatePanel, propertyLinkControlsEnabled } from "../../minimal/properties/minimalPropertyContactsModel";
import { MobilePropertyContactsView, type MobilePropertyContactsViewProps, type PropertyAppraisalProps } from "../../minimal/mobile/MobilePropertyContactsView";
import { linkingCapabilities, roleChoices } from "../../minimal/mobile/mobileLinking";
import { GROW_PROPERTIES_LINK, GROW_RELATIONSHIPS_MANAGE, MOBILE_LINKING } from "../../minimal/mobile/mobileLinkingConfig";
import { mobileLinkedContacts } from "../../minimal/mobile/mobilePropertyContactRows";
import { canManageRelationships } from "../relationshipPermission";
import { all, hrefs, text } from "./mobileTreeHelpers";

// t261u: the PRESERVED panel's duplicate contract (DUPLICATE-PANEL-CONTRACT.md), by behaviour, with all flags OFF.
// Open existing contact only with contactId (contact-read); Create anyway always; Use <name> only for relationship managers.

const noop = () => {};
const DUP = (contactId?: number) => ({ status: 409, code: "POTENTIAL_DUPLICATE_CONTACT", ...(contactId === undefined ? {} : { contactId }) });
const view = (panel: ReturnType<typeof duplicatePanel>, existingName = "Maya Okafor") => DuplicatePanelView({ panel: panel!, existingName, creating: false, onUseExisting: noop, onCreateAnyway: noop });
const actions = (tree: unknown) => all(tree, (e) => e.type === "button" || e.props?.href !== undefined).map((e) => text(e).trim());

test("flags: all nine mobile flags and the desktop link-controls flag are OFF on this base", () => {
  assert.deepEqual(Object.values(MOBILE_LINKING).filter(Boolean), []);
  assert.equal(propertyLinkControlsEnabled({}), false);
});

const MATRIX = [
  { who: "contact-read + relationship manager", id: 41, manager: true, expect: ["Open existing contact", "Use Maya Okafor", "Create anyway"] },
  { who: "contact-read, not a relationship manager", id: 41, manager: false, expect: ["Open existing contact", "Create anyway"] },
  { who: "no contact-read, relationship manager", id: undefined, manager: true, expect: ["Create anyway"] },
  { who: "no contact-read, not a relationship manager", id: undefined, manager: false, expect: ["Create anyway"] },
] as const;
for (const m of MATRIX) {
  test(`preserved panel duplicate (${m.who}): exactly ${m.expect.join(" / ")}`, () => {
    const tree = view(duplicatePanel(DUP(m.id), m.manager));
    assert.deepEqual(actions(tree), m.expect);
    assert.doesNotMatch(text(tree), /link existing|link the existing contact/i);
    if (m.id === undefined) {
      assert.deepEqual(hrefs(tree), []);
      assert.equal(text(tree).includes(DUPLICATE_HIDDEN_TEXT), true);
      assert.doesNotMatch(text(tree), /Maya|#\d/);
    } else assert.deepEqual(hrefs(tree), ["/grow/contacts/41"]);
  });
}

test("Create anyway and Use <name> call their handlers; Create anyway is disabled while creating", () => {
  let created = 0, used = 0;
  const p = duplicatePanel(DUP(41), true)!;
  const tree = DuplicatePanelView({ panel: p, existingName: "Maya Okafor", creating: false, onUseExisting: () => used++, onCreateAnyway: () => created++ });
  for (const b of all(tree, (e) => e.type === "button")) (b.props?.onClick as () => void)();
  assert.deepEqual([used, created], [1, 1]);
  const busy = DuplicatePanelView({ panel: p, existingName: "x", creating: true, onUseExisting: noop, onCreateAnyway: noop });
  assert.equal(all(busy, (e) => e.props?.["data-ae-create-anyway"] !== undefined)[0].props?.disabled, true);
});

test("not a duplicate: no panel", () => {
  assert.equal(duplicatePanel({ status: 409, code: "LINK_ALREADY_EXISTS" }, true), null);
  assert.equal(duplicatePanel({ status: 400 }, true), null);
});

test("flags OFF on the phone: the preserved panel (legacyActions) is what a relationship manager sees, and the shared helper decides", () => {
  const linked = mobileLinkedContacts([{ linkId: 31, role: "Seller", isPrimary: true, party: { id: 12, firstName: "Maya", lastName: "Okafor", email: "m@example.com", mobile: "0491 570 156" } }]);
  const appraisal: PropertyAppraisalProps = { existingHref: null, candidates: [], canStart: false, starting: false, error: null, onStart: noop };
  const marker = { type: "div", props: { "data-ae-preserved-panel": true } };
  const props = (canManage: boolean): MobilePropertyContactsViewProps => ({
    propertyLabel: "7 Jacaranda Street", contacts: linked, loading: false, error: null, capabilities: linkingCapabilities([GROW_RELATIONSHIPS_MANAGE, GROW_PROPERTIES_LINK], MOBILE_LINKING), panel: null, submitting: false,
    opError: null, notice: null, roleValue: "", roleOptions: roleChoices(), appraisal, picker: null, callState: {}, onCall: noop, callOffer: null, onDismissOffer: noop, onMakePrimary: noop,
    onOpen: noop, onClose: noop, onRoleChange: noop, onSubmitRole: noop, onConfirmUnlink: noop, legacyActions: marker as never, canManageRelationships: canManage,
  });
  const has = (tree: unknown) => all(tree, (e) => e.props?.["data-ae-preserved-panel"] === true).length;
  assert.equal(has(MobilePropertyContactsView(props(true))), 1, "manager reaches the preserved panel with flags off");
  assert.equal(has(MobilePropertyContactsView(props(false))), 0);
  // the shared helper: key, or run.access with Agent/Administrator; never run.access alone (Pit Crew)
  const ents = (k: string[]) => (key: string) => k.includes(key);
  assert.equal(canManageRelationships(ents([GROW_RELATIONSHIPS_MANAGE]), "Agent"), true);
  assert.equal(canManageRelationships(ents(["run.access"]), "Agent"), true);
  assert.equal(canManageRelationships(ents(["run.access"]), "Pit Crew"), false);
  assert.equal(canManageRelationships(ents(["grow.contacts.read"]), "Agent"), false);
});
