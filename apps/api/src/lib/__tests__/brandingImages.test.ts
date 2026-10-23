// CC #52 branding S1 — image intake unit tests (no DB).
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import sharp from "sharp";
import {
  BRANDING_MAX_UPLOAD_BYTES,
  BrandingImageError,
  detectBrandingImageType,
  parseBrandingCrop,
  processBrandingImage,
} from "../branding/images.js";
import { logicalSourceAllowed } from "../documentStorage.js";
import { buildBrandingUploadLimiter } from "../../routes/branding.js";
import { brandingFieldsSchema, resolveEffectiveBranding } from "../branding/profile.js";

const exifJpeg = () =>
  sharp({ create: { width: 800, height: 600, channels: 3, background: "#3366aa" } })
    .withExif({
      IFD0: { Make: "LeakyCam", Model: "SecretModel", Copyright: "Private Person" },
      IFD3: { GPSLatitudeRef: "S", GPSLatitude: "27/1 28/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "153/1 1/1 0/1" },
    })
    .jpeg()
    .toBuffer();

test("magic-byte allowlist: PNG, JPEG, WebP only; GIF/SVG/PDF/text rejected", async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).png().toBuffer();
  const jpg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).jpeg().toBuffer();
  const webp = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).webp().toBuffer();
  const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).gif().toBuffer();
  assert.equal(detectBrandingImageType(png), "image/png");
  assert.equal(detectBrandingImageType(jpg), "image/jpeg");
  assert.equal(detectBrandingImageType(webp), "image/webp");
  assert.equal(detectBrandingImageType(gif), null);
  assert.equal(detectBrandingImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(detectBrandingImageType(Buffer.from("%PDF-1.7")), null);
  await assert.rejects(processBrandingImage({ bytes: gif, declaredMimeType: "image/gif", kind: "logo" }), (e: unknown) => e instanceof BrandingImageError && e.code === "UNSUPPORTED_IMAGE_TYPE");
});

test("declared type must match the bytes (spoofed MIME rejected)", async () => {
  const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#fff" } }).png().toBuffer();
  await assert.rejects(processBrandingImage({ bytes: png, declaredMimeType: "image/jpeg", kind: "photo" }), (e: unknown) => e instanceof BrandingImageError && e.code === "IMAGE_TYPE_MISMATCH");
});

test("size and dimension limits", async () => {
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(BRANDING_MAX_UPLOAD_BYTES)]);
  await assert.rejects(processBrandingImage({ bytes: big, declaredMimeType: "image/png", kind: "logo" }), (e: unknown) => e instanceof BrandingImageError && e.code === "IMAGE_TOO_LARGE");
  const wide = await sharp({ create: { width: 6500, height: 10, channels: 3, background: "#fff" } }).png().toBuffer();
  await assert.rejects(processBrandingImage({ bytes: wide, declaredMimeType: "image/png", kind: "logo" }), (e: unknown) => e instanceof BrandingImageError && e.code === "IMAGE_DIMENSIONS");
  const tiny = await sharp({ create: { width: 120, height: 120, channels: 3, background: "#fff" } }).jpeg().toBuffer();
  await assert.rejects(processBrandingImage({ bytes: tiny, declaredMimeType: "image/jpeg", kind: "photo" }), (e: unknown) => e instanceof BrandingImageError && e.code === "IMAGE_DIMENSIONS");
  const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("not really a jpeg")]);
  await assert.rejects(processBrandingImage({ bytes: corrupt, declaredMimeType: "image/jpeg", kind: "photo" }), (e: unknown) => e instanceof BrandingImageError && e.code === "IMAGE_UNREADABLE");
});

test("EXIF and GPS are stripped; photo re-encoded to 600x600 JPEG", async () => {
  const input = await exifJpeg();
  const inMeta = await sharp(input).metadata();
  assert.ok(inMeta.exif && inMeta.exif.length > 0, "fixture carries EXIF");
  assert.ok(input.includes(Buffer.from("LeakyCam")));
  const out = await processBrandingImage({ bytes: input, declaredMimeType: "image/jpeg", kind: "photo" });
  const meta = await sharp(out.bytes).metadata();
  assert.equal(out.mimeType, "image/jpeg");
  assert.equal(meta.exif, undefined);
  assert.equal(meta.xmp, undefined);
  assert.equal(meta.width, 600);
  assert.equal(meta.height, 600);
  for (const s of ["LeakyCam", "SecretModel", "Private Person", "GPS"]) assert.equal(out.bytes.includes(Buffer.from(s)), false, s);
});

