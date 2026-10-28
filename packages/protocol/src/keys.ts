// Platform-held signing keys as published for verification (design D4;
// spec protocol/answer-attestation "Old key still verifies", "Revoked key").
// Only the public half is a protocol shape; private keys never leave the
// signing service.
import * as z from "zod";
import { DatetimeSchema, OpaqueIdSchema } from "./primitives.ts";

/** `active` signs; `rotated` no longer signs but still verifies; `revoked` verifies nothing. */
export const SIGNING_KEY_STATUSES = ["active", "rotated", "revoked"] as const;
export const SigningKeyStatusSchema = z.enum(SIGNING_KEY_STATUSES);
export type SigningKeyStatus = z.infer<typeof SigningKeyStatusSchema>;

/** Base64 of a raw 32-byte Ed25519 public key (44 characters, one `=`). */
export const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;

/**
 * A public signing key and its life: `rotated_at` is set once the key is
 * rotated out, `revoked_at` once it is revoked; an active key has neither.
 */
export const PublicSigningKeySchema = z
  .strictObject({
    key_id: OpaqueIdSchema,
    status: SigningKeyStatusSchema,
    public_key: z.string().regex(PUBLIC_KEY_PATTERN, "base64 of a raw 32-byte Ed25519 public key"),
    created_at: DatetimeSchema,
    rotated_at: DatetimeSchema.optional(),
    revoked_at: DatetimeSchema.optional(),
  })
  .superRefine((k, ctx) => {
    if (k.status === "active" && (k.rotated_at !== undefined || k.revoked_at !== undefined))
      ctx.addIssue({ code: "custom", path: ["status"], message: "an active key is neither rotated nor revoked" });
    if (k.status === "rotated" && k.rotated_at === undefined)
      ctx.addIssue({ code: "custom", path: ["rotated_at"], message: "a rotated key says when" });
    if (k.status === "revoked" && k.revoked_at === undefined)
      ctx.addIssue({ code: "custom", path: ["revoked_at"], message: "a revoked key says when" });
  });
export type PublicSigningKey = z.infer<typeof PublicSigningKeySchema>;

/** Keys usable for verification: never a revoked one. */
export function verifiesWith(status: SigningKeyStatus): boolean {
  return status !== "revoked";
}
