/**
 * AE GROW Pilot Readiness WP2a (P0-1) — forward async route/middleware
 * rejections to Express's error pipeline.
 *
 * Express 4 calls every handler synchronously inside a try/catch
 * (router/layer.js handle_request / handle_error) and IGNORES the value the
 * handler returns. An `async` handler that throws (or awaits something that
 * rejects) therefore produces a rejected promise nobody observes: the
 * request hangs, globalErrorHandler (middlewares/errorHandler.ts) never runs,
 * and on Node >= 15 the unhandled rejection terminates the whole process.
 * Many routes deliberately `throw err` for unrecognised errors from inside
 * async handlers, relying on exactly the forwarding Express 4 does not do.
 *
 * This module closes that gap centrally, the same way the well-known
 * `express-async-errors` package does, without adding a dependency: it
 * wraps Express's own Layer.prototype.handle_request / handle_error so that
 * when a handler returns a thenable that rejects, the rejection is passed to
 * `next(err)` — exactly what a synchronous throw already gets. Because it
 * patches the shared prototype, it covers every Router, Route and app-level
 * middleware (including ones created before installation) for every request
 * handled after installation.
 *
 * Installed as an import side effect so it is impossible to build the app
 * without it: middlewares/auth.ts (imported by app.ts and by every route
 * module) and index.ts both import this file. installAsyncRouteErrorForwarding()
 * is idempotent.
 *
 * EXPRESS MAJOR THIS TARGETS: 4 (see TARGETED_EXPRESS_MAJOR / package.json's
 * "express": "^4.x"). This patch re-implements Express 4's OWN internals —
 * Layer.prototype.handle_request / handle_error, their arity checks, their
 * try/catch. Express 5 renamed those methods (handleRequest / handleError)
 * and forwards async rejections natively, so on a major bump this module
 * would find nothing to patch and would silently define two methods nobody
 * calls: a NO-OP, with async rejections quietly back to hanging the request
 * and killing the process. That is exactly the failure class this file
 * exists to prevent, so installation now ASSERTS the shape it expects
 * (assertPatchableLayerPrototype below) and refuses to fail quietly:
 * it throws in production (the import is a boot-time side effect, so the
 * process refuses to start) and logs a loud error elsewhere. On Express 5
 * the correct action is to DELETE this module, not to repair it.
 */
import express from "express";
import { logger } from "@aee/events";
import { isProductionEnvironment } from "./env.js";

type Next = (err?: unknown) => void;
type LayerLike = {
  handle: (...args: unknown[]) => unknown;
  handle_request: (req: unknown, res: unknown, next: Next) => unknown;
  handle_error: (err: unknown, req: unknown, res: unknown, next: Next) => unknown;
};

const INSTALLED = Symbol.for("aee.asyncRouteErrorForwarding.installed");

/** The Express major whose Layer internals the patch below re-implements. */
export const TARGETED_EXPRESS_MAJOR = 4;

/** Thrown when the installed Express is not the one this patch re-implements. */
export class UnsupportedExpressLayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedExpressLayerError";
  }
}

/**
 * Cheap install-time shape check. Express 4's Layer prototype defines both
 * `handle_request` and `handle_error` as functions; any Express where either
 * is missing (notably Express 5, which renamed them) is one where assigning
 * over them patches nothing at all. Exported so it can be tested directly
 * against a synthetic prototype, without installing a different Express.
 */
export function assertPatchableLayerPrototype(proto: Partial<Record<keyof LayerLike, unknown>>): void {
  const missing = (["handle_request", "handle_error"] as const).filter((method) => typeof proto[method] !== "function");
  if (missing.length === 0) return;
  throw new UnsupportedExpressLayerError(
    `asyncRouteErrors: this module re-implements Express ${TARGETED_EXPRESS_MAJOR}'s Layer internals, but the installed ` +
      `Express's Layer prototype has no ${missing.join(" and no ")} — the patch would be a silent no-op and rejected ` +
      `async route/middleware promises would again hang the request and terminate the process. Express 5 renamed these to ` +
      `handleRequest/handleError and forwards async rejections natively: on that version DELETE this module (and its ` +
      `imports in index.ts and middlewares/auth.ts) rather than repairing it.`,
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Obtains the exact Layer constructor this process's `express` uses by
 * building a throwaway router — never a deep `express/lib/...` import, so
 * it can never patch a different copy of Express than the one serving
 * requests.
 */
function resolveLayerPrototype(): LayerLike {
  const probe = express.Router();
  probe.use((_req, _res, next) => next());
  const layer = (probe as unknown as { stack: Array<{ constructor: { prototype: LayerLike } }> }).stack[0];
  if (!layer) throw new Error("asyncRouteErrors: could not locate Express Layer prototype");
  return layer.constructor.prototype;
}

export function installAsyncRouteErrorForwarding(): void {
  const proto = resolveLayerPrototype() as LayerLike & { [INSTALLED]?: boolean };
  if (proto[INSTALLED]) return;

  // Fail loudly, never silently, if this is not the Express this patch was
  // written against — see the module comment.
  try {
    assertPatchableLayerPrototype(proto);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("async_route_error_forwarding_unsupported_express", {
      targetedExpressMajor: TARGETED_EXPRESS_MAJOR,
      error: message,
    });
    // Production: refuse to boot. This module is imported for its side effect
    // at the very top of index.ts, so throwing here stops the process rather
    // than letting it serve traffic with unhandled async rejections.
    if (isProductionEnvironment()) throw err;
    // Elsewhere: the logged error above is the loud warning; do not write
    // methods the running Express will never call.
    return;
  }

  // Re-implements Express 4's own handle_request/handle_error bodies (same
  // arity checks, same synchronous try/catch) and additionally observes the
  // handler's return value.
  proto.handle_request = function handleRequest(this: LayerLike, req: unknown, res: unknown, next: Next) {
    const fn = this.handle;
    if (fn.length > 3) return next();
    try {
      const result = fn(req, res, next);
      if (isThenable(result)) {
        result.then(undefined, (err: unknown) => next(err ?? new Error("Async route handler rejected without a reason")));
      }
    } catch (err) {
      next(err);
    }
    return undefined;
  };

  proto.handle_error = function handleError(this: LayerLike, error: unknown, req: unknown, res: unknown, next: Next) {
    const fn = this.handle;
    if (fn.length !== 4) return next(error);
    try {
      const result = fn(error, req, res, next);
      if (isThenable(result)) {
        result.then(undefined, (err: unknown) => next(err ?? new Error("Async error handler rejected without a reason")));
      }
    } catch (err) {
      next(err);
    }
    return undefined;
  };

  Object.defineProperty(proto, INSTALLED, { value: true, enumerable: false });
}

export function isAsyncRouteErrorForwardingInstalled(): boolean {
  return (resolveLayerPrototype() as { [INSTALLED]?: boolean })[INSTALLED] === true;
}

installAsyncRouteErrorForwarding();
