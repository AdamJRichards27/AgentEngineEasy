import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { rateLimit } from "express-rate-limit";
import { requireAuth, type AuthedUser } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { appraisalLifecycleClosed } from "../lib/appraisalFinaliseGuard.js";
import { AppraisalAccessError, assertAppraisalInBrokerage } from "../lib/growAppraisals.js";
import { assertPropertyVisibleForWrite, propertyHiddenFromCaller } from "../lib/propertyVisibility.js";
import { DocumentStorageError } from "../lib/documentStorage.js";
import { BRANDING_MAX_UPLOAD_BYTES, BrandingImageError, parseBrandingCrop, type BrandingImageKind } from "../lib/branding/images.js";
import {
  brandingFieldsSchema,
  brandingOverrideSchema,
  getAgentBranding,
  getAppraisalOverride,
  loadAgentBrandingImage,
  resolveEffectiveBranding,
  saveAgentBrandingFields,
  saveAgentBrandingImage,
  saveAppraisalOverride,
} from "../lib/branding/profile.js";

// CC #52 branding S1. Self-service agent branding plus a per-appraisal
// override. Every route requires a signed-in user with a brokerage; data is
// scoped to req.authedUser.brokerageId. Images are only ever streamed through
// these authenticated routes (no public or signed URLs). Admins cannot edit
// another agent's profile in v1 (Owner t465u decision 5): /me is the only
// profile write surface.

export const brandingRouter = Router();

const requiresGrowAccess = requireEntitlement("grow.access");
const requiresGrowManage = requireEntitlement("grow.opportunities.manage");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BRANDING_MAX_UPLOAD_BYTES, files: 1, fields: 1, parts: 2, fieldNameSize: 16, fieldSize: 256 },
});

const DEFAULT_UPLOADS_PER_HOUR = 20;
function configuredUploadsPerHour(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.BRANDING_UPLOADS_PER_HOUR);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_UPLOADS_PER_HOUR;
}

/** Per signed-in user (not per IP), so a shared office NAT doesn't share one budget. */
export function buildBrandingUploadLimiter(limit: number = configuredUploadsPerHour()) {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `branding-upload:${(req as Request).authedUser?.id ?? "anon"}`,
    message: { error: "Too many image uploads. Try again later.", code: "BRANDING_UPLOAD_RATE_LIMITED" },
  });
}
const uploadLimiter = buildBrandingUploadLimiter();

function caller(req: Request): AuthedUser {
  return req.authedUser!;
}

function sendImage(res: Response, content: { bytes: Buffer; contentType: string }) {
  res.setHeader("Content-Type", content.contentType);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Content-Disposition", "inline");
  res.send(content.bytes);
}

function handleBrandingError(err: unknown, res: Response): void {
  if (err instanceof BrandingImageError) {
    const status = err.code === "IMAGE_TOO_LARGE" ? 413 : err.code === "UNSUPPORTED_IMAGE_TYPE" || err.code === "IMAGE_TYPE_MISMATCH" ? 415 : 422;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof AppraisalAccessError) {
    res.status(404).json({ error: "Appraisal not found" });
    return;
  }
  if (err instanceof DocumentStorageError) {
    res.status(err.code === "DOCUMENT_TOO_LARGE" ? 413 : 422).json({ error: "The image couldn't be stored.", code: err.code });
    return;
  }
  throw err;
}

brandingRouter.get("/me", requireAuth, async (req, res) => {
  res.json(await getAgentBranding(caller(req)));
});

brandingRouter.put("/me", requireAuth, async (req, res) => {
  const parsed = brandingFieldsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the branding details.", field: parsed.error.issues[0]?.path.join(".") });
    return;
  }
  const saved = await saveAgentBrandingFields(caller(req), parsed.data);
  res.json({ profile: saved });
});

function imageUploadRoute(kind: BrandingImageKind) {
  return async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: "Choose an image to upload.", code: "IMAGE_REQUIRED" });
      return;
    }
    try {
      const crop = parseBrandingCrop((req.body as Record<string, unknown> | undefined)?.crop);
      const ref = await saveAgentBrandingImage(caller(req), kind, {
        bytes: req.file.buffer,
        declaredMimeType: req.file.mimetype,
        crop,
      });
      res.status(201).json({ [kind]: ref });
    } catch (err) {
      handleBrandingError(err, res);
    }
  };
}

function imageReadRoute(kind: BrandingImageKind) {
  return async (req: Request, res: Response) => {
    const u = caller(req);
    const content = await loadAgentBrandingImage(u.brokerageId, u.id, kind);
    if (!content) {
      res.status(404).json({ error: "No image saved." });
      return;
    }
    sendImage(res, content);
  };
}

brandingRouter.post("/me/logo", requireAuth, uploadLimiter, upload.single("file"), imageUploadRoute("logo"));
brandingRouter.post("/me/photo", requireAuth, uploadLimiter, upload.single("file"), imageUploadRoute("photo"));
brandingRouter.get("/me/logo", requireAuth, imageReadRoute("logo"));
brandingRouter.get("/me/photo", requireAuth, imageReadRoute("photo"));

