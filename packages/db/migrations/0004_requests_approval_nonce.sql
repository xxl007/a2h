ALTER TABLE "requests" ADD COLUMN "approval_nonce" varchar(32);--> statement-breakpoint
CREATE UNIQUE INDEX "requests_approval_nonce_unique" ON "requests" USING btree ("approval_nonce") WHERE "requests"."approval_nonce" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_approval_nonce_format" CHECK ("requests"."approval_nonce" ~ '^[0-9a-f]{32}$');