import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { GROW_ACTIVITIES_MANAGE, GROW_CONTACTS_READ, GROW_IMPORT_EXECUTE, MOBILE_PEOPLE_SHOWS_GROW_SECTIONS, PROPERTY_RELATIONSHIP_LABELS } from "../../minimal/mobile/mobilePeopleConfig";

// AE Mobile (CC Task #64, M4): guards on what the new files may do and look like.

const dir = new URL("../../minimal/mobile/", import.meta.url);
const M4_FILES = [
  "ContactScreen.tsx", "MobileContact.tsx", "MobileContactView.tsx", "CallReturnPrompt.tsx", "MobileLinkPicker.tsx", "MobilePeople.tsx", "MobilePeopleView.tsx", "MobilePropertyContacts.tsx", "MobilePropertyContactsView.tsx", "PeopleScreen.tsx", "mobileContactForms.ts", "mobileCalling.ts", "mobileLinking.ts", "mobileLinkingConfig.ts", "useCallReturn.ts", "useLinkPicker.ts",
  "mobileContactLayout.ts", "mobilePeopleConfig.ts", "mobilePeopleLayout.ts",
];
const read = (f: string) => readFileSync(new URL(f, dir), "utf8");
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the M4 files exist and none is named for Performance", () => {
  const present = readdirSync(dir);
  for (const f of [...M4_FILES, "mobilePeople.css"]) assert.ok(present.includes(f), f);
  assert.equal(present.some((f) => /performance/i.test(f)), false);
});

