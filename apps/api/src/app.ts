import express from "express";
import cors from "cors";
import { apiRouter } from "./routes/index.js";

export function createApp() {
  const app = express();
  app.use(cors());
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
  app.use("/api", apiRouter);
  return app;
}
