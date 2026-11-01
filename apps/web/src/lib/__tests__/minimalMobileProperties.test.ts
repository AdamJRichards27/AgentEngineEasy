import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MobilePropertiesView } from "../../minimal/mobile/MobilePropertiesView";
import { MobilePropertyDetailView } from "../../minimal/mobile/MobilePropertyDetailView";
import type { MinimalPropertiesViewProps } from "../../minimal/properties/MinimalPropertiesView";
import type { MinimalPropertyDetailModel } from "../../minimal/properties/minimalPropertyDetailModel";
import { all, hrefs, text } from "./mobileTreeHelpers";

// AE Mobile (CC Task #64, M5): the Properties list and detail on a phone. Same props and so the same actions as the existing screens.

const noop = () => {};
const call = (fn: unknown, ...a: unknown[]) => (fn as (...x: unknown[]) => void)(...a);
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const CARD = { id: 77, address: "7 Jacaranda Street", location: "Paddington QLD 4064", stage: "Appraisal", listingStatus: "Not Listed", href: "/grow/properties/77", appraisal: { id: 9, statusLabel: "Draft", href: "/grow/appraisals/9/build", closed: false }, openOpportunityCount: 2 };
const CARD2 = { id: 78, address: "22 Banksia Avenue", location: "Paddington QLD 4064", stage: "Prospect", listingStatus: "Not Listed", href: "/grow/properties/78", appraisal: null, openOpportunityCount: 0 };

function list(o: Partial<MinimalPropertiesViewProps> = {}): MinimalPropertiesViewProps {
  return { cards: [CARD, CARD2], search: "", loading: false, error: null, notice: null, chooser: null, pendingPropertyId: null, canCreateAppraisal: true, runAccess: false, addForm: null, onOpenAddProperty: noop, onSearch: noop, onCreateAppraisal: noop, onChooseContact: noop, onCancelChooser: noop, onRetry: noop, ...o };
}
const buttons = (t: unknown, label: string) => all(t, (e) => e.type === "button" && text(e) === label);

test("the list: one heading, a search, and one tap target per property carrying only what an agent scans for", () => {
  const tree = MobilePropertiesView(list());
  assert.deepEqual(all(tree, (e) => e.type === "h1").map((e) => text(e)), ["Properties"]);
  assert.equal(all(tree, (e) => e.type === "input" && e.props?.type === "search")[0].props?.["aria-label"], "Search properties");
  assert.deepEqual(hrefs(tree).filter((h) => h.startsWith("/grow/properties")), ["/grow/properties/77", "/grow/properties/78"]);
  const first = all(tree, (e) => e.props?.["data-property-id"] === 77)[0];
  assert.match(text(first), /7 Jacaranda Street/);
  assert.match(text(first), /Paddington QLD 4064/);
  assert.match(text(first), /Appraisal · Draft/);
  assert.match(text(first), /2 open opportunities/);
  assert.match(text(all(tree, (e) => e.props?.["data-property-id"] === 78)[0]), /No appraisal yet/);
  assert.doesNotMatch(text(tree), /Every property has a place|Stand-alone records|property records? in your brokerage/i, "no repeated explanation on a phone");
});

test("the existing actions are all here: Add property (Run flow link, or the Grow-only form), Create / Open appraisal with the contact chooser", () => {
  const grow = MobilePropertiesView(list());
  let opened = 0;
  call(buttons(MobilePropertiesView(list({ onOpenAddProperty: () => { opened++; } })), "Add property")[0].props?.onClick);
  assert.equal(opened, 1);
  assert.deepEqual(hrefs(MobilePropertiesView(list({ runAccess: true }))).filter((h) => h === "/properties/start"), ["/properties/start"]);
  assert.equal(buttons(MobilePropertiesView(list({ runAccess: true })), "Add property").length, 0);
  assert.deepEqual(all(grow, (e) => e.props?.["data-appraisal-property"] !== undefined).map((b) => text(b)), ["Open appraisal", "Create appraisal"]);
  const started: number[] = [];
  call(all(MobilePropertiesView(list({ onCreateAppraisal: (id) => started.push(id) })), (e) => e.props?.["data-appraisal-property"] === 78)[0].props?.onClick);
  assert.deepEqual(started, [78]);
  assert.equal(all(MobilePropertiesView(list({ canCreateAppraisal: false })), (e) => e.props?.["data-appraisal-property"] !== undefined).length, 0, "no appraisal button without the permission");
  const chosen: Array<[number, number]> = [];
  const chooser = MobilePropertiesView(list({ chooser: { propertyId: 77, choices: [{ partyId: 12, label: "Maya Okafor" }, { partyId: 13, label: "Sam Lee" }] }, onChooseContact: (p, c) => chosen.push([p, c]) }));
  const fieldset = all(chooser, (e) => e.type === "fieldset")[0];
  assert.deepEqual(all(fieldset, (e) => e.type === "button").map((b) => text(b)), ["Maya Okafor", "Sam Lee", "Cancel"]);
  call(all(fieldset, (e) => e.type === "button")[1].props?.onClick);
  assert.deepEqual(chosen, [[77, 13]]);
});

