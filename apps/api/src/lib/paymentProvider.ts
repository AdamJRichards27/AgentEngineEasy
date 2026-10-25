// The process-wide payment provider (moved out of payments.ts so the refund ledger can share it
// without a circular import). Same createPaymentProvider() as before; behaviour unchanged.
import { createPaymentProvider } from "@aee/integration-payments";

export const paymentProvider = createPaymentProvider();
