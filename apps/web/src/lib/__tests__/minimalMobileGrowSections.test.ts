import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MOBILE_HIDDEN_GROW_SECTIONS, MobileGrowSections, mobileGrowSections } from "../../minimal/mobile/MobileGrowSections";
import { MINIMAL_GROW_SECTIONS } from "../../minimal/minimalGrowNav";
import { all, hrefs, text } from "./mobileTreeHelpers";

// AE Mobile (CC Task #64): the phone's Grow section bar has no Nurture, and phone-only size fixes for existing controls.

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

test("the phone bar is the app's own section list minus Nurture, in the same order and with the same addresses", () => {
  assert.deepEqual([...MOBILE_HIDDEN_GROW_SECTIONS], ["nurture"]);
  assert.deepEqual(mobileGrowSections().map((s) => s.key), MINIMAL_GROW_SECTIONS.filter((s) => s.key !== "nurture").map((s) => s.key));
  assert.ok(MINIMAL_GROW_SECTIONS.some((s) => s.key === "nurture"), "Nurture still exists on desktop: only the phone hides it");
  const tree = MobileGrowSections({ current: "contacts" });
  assert.doesNotMatch(text(tree), /nurture/i);
  assert.deepEqual(hrefs(tree), mobileGrowSections().map((s) => s.href));
  assert.equal(hrefs(tree).some((h) => /nurture/.test(h)), false);
});

test("the current section is marked, once", () => {
  const tree = MobileGrowSections({ current: "contacts" });
  const current = all(tree, (e) => e.props?.["aria-current"] === "page");
  assert.equal(current.length, 1);
  assert.match(text(current[0]), /contacts/i);
  assert.equal(all(MobileGrowSections({ current: "nurture" }), (e) => e.props?.["aria-current"] === "page").length, 0, "no phone entry for a hidden section");
});

test("every phone screen uses this bar, never the desktop one", () => {
  for (const f of ["MobileToday.tsx", "MobilePeople.tsx", "MobileContact.tsx"]) {
    const src = read(`../../minimal/mobile/${f}`);
    assert.match(src, /MobileGrowSections/, f);
    assert.doesNotMatch(src, /MinimalGrowSections/, f);
  }
});

test("phone fixes: one media query at the shell's 760 px, doubled class so later sheets cannot undo them, 44 px, existing classes only", () => {
  const css = read("../../minimal/mobile/mobileFixes.css");
  assert.match(css, /@media \(max-width: 760px\) \{/);
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "").slice(css.replace(/\/\*[\s\S]*?\*\//g, "").indexOf("{", css.replace(/\/\*[\s\S]*?\*\//g, "").indexOf("@media")));
  const rules = [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), decl: m[2] }));
  assert.ok(rules.length >= 5);
  for (const r of rules) {
    for (const sel of r.sel.split(",").map((x) => x.trim())) assert.match(sel, /^\.ae-minimal\.ae-minimal /, sel);
    // every rule enlarges a control to 44 px, except the one that hides the classic tab bar's Nurture button (tested below)
    if (/\.pc-tab:nth-child/.test(r.sel)) assert.match(r.decl, /display:\s*none/);
    else assert.match(r.decl, /min-height:\s*44px/, r.sel);
  }
  assert.equal(css.replace(/\/\*[\s\S]*?\*\//g, "").slice(0, css.replace(/\/\*[\s\S]*?\*\//g, "").indexOf("@media")).includes("{"), false, "no rule outside the phone media query");
  // the classes are the app's own: if one is renamed, this fails instead of the fix silently doing nothing
  const app = read("../../minimal/minimal.css") + read("../../minimal/properties/properties.css");
  for (const cls of ["am-classic-switch", "am-back-link", "am-data-button", "am-agenda-title", "am-data-card-meta", "am-empty-note"]) assert.ok(app.includes(`.${cls}`), `${cls} still exists in the app's styles`);
  const markup = read("../../minimal/MinimalShell.tsx") + read("../../minimal/properties/MinimalPropertyDetailView.tsx") + read("../../minimal/properties/MinimalPropertyContacts.tsx") + read("../../minimal/properties/MinimalPropertiesView.tsx");
  for (const cls of ["am-classic-switch", "am-back-link", "am-data-button", "am-agenda-title", "am-data-card-meta", "am-empty-note"]) assert.ok(markup.includes(cls), `${cls} is still used`);
});

test("the classic tab bar's Nurture button is hidden by its real position, computed from the app's own tab list", async () => {
  const { GROW_TABS } = await import("../growWorkspace");
  const css = read("../../minimal/mobile/mobileFixes.css");
  const grow = read("../../pages/Grow.tsx");
  // Grow.tsx renders each tab as a child of nav.grow-tabs, and inserts the Appraisals link right after Opportunities
  assert.match(grow, /<nav className="pc-tabs grow-tabs"/);
  assert.match(grow, /if \(t\.key !== "opportunities"\) return \[tabButton\];/);
  assert.match(grow, /<Link key="appraisals" href="\/grow\/appraisals" className="pc-tab">/);
  const order = GROW_TABS.flatMap((t) => (t.key === "opportunities" ? [t.key, "appraisals-link"] : [t.key]));
  const position = order.indexOf("nurture") + 1;
  assert.equal(position, 5, "today, opportunities, appraisals link, contacts, nurture");
  assert.match(css, new RegExp(`\\.grow-tabs \\.pc-tab:nth-child\\(${position}\\) \\{\\s*display: none;`));
  // the Import link and the form controls the classic screens use
  assert.match(css, /a\[href="\/grow\/import"\]/);
  assert.ok(grow.includes('href="/grow/import"'), "the Import link still exists");
});

test("the phone styles load both sheets", () => {
  const src = read("../../minimal/mobile/mobileStyles.ts");
  assert.match(src, /import "\.\/mobile\.css";/);
  assert.match(src, /import "\.\/mobileFixes\.css";/);
});