test("the Grow-only Add property form: labelled fields, address required, saving and errors announced", () => {
  const submitted: unknown[] = [];
  const form = { open: true, saving: false, error: "Couldn't save the property.", onSubmit: (i: unknown) => submitted.push(i), onCancel: noop };
  const tree = MobilePropertiesView(list({ addForm: form }));
  const f = all(tree, (e) => e.type === "form")[0];
  assert.equal(f.props?.["aria-label"], "Add property");
  assert.deepEqual(all(f, (e) => e.type === "input").map((e) => e.props?.name), ["formattedAddress", "suburb", "state", "postcode"]);
  assert.equal(all(f, (e) => e.type === "input")[0].props?.required, true);
  assert.equal(all(f, (e) => e.props?.role === "alert").length, 1);
  assert.equal(all(MobilePropertiesView(list({ addForm: { ...form, open: false } })), (e) => e.type === "form").length, 0);
  assert.equal(all(MobilePropertiesView(list({ addForm: form, runAccess: true })), (e) => e.type === "form").length, 0, "Run users use the Run flow");
  assert.match(text(MobilePropertiesView(list({ addForm: { ...form, saving: true, error: null } }))), /Saving…/);
});

test("search, loading, error with Try again, empty states, and a notice with its link", () => {
  const typed: string[] = [];
  call(all(MobilePropertiesView(list({ onSearch: (t) => typed.push(t) })), (e) => e.type === "input" && e.props?.type === "search")[0].props?.onChange, { target: { value: "jac" } });
  assert.deepEqual(typed, ["jac"]);
  assert.match(text(MobilePropertiesView(list({ loading: true, cards: [] }))), /Loading properties…/);
  let retried = 0;
  const err = MobilePropertiesView(list({ error: "Couldn't load properties.", cards: [], onRetry: () => { retried++; } }));
  assert.equal(all(err, (e) => e.props?.role === "alert").length, 1);
  call(buttons(err, "Try again")[0].props?.onClick);
  assert.equal(retried, 1);
  assert.match(text(MobilePropertiesView(list({ cards: [] }))), /No properties yet\. Add one to get started\./);
  assert.match(text(MobilePropertiesView(list({ cards: [], search: "zzz" }))), /No properties match\./);
  const note = MobilePropertiesView(list({ notice: { propertyId: 77, text: "Link a contact to this property first.", href: "/grow/properties/77", hrefLabel: "Open the property" } }));
  assert.match(text(all(note, (e) => e.props?.role === "status")[0]), /Link a contact to this property first\. Open the property/);
});

// ── detail ───────────────────────────────────────────────────────────────

const MODEL: MinimalPropertyDetailModel = {
  id: 77, address: "7 Jacaranda Street", location: "Paddington QLD 4064", stage: "Appraisal", listingStatus: "Not Listed", salesMethod: "Not recorded", priceDisplay: "Not recorded", runHref: "/properties/77",
  appraisals: [{ id: 9, href: "/grow/appraisals/9/build", statusLabel: "Draft", contact: "Maya Okafor", updated: "31 Oct 2026", closed: false }],
  opportunities: [{ id: 4, href: "/grow/opportunities/4", contact: "Maya Okafor", contactHref: "/grow/contacts/12", stage: "Appraisal", open: true }],
  opportunitiesTruncated: false, opportunitiesScope: "property",
} as MinimalPropertyDetailModel;
const ready = (over: Partial<MinimalPropertyDetailModel> = {}, extra: Record<string, unknown> = {}) => MobilePropertyDetailView({ state: { kind: "ready", model: { ...MODEL, ...over }, ...extra } as never });

test("the detail: the address first, who to call next, then the appraisal and the opportunities; the record is one tap away", () => {
  const tree = ready({}, { contacts: "CONTACTS SLOT" });
  assert.deepEqual(all(tree, (e) => e.type === "h1").map((e) => text(e)), ["7 Jacaranda Street"]);
  const t = text(tree);
  assert.ok(t.indexOf("7 Jacaranda Street") < t.indexOf("CONTACTS SLOT") && t.indexOf("CONTACTS SLOT") < t.indexOf("Appraisals") && t.indexOf("Appraisals") < t.indexOf("Opportunities"));
  const record = all(tree, (e) => e.type === "details")[0];
  assert.match(text(record), /Property record/);
  for (const label of ["Stage", "Listing status", "Sales method", "Price display"]) assert.match(text(record), new RegExp(label));
});