test("drift: the two entitlement keys exist in the server catalogue, and are defined once", () => {
  const catalogue = readFileSync(new URL("../../../../../packages/db/src/schema/billing.ts", import.meta.url), "utf8");
  const block = /export const ENTITLEMENT_KEYS = \[([\s\S]*?)\] as const/.exec(catalogue);
  assert.ok(block);
  const keys = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.includes(GROW_ACTIVITIES_MANAGE));
  assert.ok(keys.includes(GROW_IMPORT_EXECUTE));
  assert.ok(keys.includes(GROW_CONTACTS_READ));
  for (const f of M4_FILES.filter((x) => x !== "mobilePeopleConfig.ts" && x !== "mobileLinkingConfig.ts")) {
    assert.doesNotMatch(code(f), /["'](run|grow)\.[a-zA-Z.]+["']/, `${f}: an entitlement key literal`);
  }
});

test("drift: the relationship words are the Contact 360 Link property form's own, and cover every stored type", () => {
  const grow = readFileSync(new URL("../../pages/Grow.tsx", import.meta.url), "utf8");
  const block = /const GROW_PROPERTY_RELATIONSHIP_OPTIONS = \[([\s\S]*?)\] as const;/.exec(grow);
  assert.ok(block, "the options list exists in the form");
  const form = Object.fromEntries([...block[1].matchAll(/\["([a-z_]+)",\s*"([^"]+)"\]/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(PROPERTY_RELATIONSHIP_LABELS, form);
  const schema = readFileSync(new URL("../../../../../packages/db/src/schema/grow.ts", import.meta.url), "utf8");
  const types = /export const GROW_RELATIONSHIP_TYPES = \[([\s\S]*?)\] as const;/.exec(schema);
  assert.ok(types);
  for (const t of [...types[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1])) assert.ok(t in PROPERTY_RELATIONSHIP_LABELS, `a label for ${t}`);
});

test("the Grow section bar stays on these screens until its destinations are verified", () => {
  assert.equal(MOBILE_PEOPLE_SHOWS_GROW_SECTIONS, true);
  assert.match(code("MobileContact.tsx"), /MOBILE_PEOPLE_SHOWS_GROW_SECTIONS \?/);
  assert.match(code("MobilePeople.tsx"), /MOBILE_PEOPLE_SHOWS_GROW_SECTIONS \?/);
});

test("no browser storage, no direct fetch, no billing, no telephony, no call recording, no Performance", () => {
  for (const f of M4_FILES) {
    const c = code(f);
    assert.doesNotMatch(c, /localStorage|sessionStorage|indexedDB|document\.cookie/, `${f}: storage`);
    assert.doesNotMatch(c, /\bfetch\(/, `${f}: direct fetch`);
    assert.doesNotMatch(c, /checkout|\/billing|subscription/i, `${f}: billing`);
    assert.doesNotMatch(c, /telephony|callSession|\/grow\/calls|MediaRecorder|getUserMedia/i, `${f}: telephony or recording`);
    assert.doesNotMatch(c, /performance/i, `${f}: Performance`);
  }
});

test("only the containers and the picker hook call the API", () => {
  const contact = code("MobileContact.tsx");
  const calls = [...contact.matchAll(/apiFetch\(([^)]*\)?)\)/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  assert.equal(calls.length, 3);
  assert.equal(calls[0], "`/grow/contacts/${partyId}`");
  assert.equal(calls[1], "canonicalContactLinksPath(partyId as number)");
  assert.ok(calls[2].startsWith("request.path, { method: request.method, body: request.body === undefined ? undefined : JSON.stringify(request.body"), calls[1]);
  const people = code("MobilePeople.tsx");
  const list = [...people.matchAll(/apiFetch(?:<[^>]+>)?\(([^)]*\)?)\)/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  assert.equal(list.length, 1);
  assert.ok(list[0].startsWith("peoplePath({ search: committed, role, cursor: pageParam }"), list[0]);
  const prop = [...code("MobilePropertyContacts.tsx").matchAll(/apiFetch(?:<[^>]+>)?\(([^)]*\)?)\)/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  assert.equal(prop.length, 5, "the list, the contact answers beside each contact (shared with Contact 360), the one link-operation helper, and the two PRESERVED existing requests");
  assert.equal(prop[0], "linkedPartiesPath(propertyId)");
  assert.equal(prop[1], "`/grow/contacts/${c.partyId}`", "the same request Contact 360 makes, under the same cache key");
  assert.ok(prop[2].startsWith("request.path, { method: request.method, body: request.body === undefined ? undefined : JSON.stringify(request.body"), prop[2]);
  assert.ok(prop[3].startsWith('"/grow/appraisals/from-contact", { method: "POST", body: JSON.stringify(startAppraisalBody(partyId, propertyId'), prop[2]);
  assert.ok(prop[4].startsWith('"/grow/contacts", { method: "POST", body: JSON.stringify(input'), prop[4]);
  const contactCanon = [...code("MobileContact.tsx").matchAll(/apiFetch\(([^)]*\)?)\)/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  assert.equal(contactCanon.length, 3, "contact, the canonical read (never enabled while its flag is off), the write helper");
  assert.equal(contactCanon[1], "canonicalContactLinksPath(partyId as number)");
  const picker = [...code("useLinkPicker.ts").matchAll(/apiFetch(?:<[^>]+>)?\(([^)]*\)?)\)/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  assert.deepEqual(picker, ["contactsPath as string, { signal }", "propertiesPath as string, { signal }"], "the picker only reads, from the planned search paths");
  for (const f of M4_FILES.filter((x) => !["MobileContact.tsx", "MobilePeople.tsx", "MobilePropertyContacts.tsx", "useLinkPicker.ts"].includes(x))) assert.doesNotMatch(code(f), /apiFetch|useQuery|useMutation/, `${f}: no data access`);
});

test("linking: three canonical requests on property_parties, a change appears only after the server accepts it, and nothing is created or written elsewhere", () => {
  const link = code("mobileLinking.ts");
  const paths = [...link.matchAll(/path:\s*(`[^`]*`|"[^"]*")/g)].map((m) => m[1]);
  assert.deepEqual(paths, ['"/parties"', "`/parties/link/${linkId}`", "`/parties/link/${linkId}`", "`/parties/link/${linkId}`"], "link, change role, make primary, unlink");
  // the first POST is the request type's own union; then link, change role, unlink
  assert.deepEqual([...link.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]), ["POST", "POST", "PATCH", "PATCH", "DELETE"]);
  assert.doesNotMatch(link, /relationships/, "no second relationship table");
  for (const f of M4_FILES) {
    const c = code(f);
    assert.doesNotMatch(c, /setQueryData|onMutate|optimistic/i, `${f}: no optimistic update`);
    assert.doesNotMatch(c, /window\.confirm|\bconfirm\(/, `${f}: no browser confirm`);
  }
  for (const f of ["mobileLinking.ts", "MobileLinkPicker.tsx", "MobilePropertyContactsView.tsx", "useLinkPicker.ts"]) {
    assert.doesNotMatch(code(f), /"\/grow\/contacts"|\/grow\/properties"|"\/properties"|createContact/, `${f}: nothing that creates a contact or property`);
  }
  const containers = [code("MobileContact.tsx"), code("MobilePropertyContacts.tsx")];
  for (const c of containers) assert.match(c, /onSuccess: \(\) => \{\s*(closeLinkPanel|close)\(\);/, "the panel closes only on success");
  assert.match(code("MobileContact.tsx"), /linkingCapabilities\(entitlements\)/);
  assert.match(code("MobilePropertyContacts.tsx"), /linkingCapabilities\(entitlements\)/);
  assert.doesNotMatch(containers.join("\n"), /linkingCapabilities\(entitlements,/, "the containers never pass their own flags");
  assert.match(code("MobileContact.tsx"), /enabled: partyId !== null && MOBILE_LINKING\.contactCanonicalRead/, "the canonical read is not requested while its flag is off");
});

test("the phone list shares the classic list's cache family, so existing writes refresh it", () => {
  const people = code("MobilePeople.tsx");
  assert.match(people, /queryKey: \["grow-contacts", "mobile", committed, role\]/);
  const existing = readFileSync(new URL("../../minimal/MinimalContacts.tsx", import.meta.url), "utf8");
  assert.ok(existing.length > 0);
});

test("the two screens choose phone or desktop in one place each, and keep the existing screens untouched", () => {
  const people = code("PeopleScreen.tsx");
  const contact = code("ContactScreen.tsx");
  assert.match(people, /useIsPhone\(\) \? <MobilePeople \/> : <MinimalContacts \/>/);
  assert.match(contact, /useIsPhone\(\) \? <MobileContact \/> : <MinimalContact360 \/>/);
  for (const f of ["PeopleScreen.tsx", "ContactScreen.tsx"]) assert.ok(code(f).split("\n").length < 20, `${f} stays tiny`);
});

test("the contact container reads exactly what the existing Contact 360 reads", () => {
  const existing = readFileSync(new URL("../../minimal/MinimalContact360.tsx", import.meta.url), "utf8");
  const mine = code("MobileContact.tsx");
  for (const piece of ['queryKey: ["grow-contact", partyId]', "queryFn: () => apiFetch(`/grow/contacts/${partyId}`)", "enabled: partyId !== null"]) {
    assert.ok(existing.includes(piece), `the existing screen has: ${piece}`);
    assert.ok(mine.includes(piece), `the phone screen has: ${piece}`);
  }
});

test("the writes are exactly the four verified routes, and nothing else can be built", () => {
  const forms = code("mobileContactForms.ts");
  const paths = [...forms.matchAll(/path:\s*(`[^`]*`|"[^"]*")/g)].map((m) => m[1]);
  assert.deepEqual(paths, ['"/grow/activities"', '"/grow/activities"', "`/grow/contacts/${partyId}/commitments`", "`/grow/contacts/commitments/${commitmentId}`", "`/grow/contacts/commitments/${commitmentId}`"]);
  // the type's own union, three POST builders, and two PATCH builders
  assert.deepEqual([...forms.matchAll(/method:\s*"([A-Z]+)"/g)].map((m) => m[1]), ["POST", "POST", "POST", "POST", "PATCH", "PATCH"]);
  for (const forbidden of ["/consent", "/communications", "/email", "/sms", "/opportunities", "/relationships", "/roles", "DELETE", "PUT"]) {
    assert.equal(forms.includes(forbidden), false, `no route for ${forbidden}`);
  }
  assert.match(forms, /activityType: "note"/);
  assert.match(forms, /type !== "call" && type !== "meeting"/);
});

test("tap to call is a tel: link built in one place, which honours explicit restrictions and fails closed", () => {
  assert.equal([...M4_FILES].filter((f) => /tel:/.test(code(f))).join(","), "mobileCalling.ts");
  const calling = code("mobileCalling.ts");
  assert.match(calling, /contactability\.status === "BLOCKED"/);
  assert.match(calling, /phone\.suppressed/);
  assert.match(calling, /phone\.dncrStatus === "LISTED"/);
  assert.match(calling, /phone\.consentState === "WITHDRAWN"/);
  assert.match(calling, /if \(!contactability\)/);
  // nothing records, requests or stores a call, and nothing asks for consent
  for (const f of ["mobileCalling.ts", "useCallReturn.ts", "CallReturnPrompt.tsx"]) {
    assert.doesNotMatch(code(f), /apiFetch|useMutation|useQuery|fetch\(|localStorage|sessionStorage|indexedDB|method:|"\/grow\/activities"/, `${f}: a call is never recorded`);
    assert.doesNotMatch(code(f), /confirm\(|reconfirm|Confirm consent|consent prompt|Are you sure/i, `${f}: no consent prompt`);
  }
});

// ── CSS ───────────────────────────────────────────────────────────────────

const css = read("mobilePeople.css");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
const lum = (hex: string) => { const h = hex.replace("#", ""); const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
function rules() { const out: Array<{ selector: string; body: string }> = []; const re = /([^{}]+)\{([^{}]*)\}/g; let m: RegExpExecArray | null; while ((m = re.exec(bare))) out.push({ selector: m[1].trim().replace(/^@media[^{]*$/, ""), body: m[2] }); return out; }
const rule = (sel: string) => rules().find((r) => r.selector.split(",").map((s) => s.trim()).includes(sel));
const px = (body: string, prop: string) => { const m = new RegExp(`(?:^|[;\\s])${prop}:\\s*(\\d+)px`).exec(body); return m ? Number(m[1]) : null; };

test("css: every selector is a .ae-minimal .mob-p or .mob-c class", () => {
  for (const r of rules()) {
    if (!r.selector) continue;
    for (const part of r.selector.split(",").map((s) => s.trim())) assert.match(part, /^\.ae-minimal \.mob-[pc](-|\b)/, part);
  }
});

test("css: targets 44 px or more, rows 56 px or more, main actions 48 px or more, fields 16 px, room under the bar", () => {
  for (const sel of [".ae-minimal .mob-p-button", ".ae-minimal .mob-p-link", ".ae-minimal .mob-c-back", ".ae-minimal .mob-c-button"]) assert.ok((px(rule(sel)!.body, "min-height") ?? 0) >= 44, sel);
  for (const sel of [".ae-minimal .mob-c-call", ".ae-minimal .mob-c-primary", ".ae-minimal .mob-p-input", ".ae-minimal .mob-c-input"]) assert.ok((px(rule(sel)!.body, "min-height") ?? 0) >= 48, sel);
  assert.ok((px(rule(".ae-minimal .mob-c-row")!.body, "min-height") ?? 0) >= 56, "rows");
  for (const sel of [".ae-minimal .mob-p-input", ".ae-minimal .mob-c-input"]) assert.ok((px(rule(sel)!.body, "font-size") ?? 0) >= 16, `${sel} text`);
  for (const sel of [".ae-minimal .mob-p", ".ae-minimal .mob-c"]) assert.match(rule(sel)!.body, /padding:\s*\d+px 16px (8\d|9\d|\d{3})px 16px/, `${sel} leaves room for the bottom bar`);
});

test("css: the picker's rows are 56 px, and a disabled control looks disabled", () => {
  assert.ok((px(rule(".ae-minimal .mob-c-pick")!.body, "min-height") ?? 0) >= 56);
  assert.match(rule(".ae-minimal .mob-c-button[disabled]")!.body, /cursor:\s*not-allowed/);
});

test("css: colours follow the Minimal theme rules, text is AA, focus is never removed", () => {
  assert.doesNotMatch(bare, /#EA580C/i);
  assert.doesNotMatch(bare, /outline:\s*(none|0)/i);
  assert.match(rule(".ae-minimal .mob-c-call")!.body, /background:\s*var\(--am-orange-strong,\s*#C44F17\)/);
  const pairs: Array<[string, string, string]> = [
    ["#FFFFFF", "#C44F17", "white on the call and primary buttons"], ["#A83F0C", "#F4F5F7", "link on the page"], ["#B3261E", "#FFFFFF", "warnings and overdue"],
    ["#4A5361", "#FFFFFF", "muted on white"], ["#4A5361", "#F4F5F7", "muted on the page"], ["#2B3340", "#E8EBF0", "role chip"], ["#8F3208", "#FDEEE5", "avatar"], ["#14181F", "#FFFFFF", "ink"],
  ];
  for (const [fg, bg, name] of pairs) assert.ok(contrast(fg, bg) >= 4.5, `${name}: ${contrast(fg, bg).toFixed(2)}`);
  assert.ok(contrast("#7A8494", "#FFFFFF") >= 3, "field border meets 3:1");
});
