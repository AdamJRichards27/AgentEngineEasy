import { test } from "node:test";
import assert from "node:assert/strict";
import {
  brandingBody, brandingFileError, brandingFormError, brandingFormFrom, brandingSourceLabel,
  cropAspect, overrideBody, serverCrop, appraisalBrandingImageUrl, brandingContactLines, emptyBrandingForm,
} from "../branding";

test("form prefills only name/email/agency suggestions, never title or licence", () => {
  const f = brandingFormFrom({ profile: null, suggestions: { fullName: "Jo Lee", email: "jo@x.au", agencyName: "Acme", title: "Director", licence: "123" } as never });
  assert.equal(f.fullName, "Jo Lee"); assert.equal(f.agencyName, "Acme");
  assert.equal(f.title, ""); assert.equal(f.licence, "");
});
test("saved profile wins over suggestions; blanks become null", () => {
  const f = brandingFormFrom({ profile: { fullName: "Saved" } as never, suggestions: { fullName: "Sugg" } as never });
  assert.equal(f.fullName, "Saved");
  assert.equal(brandingBody(f).title, null);
});
test("validation: name required, https website", () => {
  const f = emptyBrandingForm();
  assert.ok(brandingFormError(f));
  assert.ok(brandingFormError({ ...f, fullName: "A", website: "http://x.au" }));
  assert.equal(brandingFormError({ ...f, fullName: "A", website: "https://x.au" }), null);
});
test("override body contains only fields differing from default", () => {
  const f = { ...emptyBrandingForm(), fullName: "A", title: "Senior" };
  assert.deepEqual(overrideBody(f, { fullName: "A", title: "Agent" }), { title: "Senior" });
});
test("source label", () => {
  assert.equal(brandingSourceLabel({ fullName: "appraisal", title: "agent" }), "This appraisal only");
  assert.equal(brandingSourceLabel({ fullName: "agent" }), "From your default");
  assert.equal(brandingSourceLabel({ fullName: "none" }), "Not set up yet");
});
test("file checks and crop", () => {
  assert.ok(brandingFileError({ type: "image/gif", size: 10 }));
  assert.ok(brandingFileError({ type: "image/png", size: 6 * 1024 * 1024 }));
  assert.equal(brandingFileError({ type: "image/webp", size: 1000 }), null);
  assert.equal(cropAspect("photo"), 1); assert.equal(cropAspect("logo"), undefined);
  const c = serverCrop({ x: -1.4, y: 2.6, width: 5000, height: 99.5 }, { width: 800, height: 600 });
  assert.ok(c && c.x >= 0 && c.x + c.width <= 800 && Number.isInteger(c.y) && c.y + c.height <= 600);
});
test("image urls and contact lines", () => {
  assert.equal(appraisalBrandingImageUrl(5, "logo", null), null);
  assert.match(appraisalBrandingImageUrl(5, "logo", { contentSha256: "abcdef1234567890" } as never) ?? "", /appraisals\/5\/logo\?v=/);
  assert.ok(brandingContactLines({ mobilePhone: "0400", email: "a@b.au" }).length >= 2);
});
