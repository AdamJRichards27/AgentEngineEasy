// Stage B import routes (B.20-B.24). Every route is brokerage-scoped off
// req.authedUser -- never a client-supplied brokerageId -- and gated by the
// same two Grow entitlement keys the billing catalogue already defines:
// grow.import.execute (upload/mapping/execute/rollback -- anything that can
// change data) and grow.import.review (read-only preview/duplicate-review/
// history/export). Every mutating action also writes an audit row via the
// same logAudit() pattern every other route in this app uses.

import { Router } from "express";
import multer from "multer";
import { and, eq } from "drizzle-orm";
import { auditLogs, db, importJobs, type ImportResolution } from "@aee/db";
import { logger } from "@aee/events";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { auditAuthorityAction, entitlementOrAuthority, isPitCrew } from "../lib/contactAuthority.js";
import { DUPLICATE_OVERRIDE_ROLES, findContactDuplicates, OVERRIDE_REASON_MAX, OVERRIDE_REASON_MIN, visibleDuplicates } from "../lib/contactDuplicates.js";
import { logAudit } from "../lib/audit.js";
import { executeImportBatch, rollbackImportJob } from "../lib/import/execute.js";
import {
  createImportJobFromFile,
  runMappingAndValidation,
  buildImportPreview,
  resolveDuplicateGroup,
  buildExecutionPlan,
  listImportJobs,
  exportRejectedRecordsCsv,
  ImportUserError,
} from "../lib/import/pipeline.js";
import { MAX_FILE_SIZE_BYTES } from "../lib/import/fileValidation.js";

export const importRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE_BYTES } });

function handleError(res: import("express").Response, err: unknown) {
  if (err instanceof ImportUserError) {
    res.status(400).json({ error: err.message });
    return;
  }
  logger.error("import_route_failed", { error: err });
  res.status(500).json({ error: "Something went wrong processing this import." });
}

async function loadJobOr404(importJobId: number, brokerageId: number) {
  const [job] = await db
    .select()
    .from(importJobs)
    .where(and(eq(importJobs.id, importJobId), eq(importJobs.brokerageId, brokerageId)))
    .limit(1);
  return job ?? null;
}

/*
 * t275u (Owner): Pit Crew runs imports only on a contact owner's recorded authority,
 * under the OWNER's import entitlement, and sees only the jobs it ran for that owner.
 * The job owner is recorded in audit_logs (import_job_owner_recorded, provider_reference
 * "owner:<id>"); a job without that row belongs to its initiating user. Imported
 * contacts are assigned to the owner (agentId/createdBy = owner). Agents and
 * Brokerage Administrators are unchanged.
 */
function importGate(key: "grow.import.execute" | "grow.import.review") {
  return entitlementOrAuthority(key, requireEntitlement(key));
}

async function jobOwnerId(job: { id: number; initiatedByUserId: number }, brokerageId: number): Promise<number> {
  const [row] = await db
    .select({ ref: auditLogs.providerReference })
    .from(auditLogs)
    .where(and(eq(auditLogs.brokerageId, brokerageId), eq(auditLogs.action, "import_job_owner_recorded"), eq(auditLogs.recordId, String(job.id))))
    .limit(1);
  const m = /^owner:(\d+)$/.exec(row?.ref ?? "");
  return m ? Number(m[1]) : job.initiatedByUserId;
}

/** True when the response was sent: Pit Crew acting outside its owner's job (404, like a missing job). */
async function pitCrewJobRefused(req: import("express").Request, res: import("express").Response, importJobId: number): Promise<boolean> {
  if (!req.actingFor) return false;
  const job = await loadJobOr404(importJobId, req.authedUser!.brokerageId);
  if (!job) return false;
  if ((await jobOwnerId(job, job.brokerageId)) === req.actingFor.owner.id) return false;
  res.status(404).json({ error: "Import job not found.", code: "CONTACT_OWNER_OUT_OF_SCOPE" });
  return true;
}