test("WebP logo is accepted, cropped and stored as PNG without enlarging", async () => {
  const webp = await sharp({ create: { width: 1000, height: 400, channels: 4, background: "#E8590C" } }).webp().toBuffer();
  const out = await processBrandingImage({ bytes: webp, declaredMimeType: "image/webp", kind: "logo", crop: { x: 100, y: 50, width: 800, height: 200 } });
  assert.equal(out.mimeType, "image/png");
  assert.equal(out.inputType, "image/webp");
  assert.deepEqual([out.width, out.height], [800, 200]);
  await assert.rejects(
    processBrandingImage({ bytes: webp, declaredMimeType: "image/webp", kind: "logo", crop: { x: 900, y: 0, width: 200, height: 100 } }),
    (e: unknown) => e instanceof BrandingImageError && e.code === "INVALID_CROP",
  );
});

test("crop parsing rejects malformed input", () => {
  assert.equal(parseBrandingCrop(undefined), null);
  assert.deepEqual(parseBrandingCrop('{"x":1,"y":2,"width":3,"height":4}'), { x: 1, y: 2, width: 3, height: 4 });
  for (const bad of ["{", '{"x":-1,"y":0,"width":3,"height":4}', '{"x":0.5,"y":0,"width":3,"height":4}', "[1,2]", "x".repeat(500)]) {
    assert.throws(() => parseBrandingCrop(bad), BrandingImageError, bad.slice(0, 20));
  }
});

test("logical-document source rule: telephony and branding can't write each other's kinds", () => {
  assert.equal(logicalSourceAllowed("telephony", "call_recording"), true);
  assert.equal(logicalSourceAllowed("telephony", "branding_agent_logo"), false);
  assert.equal(logicalSourceAllowed("branding", "branding_agent_logo"), true);
  assert.equal(logicalSourceAllowed("branding", "call_recording"), false);
  assert.equal(logicalSourceAllowed("upload", "branding_agent_logo"), false);
});

test("fields: never invented; licence stays as entered; markup and non-https websites rejected", () => {
  const ok = brandingFieldsSchema.parse({ fullName: "  Sam Agent  ", licence: "" });
  assert.equal(ok.fullName, "Sam Agent");
  assert.equal(ok.licence, null);
  assert.equal(ok.title, null);
  assert.equal(brandingFieldsSchema.safeParse({ fullName: "Sam", website: "http://x.example" }).success, false);
  assert.equal(brandingFieldsSchema.safeParse({ fullName: "Sam", bio: "<script>" }).success, false);
  assert.equal(brandingFieldsSchema.safeParse({ fullName: "Sam", isAdmin: true }).success, false);
  assert.equal(brandingFieldsSchema.safeParse({ fullName: "" }).success, false);
  const eff = resolveEffectiveBranding(ok, { title: "Principal" });
  assert.equal(eff.fields.title, "Principal");
  assert.equal(eff.sources.title, "appraisal");
  assert.equal(eff.fields.licence, null);
  assert.equal(eff.sources.licence, "none");
});

test("upload rate limit is per user", async () => {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { authedUser: { id: number } }).authedUser = { id: Number(req.headers["x-user"]) };
    next();
  });
  app.post("/u", buildBrandingUploadLimiter(2), (_req, res) => res.json({ ok: true }));
  const server: Server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const port = (server.address() as { port: number }).port;
  const hit = (user: number) => fetch(`http://127.0.0.1:${port}/u`, { method: "POST", headers: { "x-user": String(user) } }).then((r) => r.status);
  try {
    assert.deepEqual([await hit(1), await hit(1), await hit(1)], [200, 200, 429]);
    assert.equal(await hit(2), 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
