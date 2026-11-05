// Stage B import routes (B.20-B.24). Every route is brokerage-scoped off
// req.authedUser -- never a client-supplied brokerageId -- and gated by the
// same two Grow entitlement keys the billing catalogue already defines:
// grow.import.execute (upload/mapping/execute/rollback -- anything that can
// change data) and grow.import.review (read-only preview/duplicate-review/
// history/export). Every mutating action also writes an audit row via the
// same logAudit() pattern every other route in this app uses.

import { Router } from "express";
import multer from "multer";
import { and, desc, eq, sql } from "drizzle-orm";
import { auditLogs, db, importJobs, users, type ImportResolution } from "@aee/db";
import { logger } from "@aee/events";
import { requireAuth } from "../middlewares/auth.js";
import { requireEntitlement } from "../middlewares/entitlement.js";
import { auditAuthorityAction, CONTACT_OWNER_ROLES, entitlementOrAuthority, isPitCrew } from "../lib/contactAuthority.js";
import { explainEntitlementDecision } from "../lib/entitlements/resolver.js";
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
    .orderBy(desc(auditLogs.id))
    .limit(1);
  const m = /^owner:(\d+)$/.exec(row?.ref ?? "");
  return m ? Number(m[1]) : job.initiatedByUserId;
}

/*
 * Owner t276u: imported contacts need no property relationship to have an owner. Every
 * contact the import CREATES is recorded as the job owner's (contact_owner_recorded with
 * source "import", the import job and the authority reference), so owner-scoped access
 * (ownedPartyIdsSql) covers it. If the owner cannot be established — the recorded/initiating
 * user no longer exists, is inactive, left the brokerage, is not an Agent or Brokerage
 * Administrator, or no longer holds grow.import.execute — the import is HELD FOR REVIEW
 * (409 IMPORT_HELD_FOR_REVIEW, audited) until an administrator or the new owning agent
 * records an owner with POST /jobs/:id/owner.
 */
async function ownershipProblem(ownerId: number, brokerageId: number): Promise<string | null> {
  const [u] = await db.select({ id: users.id, role: users.role, brokerageId: users.brokerageId, isActive: users.isActive }).from(users).where(eq(users.id, ownerId)).limit(1);
  if (!u) return "OWNER_NOT_FOUND";
  if (u.brokerageId !== brokerageId) return "OWNER_OTHER_BROKERAGE";
  if (!u.isActive) return "OWNER_INACTIVE";
  if (!(CONTACT_OWNER_ROLES as readonly string[]).includes(u.role)) return "OWNER_ROLE";
  const d = await explainEntitlementDecision({ id: u.id, role: u.role as never, brokerageId: u.brokerageId }, "grow.import.execute").catch(() => ({ allowed: false }));
  return d.allowed ? null : "OWNER_NOT_ENTITLED";
}

async function recordImportedOwners(req: import("express").Request, importJobId: number, brokerageId: number, ownerId: number): Promise<number> {
  const rows = (await db.execute(sql`select distinct result_party_id as id from import_records where import_job_id = ${importJobId} and party_was_created = true and result_party_id is not null`)).rows as { id: number }[];
  const already = new Set(
    (
      await db
        .select({ id: auditLogs.recordId })
        .from(auditLogs)
        .where(and(eq(auditLogs.brokerageId, brokerageId), eq(auditLogs.action, "contact_owner_recorded"), eq(auditLogs.providerReference, `owner:${ownerId}`)))
    ).map((r) => r.id),
  );
  const fresh = rows.map((r) => Number(r.id)).filter((id) => !already.has(String(id)));
  if (fresh.length === 0) return 0;
  await db.insert(auditLogs).values(
    fresh.map((id) => ({
      brokerageId,
      userId: req.authedUser!.id,
      action: "contact_owner_recorded",
      recordType: "party",
      recordId: String(id),
      providerReference: `owner:${ownerId}`,
      updatedValue: JSON.stringify({ source: "import", importJobId, requestedBy: { userId: ownerId }, performedBy: { userId: req.authedUser!.id }, authorityRef: req.actingFor?.authorityRef ?? null }),
    })),
  );
  return fresh.length;
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

// t280u: authorised list of imports held for review (and those released from a hold), with
// reason codes and release status. Pit Crew never sees or releases held imports. Requires
// grow.import.execute (the entitlement the release route itself requires).
importRouter.get("/held", requireAuth, async (req, res, next) => {
  if (isPitCrew(req.authedUser!)) {
    res.status(403).json({ error: "Held imports are reviewed by an administrator or the owning agent.", code: "IMPORT_HELD_READ_FORBIDDEN", reason: "PIT_CREW" });
    return;
  }
  next();
}, requireEntitlement("grow.import.execute"), async (req, res) => {
  try {
    const user = req.authedUser!;
    if (user.role !== "Brokerage Administrator" && user.role !== "Agent") {
      res.status(403).json({ error: "Held imports are reviewed by an administrator or the owning agent.", code: "IMPORT_HELD_READ_FORBIDDEN", reason: "ROLE" });
      return;
    }
    const heldEver = new Set(
      (
        await db
          .select({ recordId: auditLogs.recordId })
          .from(auditLogs)
          .where(and(eq(auditLogs.brokerageId, user.brokerageId), eq(auditLogs.action, "import_held_for_review")))
      ).map((r) => Number(r.recordId)),
    );
    const jobs = await listImportJobs(user.brokerageId);
    const out = [];
    for (const j of jobs) {
      if (j.status === "COMPLETED" || j.status === "ROLLED_BACK" || j.status === "CANCELLED") continue;
      const ownerId = await jobOwnerId(j as never, user.brokerageId);
      const reasonCode = await ownershipProblem(ownerId, user.brokerageId);
      if (!reasonCode && !heldEver.has(j.id)) continue;
      const [rel] = await db
        .select({ userId: auditLogs.userId, updatedValue: auditLogs.updatedValue, createdAt: auditLogs.createdAt })
        .from(auditLogs)
        .where(and(eq(auditLogs.brokerageId, user.brokerageId), eq(auditLogs.action, "import_job_owner_recorded"), eq(auditLogs.recordType, "ImportJob"), eq(auditLogs.recordId, String(j.id))))
        .orderBy(desc(auditLogs.id))
        .limit(1);
      const relMeta = rel?.updatedValue ? (JSON.parse(rel.updatedValue) as { authorityRef?: string; source?: string }) : null;
      const released = !reasonCode && relMeta?.source === "review";
      out.push({
        importJobId: j.id,
        filename: j.filename,
        jobStatus: j.status,
        totalRows: j.totalRows,
        uploadedAt: j.uploadedAt,
        initiatedByUserId: j.initiatedByUserId,
        recordedOwnerUserId: ownerId,
        releaseStatus: reasonCode ? ("held" as const) : released ? ("released" as const) : ("not_held" as const),
        reasonCode,
        release: released ? { ownerUserId: ownerId, releasedByUserId: rel!.userId, authorityRef: relMeta?.authorityRef ?? null, releasedAt: rel!.createdAt } : null,
        canAssignAnyOwner: !!reasonCode && user.role === "Brokerage Administrator",
        canAcceptForSelf: !!reasonCode && user.role === "Agent",
      });
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ held: out.filter((o) => o.releaseStatus !== "not_held") });
  } catch (err) {
    handleError(res, err);
  }
});