/** Import create items that match an existing contact and were not overridden with a recorded reason. */
async function unresolvedImportDuplicates(
  req: import("express").Request,
  importJobId: number,
  brokerageId: number,
  contacts: Array<{ groupKey: string; resolution: string; person: { firstName?: string | null; lastName?: string | null; organisationName?: string | null; email?: string | null; mobile?: string | null } }>,
) {
  const overridden = new Set(
    (
      await db
        .select({ ref: auditLogs.providerReference })
        .from(auditLogs)
        .where(and(eq(auditLogs.brokerageId, brokerageId), eq(auditLogs.action, "contact_duplicate_override"), eq(auditLogs.recordType, "ImportJob"), eq(auditLogs.recordId, String(importJobId))))
    ).map((r) => r.ref),
  );
  const blocked: Array<{ groupKey: string; matches: Awaited<ReturnType<typeof visibleDuplicates>> }> = [];
  for (const item of contacts) {
    if (item.resolution !== "create_new") continue;
    if (overridden.has(`group:${item.groupKey}`)) continue;
    const hits = await findContactDuplicates(brokerageId, item.person);
    if (hits.length) blocked.push({ groupKey: item.groupKey, matches: await visibleDuplicates(req, hits) });
  }
  return blocked;
}

/* -------------------------------------------------------------------- */
/* B.3/B.4/B.6 -- upload + mapping                                      */
/* -------------------------------------------------------------------- */

importRouter.post("/jobs", requireAuth, importGate("grow.import.execute"), upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No file was uploaded (expected multipart field \"file\")." });
      return;
    }
    const brokerageId = req.authedUser!.brokerageId;
    const { job, suggestedMapping } = await createImportJobFromFile(brokerageId, req.authedUser!.id, {
      originalname: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      buffer: req.file.buffer,
    });
    await logAudit({
      userId: req.authedUser!.id,
      action: "import.job.created",
      recordType: "ImportJob",
      recordId: String(job.id),
      updatedValue: JSON.stringify({ filename: job.filename, totalRows: job.totalRows }),
    });
    if (req.actingFor) {
      await logAudit({
        brokerageId,
        userId: req.authedUser!.id,
        action: "import_job_owner_recorded",
        recordType: "ImportJob",
        recordId: String(job.id),
        providerReference: `owner:${req.actingFor.owner.id}`,
      });
      await auditAuthorityAction(req, { action: "import_job_created_on_authority", recordType: "ImportJob", recordId: job.id, after: { filename: job.filename, totalRows: job.totalRows } });
    }
    res.status(201).json({ job, suggestedMapping });
  } catch (err) {
    handleError(res, err);
  }
});

importRouter.get("/jobs", requireAuth, importGate("grow.import.review"), async (req, res) => {
  try {
    let jobs = await listImportJobs(req.authedUser!.brokerageId);
    if (req.actingFor) {
      const ownerId = req.actingFor.owner.id;
      const owned: typeof jobs = [];
      for (const j of jobs) if ((await jobOwnerId(j as never, req.authedUser!.brokerageId)) === ownerId) owned.push(j);
      jobs = owned;
    }
    res.json({ jobs });
  } catch (err) {
    handleError(res, err);
  }
});

importRouter.get("/jobs/:id", requireAuth, importGate("grow.import.review"), async (req, res) => {
  try {
    if (await pitCrewJobRefused(req, res, Number(req.params.id))) return;
    const job = await loadJobOr404(Number(req.params.id), req.authedUser!.brokerageId);
    if (!job) {
      res.status(404).json({ error: "Import job not found." });
      return;
    }
    res.json({ job });
  } catch (err) {
    handleError(res, err);
  }
});

