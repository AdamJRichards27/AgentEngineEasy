import sharp, { type Sharp } from "sharp";

// CC #52 branding S1 — image intake. Every upload is sniffed by magic bytes
// (PNG, JPEG, WebP only; the declared type must agree), decoded with pixel
// limits, auto-oriented, optionally cropped, resized and re-encoded. sharp
// writes no input metadata unless asked (we never call withMetadata/keepExif),
// so EXIF, GPS, XMP and ICC-embedded comments are dropped. Output is always
// PNG (logo) or JPEG (photo), so the stored type set stays PNG/JPEG.

export const BRANDING_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const BRANDING_MAX_INPUT_DIMENSION = 6000;
export const BRANDING_MIN_PHOTO_SIDE = 200;
export const BRANDING_LOGO_MAX = { width: 1200, height: 600 } as const;
export const BRANDING_PHOTO_SIZE = 600;

export type BrandingImageKind = "logo" | "photo";
export type BrandingInputType = "image/png" | "image/jpeg" | "image/webp";

export class BrandingImageError extends Error {
  constructor(
    readonly code: "UNSUPPORTED_IMAGE_TYPE" | "IMAGE_TYPE_MISMATCH" | "IMAGE_TOO_LARGE" | "IMAGE_DIMENSIONS" | "INVALID_CROP" | "IMAGE_UNREADABLE" | "EMPTY_IMAGE",
    message: string,
  ) {
    super(message);
    this.name = "BrandingImageError";
  }
}

export function detectBrandingImageType(bytes: Buffer): BrandingInputType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function normaliseDeclared(value: string): string {
  const v = value.split(";", 1)[0].trim().toLowerCase();
  return v === "image/jpg" || v === "image/pjpeg" ? "image/jpeg" : v;
}

export interface BrandingCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function parseBrandingCrop(raw: unknown): BrandingCrop | null {
  if (raw === undefined || raw === null || raw === "") return null;
  let value: unknown = raw;
  if (typeof raw === "string") {
    if (raw.length > 200) throw new BrandingImageError("INVALID_CROP", "Crop is not valid.");
    try {
      value = JSON.parse(raw);
    } catch {
      throw new BrandingImageError("INVALID_CROP", "Crop is not valid.");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BrandingImageError("INVALID_CROP", "Crop is not valid.");
  const c = value as Record<string, unknown>;
  const keys = ["x", "y", "width", "height"] as const;
  for (const k of keys) {
    if (typeof c[k] !== "number" || !Number.isInteger(c[k]) || (c[k] as number) < 0) throw new BrandingImageError("INVALID_CROP", "Crop is not valid.");
  }
  if ((c.width as number) < 1 || (c.height as number) < 1) throw new BrandingImageError("INVALID_CROP", "Crop is not valid.");
  return { x: c.x as number, y: c.y as number, width: c.width as number, height: c.height as number };
}

export interface ProcessedBrandingImage {
  bytes: Buffer;
  mimeType: "image/png" | "image/jpeg";
  extension: ".png" | ".jpg";
  width: number;
  height: number;
  inputType: BrandingInputType;
}

export async function processBrandingImage(input: {
  bytes: Buffer;
  declaredMimeType: string;
  kind: BrandingImageKind;
  crop?: BrandingCrop | null;
}): Promise<ProcessedBrandingImage> {
  const { bytes, kind } = input;
  if (!bytes || bytes.length === 0) throw new BrandingImageError("EMPTY_IMAGE", "The image is empty.");
  if (bytes.length > BRANDING_MAX_UPLOAD_BYTES) throw new BrandingImageError("IMAGE_TOO_LARGE", "Images must be 5 MB or smaller.");
  const detected = detectBrandingImageType(bytes);
  if (!detected) throw new BrandingImageError("UNSUPPORTED_IMAGE_TYPE", "Use a PNG, JPG or WebP image.");
  if (normaliseDeclared(input.declaredMimeType) !== detected) {
    throw new BrandingImageError("IMAGE_TYPE_MISMATCH", "The file's contents don't match its type.");
  }
  let pipeline: Sharp;
  let width: number;
  let height: number;
  try {
    pipeline = sharp(bytes, {
      failOn: "error",
      limitInputPixels: BRANDING_MAX_INPUT_DIMENSION * BRANDING_MAX_INPUT_DIMENSION,
      animated: false,
    }).rotate();
    const meta = await sharp(bytes, { failOn: "error", limitInputPixels: BRANDING_MAX_INPUT_DIMENSION * BRANDING_MAX_INPUT_DIMENSION }).metadata();
    if (!meta.width || !meta.height) throw new Error("no size");
    const swap = (meta.orientation ?? 1) >= 5;
    width = swap ? meta.height : meta.width;
    height = swap ? meta.width : meta.height;
  } catch (err) {
    if (err instanceof BrandingImageError) throw err;
    throw new BrandingImageError("IMAGE_UNREADABLE", "That image couldn't be read.");
  }
  if (width > BRANDING_MAX_INPUT_DIMENSION || height > BRANDING_MAX_INPUT_DIMENSION) {
    throw new BrandingImageError("IMAGE_DIMENSIONS", `Images must be at most ${BRANDING_MAX_INPUT_DIMENSION} pixels on each side.`);
  }
  const crop = input.crop ?? null;
  if (crop) {
    if (crop.x + crop.width > width || crop.y + crop.height > height) throw new BrandingImageError("INVALID_CROP", "The crop is outside the image.");
    pipeline = pipeline.extract({ left: crop.x, top: crop.y, width: crop.width, height: crop.height });
    width = crop.width;
    height = crop.height;
  }
  try {
    if (kind === "photo") {
      if (Math.min(width, height) < BRANDING_MIN_PHOTO_SIDE) {
        throw new BrandingImageError("IMAGE_DIMENSIONS", `Profile photos must be at least ${BRANDING_MIN_PHOTO_SIDE} pixels on the short side.`);
      }
      const out = await pipeline
        .resize(BRANDING_PHOTO_SIZE, BRANDING_PHOTO_SIZE, { fit: "cover", position: "centre" })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
      return { bytes: out.data, mimeType: "image/jpeg", extension: ".jpg", width: out.info.width, height: out.info.height, inputType: detected };
    }
    const out = await pipeline
      .resize(BRANDING_LOGO_MAX.width, BRANDING_LOGO_MAX.height, { fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    return { bytes: out.data, mimeType: "image/png", extension: ".png", width: out.info.width, height: out.info.height, inputType: detected };
  } catch (err) {
    if (err instanceof BrandingImageError) throw err;
    throw new BrandingImageError("IMAGE_UNREADABLE", "That image couldn't be read.");
  }
}
