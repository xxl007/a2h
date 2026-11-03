ALTER TABLE "request_events" DROP CONSTRAINT "request_events_legal";--> statement-breakpoint
ALTER TABLE "requests" DROP CONSTRAINT "requests_status_known";--> statement-breakpoint
ALTER TABLE "request_events" ALTER COLUMN "from_status" SET DATA TYPE varchar(17);--> statement-breakpoint
ALTER TABLE "request_events" ALTER COLUMN "to_status" SET DATA TYPE varchar(17);--> statement-breakpoint
ALTER TABLE "requests" ALTER COLUMN "status" SET DATA TYPE varchar(17);--> statement-breakpoint
ALTER TABLE "requests" ALTER COLUMN "status" SET DEFAULT 'sent';--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "agent_draft" text;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "approval_token_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "approval_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "requests" ADD COLUMN "not_sent_reason" varchar(8);--> statement-breakpoint
CREATE UNIQUE INDEX "requests_approval_token_hash_unique" ON "requests" USING btree ("approval_token_hash") WHERE "requests"."approval_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "requests_awaiting_approval_expiry_idx" ON "requests" USING btree ("approval_expires_at") WHERE "requests"."status" = 'awaiting_approval';--> statement-breakpoint
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_legal" CHECK (("request_events"."from_status" IS NULL AND "request_events"."to_status" IN ('awaiting_approval', 'sent') AND "request_events"."actor" = 'principal')
        OR ("request_events"."from_status", "request_events"."to_status", "request_events"."actor") IN (('awaiting_approval', 'sent', 'principal'), ('awaiting_approval', 'not_sent', 'principal'), ('awaiting_approval', 'not_sent', 'platform'), ('sent', 'accepted', 'participant'), ('sent', 'declined', 'participant'), ('sent', 'cancelled', 'principal'), ('sent', 'expired', 'platform'), ('accepted', 'answered', 'participant'), ('accepted', 'cancelled', 'principal'), ('accepted', 'expired', 'platform')));--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_approval_token_hash_format" CHECK ("requests"."approval_token_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_awaiting_approval_complete" CHECK ("requests"."status" <> 'awaiting_approval' OR ("requests"."agent_draft" IS NOT NULL AND "requests"."approval_token_hash" IS NOT NULL AND "requests"."approval_expires_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_agent_draft_length" CHECK ("requests"."agent_draft" IS NULL OR (length(btrim("requests"."agent_draft")) > 0 AND char_length("requests"."agent_draft") <= 2000));--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_not_sent_reason" CHECK (("requests"."status" = 'not_sent') = ("requests"."not_sent_reason" IS NOT NULL) AND "requests"."not_sent_reason" IN ('declined', 'expired'));--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_status_known" CHECK ("requests"."status" IN ('awaiting_approval', 'not_sent', 'sent', 'accepted', 'answered', 'declined', 'expired', 'cancelled'));