import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "@aee/db";

export const healthRouter = Router();

// Actually verifies the database connection works, rather than returning a
// static 200 no matter what's underneath — a prior audit flagged this as
// returning "ok" even when the DB is unreachable. The healthy-case response
// shape is kept byte-for-byte identical ({ status: "ok", service: ... })
// for backward compatibility with anything already depending on it; a
// failed check returns 503 with a "degraded" status instead of throwing an
// unhandled error.
healthRouter.get("/", async (_req, res) => {
  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    console.error("GET /api/health: database check failed", err);
    res.status(503).json({ status: "degraded", service: "agent-engine-easy-api", database: "unreachable" });
    return;
  }
  res.json({ status: "ok", service: "agent-engine-easy-api" });
});