importRouter.put("/jobs/:id/mapping", requireAuth, importGate("grow.import.execute"), async (req, res) => {
  try {
    const importJobId = Number(req.params.id);
    if (await pitCrewJobRefused(req, res, importJobId)) return;
    const brokerageId = req.authedUser!.brokerageId;
    const mapping = req.body?.mapping;
    if (!mapping || typeof mapping !== "object") {
      res.status(400).json({ error: "Request body must include a \"mapping\" object." });
      return;
    }
    const counts = await runMappingAndValidation(importJobId, brokerageId, mapping);
    await logAudit({
      userId: req.authedUser!.id,
      action: "import.job.mapping_submitted",
      recordType: "ImportJob",
      recordId: String(importJobId),
      updatedValue: JSON.stringify(counts),
    });
    res.json(counts);
  } catch (err) {
    handleError(res, err);
  }
});

/* -------------------------------------------------------------------- */
/* B.13/B.14 -- preview + duplicate review                              */
/* -------------------------------------------------------------------- */

importRouter.get("/jobs/:id/preview", requireAuth, importGate("grow.import.review"), async (req, res) => {
  try {
    const importJobId = Number(req.params.id);
    if (await pitCrewJobRefused(req, res, importJobId)) return;
    const brokerageId = req.authedUser!.brokerageId;
    const preview = await buildImportPreview(importJobId, brokerageId);
    res.json(preview);
  } catch (err) {
    handleError(res, err);
  }
});