function readAppraisalId(req: Request, res: Response): number | null {
  const raw = String(req.params.id ?? "");
  if (!/^[1-9][0-9]{0,9}$/.test(raw)) {
    res.status(400).json({ error: "Invalid appraisal id" });
    return null;
  }
  return Number(raw);
}

/** Readable appraisal (tenant + property visibility), else null after answering 404. */
async function readableAppraisal(req: Request, res: Response) {
  const id = readAppraisalId(req, res);
  if (id === null) return null;
  const u = caller(req);
  try {
    const appraisal = await assertAppraisalInBrokerage(id, u.brokerageId);
    if (await propertyHiddenFromCaller(u, appraisal.propertyId)) {
      res.status(404).json({ error: "Appraisal not found" });
      return null;
    }
    return appraisal;
  } catch (err) {
    handleBrandingError(err, res);
    return null;
  }
}

function snapshotBranding(snapshot: unknown): unknown {
  if (!snapshot || typeof snapshot !== "object") return null;
  return (snapshot as Record<string, unknown>).branding ?? null;
}

brandingRouter.get("/appraisals/:id", requireAuth, requiresGrowAccess, async (req, res) => {
  const appraisal = await readableAppraisal(req, res);
  if (!appraisal) return;
  const u = caller(req);
  const agentId = appraisal.ownerUserId ?? appraisal.createdByUserId ?? null;
  if (appraisal.isFinalised) {
    // Issued appraisals show only what was recorded at issue; nothing live.
    res.json({ appraisalId: appraisal.id, finalised: true, snapshot: snapshotBranding(appraisal.finalisedSnapshot) });
    return;
  }
  const [agent, override] = await Promise.all([
    agentId ? getAgentBranding(u, agentId) : Promise.resolve(null),
    getAppraisalOverride(u.brokerageId, appraisal.id),
  ]);
  const effective = resolveEffectiveBranding(agent?.profile ?? null, override);
  res.json({
    appraisalId: appraisal.id,
    finalised: false,
    agentUserId: agentId,
    override,
    effective: effective.fields,
    sources: effective.sources,
    logo: agent?.logo ?? null,
    photo: agent?.photo ?? null,
  });
});

async function writableOpenAppraisal(req: Request, res: Response) {
  const appraisal = await readableAppraisal(req, res);
  if (!appraisal) return null;
  if (!(await assertPropertyVisibleForWrite(caller(req), appraisal.propertyId))) {
    res.status(404).json({ error: "Appraisal not found" });
    return null;
  }
  if (appraisal.isFinalised || appraisalLifecycleClosed(appraisal.status)) {
    res.status(409).json({ error: "This appraisal is closed, so its branding can't change.", code: "APPRAISAL_BRANDING_LOCKED" });
    return null;
  }
  return appraisal;
}

brandingRouter.put("/appraisals/:id", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const parsed = brandingOverrideSchema.safeParse((req.body as Record<string, unknown> | undefined)?.override);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Check the branding details.", field: parsed.error.issues[0]?.path.join(".") });
    return;
  }
  const appraisal = await writableOpenAppraisal(req, res);
  if (!appraisal) return;
  await saveAppraisalOverride(caller(req), appraisal.id, parsed.data);
  res.json({ appraisalId: appraisal.id, override: parsed.data });
});

brandingRouter.delete("/appraisals/:id", requireAuth, requiresGrowAccess, requiresGrowManage, async (req, res) => {
  const appraisal = await writableOpenAppraisal(req, res);
  if (!appraisal) return;
  await saveAppraisalOverride(caller(req), appraisal.id, null);
  res.json({ appraisalId: appraisal.id, override: null });
});

function appraisalImageRoute(kind: BrandingImageKind) {
  return async (req: Request, res: Response) => {
    const appraisal = await readableAppraisal(req, res);
    if (!appraisal) return;
    const agentId = appraisal.ownerUserId ?? appraisal.createdByUserId ?? null;
    // Finalised appraisals: images come from the issue snapshot in a later slice (S3); nothing live.
    const content = agentId && !appraisal.isFinalised ? await loadAgentBrandingImage(caller(req).brokerageId, agentId, kind) : null;
    if (!content) {
      res.status(404).json({ error: "No image saved." });
      return;
    }
    sendImage(res, content);
  };
}
brandingRouter.get("/appraisals/:id/logo", requireAuth, requiresGrowAccess, appraisalImageRoute("logo"));
brandingRouter.get("/appraisals/:id/photo", requireAuth, requiresGrowAccess, appraisalImageRoute("photo"));

brandingRouter.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({ error: "Images must be 5 MB or smaller.", code: "IMAGE_TOO_LARGE" });
      return;
    }
    res.status(413).json({ error: "Upload one image at a time.", code: "BRANDING_UPLOAD_LIMIT" });
    return;
  }
  next(error);
});
