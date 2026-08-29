// Raw request body bytes, captured by express.json()'s `verify` hook in
// app.ts. Needed for webhook signature verification (Phase 4) — HMAC
// signatures are computed over the exact bytes the provider sent, and
// re-serialising the parsed JSON body can differ from that byte-for-byte.
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

export {};
