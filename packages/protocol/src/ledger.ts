// Ledger entry (protocol skill §8, ADR 0002 §11). Represented in M1; no row
// is written before M4.
import * as z from "zod";
import { CurrencySchema, DatetimeSchema, OpaqueIdSchema, RequestIdSchema, SignedMinorAmountSchema } from "./primitives.ts";

export const LedgerKindSchema = z.enum([
  "funding",
  "hold",
  "release",
  "capture",
  "fee",
  "payout",
  "refund",
  "cancellation_fee",
  "referral_credit",
]);
export type LedgerKind = z.infer<typeof LedgerKindSchema>;

/** One append-only ledger row. Balances are derived from these, never stored. */
export const LedgerEntrySchema = z.strictObject({
  id: OpaqueIdSchema,
  kind: LedgerKindSchema,
  account: z.string().min(1).max(128),
  request_id: RequestIdSchema.optional(),
  amount_minor: SignedMinorAmountSchema,
  currency: CurrencySchema,
  stripe_ref: z.string().min(1).max(255).optional(),
  created_at: DatetimeSchema,
  /** `(request_id, kind, sequence)`; a replay with the same key is a no-op. */
  idempotency_key: z.string().min(1).max(128),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;
