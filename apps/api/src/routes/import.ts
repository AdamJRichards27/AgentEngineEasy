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
import { db, importJobs, type ImportResolution } from "@aee/db";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
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
  console.error("import route error", err);
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

/* -------------------------------------------------------------------- */
/* B.3/B.4/B.6 -- upload + mapping                                      */
/* -------------------------------------------------------------------- */

importRouter.post("/jobs", requireAuth, requireEntitlement("grow.import.execute"), upload.single("file"), async (req, res) => {
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
    res.status(201).json({ job, suggestedMapping });
  } catch (err) {
    handleError(res, err);
  }
});

importRouter.get("/jobs", requireAuth, requireEntitlement("grow.import.review"), async (req, res) => {
  try {
    const jobs = await listImportJobs(req.authedUser!.brokerageId);
    res.json({ jobs });
  } catch (err) {
    handleError(res, err);
  }
});

importRouter.get("/jobs/:id", requireAuth, requireEntitlement("grow.import.review"), async (req, res) => {
  try {
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

importRouter.put("/jobs/:id/mapping", requireAuth, requireEntitlement("grow.import.execute"), async (req, res) => {
  try {
    const importJobId = Number(req.params.id);
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

importRouter.get("/jobs/:id/preview", requireAuth, requireEntitlement("grow.import.review"), async (req, res) => {
  try {
    const importJobId = Number(req.params.id);
    const brokerageId = req.authedUser!.brokerageId;
    const preview = await buildImportPreview(importJobId, brokerageId);
    res.json(preview);
  } catch (err) {
    handleError(res, err);
  }
});

importRouter.post("/jobs/:id/resolve", requireAuth, requireEntitlement("grow.import.review"), async (req, res) => {
  try {
    const importJobId = Number(req.params.id);
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
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

/* -------------------------------------------------------------------- */
/* B.16-B.19 -- execute + rollback                                      */
/* -------------------------------------------------------------------- */

importRouter.post("/jobs/:id/execute", requireAuth, requireEntitlement("grow.import.execute"), async (req, res) => {
  try {
    const importJobId = Number(req.params.id);
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
    const result = await executeImportBatch({
      importJobId,
      brokerageId,
      agentId: req.authedUser!.id,
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
    res.json(result);
  } catch (err) {
    handleError(res, err);
  }
});

importRouter.post("/jobs/:id/rollback", requireAuth, requireEntitlement("grow.import.execute"), async (req, res) => {
  try {
    const importJobId = Number(req.params.id);
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

importRouter.get("/jobs/:id/rejected.csv", requireAuth, requireEntitlement("grow.import.review"), async (req, res) => {
  try {
    const importJobId = Number(req.params.id);
    const brokerageId = req.authedUser!.brokerageId;
    const csv = await exportRejectedRecordsCsv(importJobId, brokerageId);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="import-${importJobId}-rejected.csv"`);
    res.send(csv);
  } catch (err) {
    handleError(res, err);
  }
});
