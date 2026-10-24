import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mobileNavOverflowEdges, mobileNavScrollTarget } from "../../minimal/minimalMobileNav";

const bar = { barWidth: 390, scrollWidth: 8 * 68 + 14, scrollLeft: 0 };
describe("V3 mobile nav scroll target", () => {
  it("does nothing when all items fit", () => {
    assert.equal(mobileNavScrollTarget({ barWidth: 768, scrollWidth: 768, scrollLeft: 0, itemLeft: 600, itemWidth: 68 }), null);
  });
  it("does nothing when the active item is already visible", () => {
    assert.equal(mobileNavScrollTarget({ ...bar, itemLeft: 75, itemWidth: 68 }), null);
  });
  it("centres an off-screen item (e.g. Properties at 390px)", () => {
    const t = mobileNavScrollTarget({ ...bar, itemLeft: 7 + 6 * 68, itemWidth: 68 })!;
    assert.ok(t > 0);
    assert.ok(7 + 6 * 68 >= t && 7 + 7 * 68 <= t + 390);
  });
  it("clamps to the scroll range", () => {
    assert.equal(mobileNavScrollTarget({ ...bar, itemLeft: 7 + 7 * 68, itemWidth: 68 }), bar.scrollWidth - 390);
    assert.equal(mobileNavScrollTarget({ ...bar, scrollLeft: 168, itemLeft: 7, itemWidth: 68 }), 0);
  });
  it("partially clipped item counts as hidden", () => {
    assert.notEqual(mobileNavScrollTarget({ ...bar, itemLeft: 340, itemWidth: 68 }), null);
  });
  it("reports overflow edges", () => {
    assert.deepEqual(mobileNavOverflowEdges(bar), { start: false, end: true });
    assert.deepEqual(mobileNavOverflowEdges({ ...bar, scrollLeft: bar.scrollWidth - 390 }), { start: true, end: false });
    assert.deepEqual(mobileNavOverflowEdges({ barWidth: 768, scrollWidth: 768, scrollLeft: 0 }), { start: false, end: false });
  });
});
