import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MobileLinkPicker, type MobileLinkPickerProps, type PickerCreateProps } from "../../minimal/mobile/MobileLinkPicker";
import { DuplicatePanelView } from "../../minimal/properties/MinimalPropertyContacts";
import { duplicatePanel } from "../../minimal/properties/minimalPropertyContactsModel";
import { all, hrefs, text } from "./mobileTreeHelpers";

// The mobile "Add new contact" duplicate warning draws the decision of the SHARED duplicatePanel() (the function the preserved desktop panel
// uses). Agreed contract: Open existing contact (only with the revealed id, i.e. contact-read); Use <name> (id AND relationship-management);
// Create anyway (always); never Link existing; no identifying information without the id.

const noop = () => {};
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const DUP = (contactId?: number) => ({ status: 409, code: "POTENTIAL_DUPLICATE_CONTACT", ...(contactId === undefined ? {} : { contactId }) });
const NAME = "Maya Okafor";

function create(o: Partial<PickerCreateProps> = {}): PickerCreateProps {
  return { open: true, name: "Dup Licate", email: "d@example.com", phone: "", creating: false, error: null, onOpen: noop, onField: noop, onSubmit: noop, onCancel: noop, ...o };
}
function picker(c: PickerCreateProps): MobileLinkPickerProps {
  return { title: "Link a contact", searchLabel: "Search contacts", searchPlaceholder: "Name", query: "", rows: [], message: null, loading: false, selectedId: null, choiceLabel: "Their relationship", choices: [], choice: "", submitLabel: "Link contact", submitting: false, error: null, selectedLabel: null, onQuery: noop, onSelect: noop, onChoice: noop, onSubmit: noop, create: c } as unknown as MobileLinkPickerProps;
}
const warning = (tree: unknown) => all(tree, (e) => e.props?.["data-ae-duplicate-warning"] !== undefined)[0];
const labels = (w: unknown) => all(w, (e) => e.type === "button" || e.props?.href !== undefined).map((e) => text(e).trim());
/** The mobile picker, given exactly what the shared function decided. */
function mobile(error: ReturnType<typeof DUP>, canManage: boolean, extra: Partial<PickerCreateProps> = {}) {
  const panel = duplicatePanel(error, canManage);
  assert.ok(panel);
  return { panel, tree: MobileLinkPicker(picker(create({ duplicate: panel, duplicateName: NAME, onUseExisting: panel.canUseExisting ? noop : null, onCreateAnyway: noop, ...extra }))) };
}

const CASES = [
  { who: "contact-read and relationship-management", id: 41, canManage: true, expected: ["Open existing contact", `Use ${NAME}`, "Create anyway"] },
  { who: "contact-read, no relationship-management", id: 41, canManage: false, expected: ["Open existing contact", "Create anyway"] },
  { who: "no contact-read (no id), relationship-management", id: undefined, canManage: true, expected: ["Create anyway"] },
  { who: "no contact-read (no id), no relationship-management", id: undefined, canManage: false, expected: ["Create anyway"] },
] as const;

for (const c of CASES) {
  test(`mobile picker (${c.who}): exactly ${c.expected.join(", ")}`, () => {
    const { tree, panel } = mobile(DUP(c.id), c.canManage);
    const w = warning(tree);
    assert.ok(w);
    assert.deepEqual(labels(w), [...c.expected]);
    assert.equal(text(w).includes(panel.text), true, "the text is the shared panel's text");
    assert.doesNotMatch(text(w), /link existing/i, "never Link existing");
    if (c.id === undefined) {
      assert.deepEqual(hrefs(w), [], "no navigation without the id");
      assert.doesNotMatch(text(w), new RegExp(`${NAME}|#\\d|/grow/contacts`), "no name, no id, no link");
    } else assert.deepEqual(hrefs(w), [`/grow/contacts/${c.id}`]);
  });

  test(`mobile and desktop present the SAME actions and text for the same decision (${c.who})`, () => {
    const { tree, panel } = mobile(DUP(c.id), c.canManage);
    const desktop = DuplicatePanelView({ panel, existingName: NAME, creating: false, onUseExisting: noop, onCreateAnyway: noop });
    assert.deepEqual(labels(warning(tree)), labels(desktop), "same actions, same order");
    assert.deepEqual(hrefs(warning(tree)), hrefs(desktop), "same link");
    assert.equal(text(desktop).includes(panel.text) && text(warning(tree)).includes(panel.text), true, "same text");
  });
}

test("the handlers: Use <name> and Create anyway call back; Create anyway is disabled while creating; no warning without a duplicate; the ordinary Create is off while a duplicate stands", () => {
  const calls: string[] = [];
  const panel = duplicatePanel(DUP(41), true)!;
  const tree = MobileLinkPicker(picker(create({ duplicate: panel, duplicateName: NAME, onUseExisting: () => calls.push("use"), onCreateAnyway: () => calls.push("anyway") })));
  for (const label of [`Use ${NAME}`, "Create anyway"]) (all(warning(tree), (e) => e.type === "button" && text(e).trim() === label)[0].props?.onClick as () => void)();
  assert.deepEqual(calls, ["use", "anyway"]);
  const busy = MobileLinkPicker(picker(create({ creating: true, duplicate: panel, onCreateAnyway: noop })));
  assert.equal(all(warning(busy), (e) => e.props?.["data-ae-create-anyway"] !== undefined)[0].props?.disabled, true);
  assert.equal(warning(MobileLinkPicker(picker(create()))), undefined, "no warning without a duplicate");
  assert.equal(all(tree, (e) => e.type === "button" && text(e) === "Create contact")[0].props?.disabled, true);
  // defence in depth: a reuse callback passed wrongly is never drawn without the revealed id
  const hidden = duplicatePanel(DUP(), true)!;
  assert.deepEqual(labels(warning(MobileLinkPicker(picker(create({ duplicate: hidden, duplicateName: NAME, onUseExisting: noop, onCreateAnyway: noop }))))), ["Create anyway"]);
});

test("the container asks the shared function; it has no decision of its own; the name is fetched only when Use <name> can appear", () => {
  const src = read("../../minimal/mobile/MobilePropertyContacts.tsx");
  assert.match(src, /const dup = err instanceof ApiError \? duplicatePanel\(err, canManageRel\) : null;/);
  assert.match(src, /enabled: duplicate\?\.canUseExisting === true && existingContactId !== null,/);
  assert.match(src, /duplicate\?\.canUseExisting && existingContactId !== null/, "Use <name> only when the shared decision allows it");
  assert.match(src, /confirmDuplicate: true/, "Create anyway resubmits with confirmation");
  for (const f of ["MobilePropertyContacts.tsx", "MobileLinkPicker.tsx", "mobileLinking.ts"]) {
    const code = read(`../../minimal/mobile/${f}`).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // code only: the comments explain the rule
    assert.equal(/duplicateContactWarning|DuplicateContactWarning|DUPLICATE_VISIBLE_TEXT|DUPLICATE_HIDDEN_TEXT/.test(code), false, `${f}: no separate duplicate decision or text`);
    assert.doesNotMatch(code, /Link existing/i, f);
  }
});
