import rateLimit from "express-rate-limit";

/**
 * Same NODE_ENV==="test" carve-out already used elsewhere in this codebase
 * (lib/financial/bootstrap.ts and lib/exceptions/bootstrap.ts skip their
 * periodic schedulers the same way, and apps/api/.env sets NODE_ENV=test
 * for the real HTTP-level test suite). The limiters below stay fully real
 * in every environment — nothing is disabled here — they just get a much
 * higher ceiling under test so the suite's many rapid, legitimate
 * same-process requests (routes/__tests__/*.test.ts spins up a real
 * listening server per file and drives it with dozens of fetch() calls)
 * never collide with the production-sized budget.
 */
const isTestEnvironment = process.env.NODE_ENV === "test";

const ONE_MINUTE_MS = 60_000;

/**
 * Generous global throttle applied to the whole API (see app.ts) — 300
 * requests/minute per IP. Not a substitute for real abuse detection; it's
 * the first line of defence against runaway retries, a misbehaving
 * integration, or basic scripted abuse hitting an API that previously had
 * zero throttling anywhere.
 */
export const globalRateLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: isTestEnvironment ? 5_000 : 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

/**
 * Stricter limiter for the authentication surface — routes/index.ts mounts
 * this ahead of authRouter, on /auth. 20 requests/minute per IP. Sign-in
 * and session endpoints are the highest-value target for credential
 * stuffing / brute-force-style abuse, so they get a tighter budget than
 * the rest of the API.
 */
export const authRateLimiter = rateLimit({
  windowMs: ONE_MINUTE_MS,
  limit: isTestEnvironment ? 1_000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication requests, please try again later." },
});