// t276u: record (or re-record) the owner of a held import. A Brokerage Administrator may
// assign any eligible owner; an Agent may take ownership only for themselves. Pit Crew never.
importRouter.post("/jobs/:id/owner", requireAuth, requireEntitlement("grow.import.execute"), async (req, res) => {
  try {
    const user = req.authedUser!;
    const importJobId = Number(req.params.id);
    const job = await loadJobOr404(importJobId, user.brokerageId);
    if (!job) {
      res.status(404).json({ error: "Import job not found." });
      return;
    }
    const ownerUserId = Number(req.body?.ownerUserId);
    const authorityRef = typeof req.body?.authorityRef === "string" ? req.body.authorityRef.trim() : "";
    const allowed = user.role === "Brokerage Administrator" || (user.role === "Agent" && ownerUserId === user.id);
    if (!allowed) {
      res.status(403).json({ error: "Only an administrator, or the agent taking ownership, can record the import owner.", code: "IMPORT_OWNER_ASSIGN_FORBIDDEN" });
      return;
    }
    if (!Number.isInteger(ownerUserId) || authorityRef.length < 3 || authorityRef.length > 200) {
      res.status(400).json({ error: "ownerUserId and an authority reference (3-200 characters) are required.", code: "IMPORT_OWNER_INVALID" });
      return;
    }
    const problem = await ownershipProblem(ownerUserId, user.brokerageId);
    if (problem) {
      res.status(422).json({ error: "That user cannot own imported contacts.", code: "IMPORT_OWNER_INVALID", reason: problem });
      return;
    }
    await logAudit(
      { brokerageId: user.brokerageId, userId: user.id, action: "import_job_owner_recorded", recordType: "ImportJob", recordId: String(importJobId), providerReference: `owner:${ownerUserId}`, updatedValue: JSON.stringify({ owner: ownerUserId, authorityRef, performedBy: user.id, source: "review" }) },
      { strict: true },
    );
    res.status(201).json({ importJobId, owner: ownerUserId });
  } catch (err) {
    handleError(res, err);
  }
});

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

    const ownerId = await jobOwnerId(job, brokerageId);
    const problem = await ownershipProblem(ownerId, brokerageId);
    if (problem) {
      await logAudit({ brokerageId, userId: req.authedUser!.id, action: "import_held_for_review", recordType: "ImportJob", recordId: String(importJobId), updatedValue: JSON.stringify({ reason: problem, recordedOwner: ownerId }) });
      res.status(409).json({ error: "This import is held for review: its contact owner cannot be established. An administrator or the owning agent must record the owner first.", code: "IMPORT_HELD_FOR_REVIEW", reason: problem });
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
      agentId: ownerId,
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
    const ownersRecorded = await recordImportedOwners(req, importJobId, brokerageId, ownerId);
    await logAudit({ brokerageId, userId: req.authedUser!.id, action: "import_owner_assigned", recordType: "ImportJob", recordId: String(importJobId), providerReference: `owner:${ownerId}`, updatedValue: JSON.stringify({ owner: ownerId, contactsAssigned: ownersRecorded, performedBy: req.authedUser!.id, authorityRef: req.actingFor?.authorityRef ?? null }) });
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