test("every existing detail action is kept: back to Properties, Open in Run, appraisal and opportunity links, the opportunity's contact", () => {
  const tree = ready();
  assert.deepEqual(hrefs(tree), ["/properties", "/properties/77", "/grow/appraisals/9/build", "/grow/opportunities/4", "/grow/contacts/12"]);
  assert.equal(hrefs(ready({ runHref: null })).includes("/properties/77"), false, "Open in Run only with Run access");
  assert.match(text(ready({ appraisals: [], opportunities: [] })), /No appraisal yet\./);
  assert.match(text(ready({ appraisals: [], opportunities: [] })), /No opportunity linked to this property\./);
  assert.match(text(ready({ opportunitiesTruncated: true })), /latest 100 opportunities/);
  assert.match(text(ready({ opportunitiesTruncated: true, opportunitiesScope: "all-properties" })), /from your latest 100/);
  assert.match(text(ready({}, { relatedLoading: true })), /Loading appraisals and opportunities…/);
  assert.equal(all(ready({}, { relatedError: "Couldn't load the related records." }), (e) => e.props?.role === "alert").length, 1);
});

test("loading and error states keep the way back; Try again only when given", () => {
  const loading = MobilePropertyDetailView({ state: { kind: "loading" } });
  assert.match(text(loading), /Loading property…/);
  assert.deepEqual(hrefs(loading), ["/properties"]);
  let retried = 0;
  const err = MobilePropertyDetailView({ state: { kind: "error", text: "That property couldn’t be found.", onRetry: () => { retried++; } } });
  call(all(err, (e) => e.type === "button" && text(e) === "Try again")[0].props?.onClick);
  assert.equal(retried, 1);
  assert.equal(all(MobilePropertyDetailView({ state: { kind: "error", text: "That property couldn’t be found." } }), (e) => e.type === "button").length, 0);
  assert.deepEqual(hrefs(err), ["/properties"]);
});

// ── source and CSS guards ────────────────────────────────────────────────

test("the views are presentational: no data access, no storage, no calling, no checkout, no relationship writes", () => {
  for (const f of ["MobilePropertiesView.tsx", "MobilePropertyDetailView.tsx", "mobilePropertiesStyles.ts"]) {
    const c = read(`../../minimal/mobile/${f}`).replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(c, /apiFetch|useQuery|useMutation|fetch\(|localStorage|sessionStorage|tel:|\/billing|\/parties|\/grow\/relationships|window\.confirm/, f);
    assert.doesNotMatch(c, /performance|nurture/i, f);
  }
});

test("the existing containers pick the phone view in one place each, keeping their own queries and actions", () => {
  const list = read("../../minimal/properties/MinimalProperties.tsx");
  assert.match(list, /const View = useIsPhone\(\) \? MobilePropertiesView : MinimalPropertiesView;/);
  assert.match(list, /return \(\s*<View\s/);
  const detail = read("../../minimal/properties/MinimalPropertyDetail.tsx");
  assert.match(detail, /const View = isPhone \? MobilePropertyDetailView : MinimalPropertyDetailView;/);
  assert.equal((detail.match(/<MinimalPropertyDetailView/g) ?? []).length, 0, "every return goes through View");
  // Create Contact, link a contact and the existing panel are preserved, and its Start appraisal is not duplicated
  assert.match(detail, /legacyActions=\{\s*<MinimalPropertyContacts[\s\S]*?canStartAppraisal=\{false\}[\s\S]*?existingAppraisalHref=\{null\}/);
  assert.match(detail, /canCreateContact=\{growAccess && hasEntitlement\("grow\.contacts\.manage"\)\}/);
});

test("css: scoped to .ae-minimal .mob-p, every control at least 44 px, no text below 13 px", () => {
  const css = read("../../minimal/mobile/mobileProperties.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  for (const r of rules) for (const sel of r.sel.split(",").map((x) => x.trim())) assert.match(sel, /^(\.ae-minimal \.mob-p|@media)/, sel);
  const px = (body: string, prop: string) => Number(new RegExp(`${prop}:\\s*(\\d+)px`).exec(body)?.[1] ?? 0);
  for (const sel of [".ae-minimal .mob-p-button", ".ae-minimal .mob-p-search", ".ae-minimal .mob-p-input", ".ae-minimal .mob-p-open", ".ae-minimal .mob-p-back", ".ae-minimal .mob-p-inline"]) {
    const rule = rules.find((r) => r.sel.split(",").map((x) => x.trim()).includes(sel));
    assert.ok(rule, sel);
    assert.ok(px(rule!.body, "min-height") >= 44, `${sel} is at least 44 px`);
  }
  for (const r of rules) { const m = /font-size:\s*(\d+)px/.exec(r.body); if (m) assert.ok(Number(m[1]) >= 13, r.sel); }
  assert.match(css, /\.mob-p-search \{[^}]*font-size: 16px/, "16 px stops the phone zooming into the field");
});