importRouter.post("/jobs/:id/resolve", requireAuth, importGate("grow.import.review"), async (req, res) => {
  try {
    const importJobId = Number(req.params.id);
    if (await pitCrewJobRefused(req, res, importJobId)) return;
    const brokerageId = req.authedUser!.brokerageId;
    const { kind, groupKey, resolution, candidateId } = req.body ?? {};
    if (kind !== "contact" && kind !== "property") {
      res.status(400).json({ error: "\"kind\" must be \"contact\" or \"property\"." });
      return;
    }
    if (typeof groupKey !== "string" || !groupKey) {
      res.status(400).json({ error: "\"groupKey\" is required." });
      return;
    }
    const validResolutions: ImportResolution[] = ["use_existing", "create_new", "merge", "skip"];
    if (!validResolutions.includes(resolution)) {
      res.status(400).json({ error: `"resolution" must be one of ${validResolutions.join(", ")}.` });
      return;
    }
    // t275u: choosing "create new" for a contact that matches an existing one is a duplicate
    // override — authorised users only, with a recorded reason (shared duplicate rule).
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (kind === "contact" && resolution === "create_new") {
      const u = req.authedUser!;
      if (!((DUPLICATE_OVERRIDE_ROLES as readonly string[]).includes(u.role) || (isPitCrew(u) && !!req.actingFor))) {
        res.status(403).json({ error: "You are not authorised to override a duplicate contact.", code: "DUPLICATE_OVERRIDE_NOT_AUTHORISED" });
        return;
      }
      if (reason.length < OVERRIDE_REASON_MIN || reason.length > OVERRIDE_REASON_MAX) {
        res.status(409).json({ error: `Creating a duplicate needs a reason (${OVERRIDE_REASON_MIN}-${OVERRIDE_REASON_MAX} characters).`, code: "DUPLICATE_OVERRIDE_REASON_REQUIRED" });
        return;
      }
    }
    const result = await resolveDuplicateGroup(
      importJobId,
      brokerageId,
      kind,
      groupKey,
      resolution,
      typeof candidateId === "number" ? candidateId : undefined,
    );
    await logAudit({
      userId: req.authedUser!.id,
      action: "import.job.duplicate_resolved",
      recordType: "ImportJob",
      recordId: String(importJobId),
      updatedValue: JSON.stringify({ kind, groupKey, resolution, candidateId, rowsAffected: result.rowsAffected }),
    });
    if (kind === "contact" && resolution === "create_new") {
      await logAudit({
        brokerageId,
        userId: req.authedUser!.id,
        action: "contact_duplicate_override",
        recordType: "ImportJob",
        recordId: String(importJobId),
        providerReference: `group:${groupKey}`,
        updatedValue: JSON.stringify({ path: "import", groupKey, reason, requestedBy: req.actingFor?.owner.id ?? req.authedUser!.id, performedBy: req.authedUser!.id, authorityRef: req.actingFor?.authorityRef ?? null }),
      });
    }
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

/* -------------------------------------------------------------------- */
/* B.16-B.19 -- execute + rollback                                      */
/* -------------------------------------------------------------------- */

importRouter.post("/jobs/:id/execute", requireAuth, importGate("grow.import.execute"), async (req, res) => {
  try {
    const importJobId = Number(req.params.id);
    if (await pitCrewJobRefused(req, res, importJobId)) return;
    const brokerageId = req.authedUser!.brokerageId;
    const job = await loadJobOr404(importJobId, brokerageId);
    if (!job) {
      res.status(404).json({ error: "Import job not found." });
      return;
    }
    // Double-submission guard: a job already mid-import or finished is never
    // silently re-run from this endpoint -- executeImportBatch is itself
    // idempotent per row, but a second concurrent call for the same job would
    // otherwise waste a full re-scan for no reason once it's already done.
    if (job.status === "IMPORTING") {
      res.status(409).json({ error: "This import is already running." });
      return;
    }
    if (job.status === "COMPLETED") {
      res.status(409).json({ error: "This import has already completed." });
      return;
    }

    const plan = await buildExecutionPlan(importJobId, brokerageId);
    // t275u: shared duplicate rule — a "create" row that matches an existing contact
    // (name, email or mobile) blocks the import until it is resolved to the existing
    // contact or overridden with a recorded reason. Masked like every duplicate result.
    const blocked = await unresolvedImportDuplicates(req, importJobId, brokerageId, plan.contacts as never);
    if (blocked.length) {
      res.status(409).json({ error: "Some rows match existing contacts. Resolve them before importing.", code: "POTENTIAL_DUPLICATE_CONTACT", path: "import", groups: blocked });
      return;
    }
    const result = await executeImportBatch({
      importJobId,
      brokerageId,
      agentId: req.actingFor?.owner.id ?? req.authedUser!.id,
      contacts: plan.contacts,
      contactProperties: plan.contactProperties,
      relationships: plan.relationships,
    });
    await logAudit({
      userId: req.authedUser!.id,
      action: "import.job.executed",
      recordType: "ImportJob",
      recordId: String(importJobId),
      updatedValue: JSON.stringify(result),
    });
    if (req.actingFor) await auditAuthorityAction(req, { action: "import_job_executed_on_authority", recordType: "ImportJob", recordId: importJobId, after: { contactsCreated: (result as { contactsCreated?: number }).contactsCreated ?? null } });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

importRouter.post("/jobs/:id/rollback", requireAuth, importGate("grow.import.execute"), async (req, res) => {
  try {
    const importJobId = Number(req.params.id);
    if (await pitCrewJobRefused(req, res, importJobId)) return;
    const brokerageId = req.authedUser!.brokerageId;
    const job = await loadJobOr404(importJobId, brokerageId);
    if (!job) {
      res.status(404).json({ error: "Import job not found." });
      return;
    }
    const result = await rollbackImportJob(importJobId, brokerageId);
    await logAudit({
      userId: req.authedUser!.id,
      action: "import.job.rolled_back",
      recordType: "ImportJob",
      recordId: String(importJobId),
      updatedValue: JSON.stringify({
        rolledBack: result.entries.filter((e) => e.rolledBack).length,
        notRolledBack: result.entries.filter((e) => !e.rolledBack).length,
      }),
    });
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

/* -------------------------------------------------------------------- */
/* B.22 -- rejected-row export                                          */
/* -------------------------------------------------------------------- */

importRouter.get("/jobs/:id/rejected.csv", requireAuth, importGate("grow.import.review"), async (req, res) => {
  try {
    const importJobId = Number(req.params.id);
    if (await pitCrewJobRefused(req, res, importJobId)) return;
    const brokerageId = req.authedUser!.brokerageId;
    const csv = await exportRejectedRecordsCsv(importJobId, brokerageId);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="import-${importJobId}-rejected.csv"`);
    res.send(csv);
  } catch (err) {
    handleError(res, err);
  }
});
