-- Decision 8 (m1-hosted-connector task 5.7) applies to every principal created
-- by consent before it: such a principal has a Better Auth user (sign-in needs
-- an owner-listed address and control of its mailbox), so it is verified by the
-- owner's allow-list, as ensurePrincipal records a new one since 0007.
-- Rows without a user (the seeded fallback principal dev-principal-<stage>,
-- already verified) and rows already verified or carrying a method are left as
-- they are. A migration is not a consent: the spec's "Second consent leaves
-- verification as stored" still holds, ensurePrincipal never changes a row.
-- Data only, forward-only. Hand-written (drizzle-kit generate --custom).
UPDATE principals SET verified = true, verification_method = 'owner_allowlist'
WHERE verified = false AND verification_method IS NULL AND principal_id IN (SELECT id FROM "user");
