import express from "express";
import cors from "cors";
import { apiRouter } from "./routes/index.js";
import { loadSession } from "./middlewares/auth.js";

export function createApp() {
  const app = express();
  // credentials: true + a reflected origin (rather than "*") is required
  // for the browser to send/accept the session cookie (lib/session.ts) —
  // the frontend always calls with `credentials: "include"` (lib/api.ts).
  app.use(cors({ origin: true, credentials: true }));
  // Captures the exact raw bytes of every request body onto req.rawBody
  // alongside normal JSON parsing — webhook signature verification (Phase
  // 4's AML webhook, and future e-sign/payment webhooks) needs the exact
  // bytes the provider signed, not a re-serialised copy of the parsed body.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as import("express").Request).rawBody = Buffer.from(buf);
      },
    }),
  );
  // Populates req.authedUser from the session cookie ahead of every route
  // (see middlewares/auth.ts) — requireAuth then just checks it's present.
  app.use(loadSession);
  app.use("/api", apiRouter);
  return app;
}
