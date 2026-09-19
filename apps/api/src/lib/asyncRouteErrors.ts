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
 */
import express from "express";

type Next = (err?: unknown) => void;
type LayerLike = {
  handle: (...args: unknown[]) => unknown;
  handle_request: (req: unknown, res: unknown, next: Next) => unknown;
  handle_error: (err: unknown, req: unknown, res: unknown, next: Next) => unknown;
};

const INSTALLED = Symbol.for("aee.asyncRouteErrorForwarding.installed");

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
