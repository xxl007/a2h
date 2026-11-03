ALTER TABLE "request_events" DROP CONSTRAINT "request_events_legal";--> statement-breakpoint
ALTER TABLE "requests" DROP CONSTRAINT "requests_approval_nonce_format";--> statement-breakpoint
DROP INDEX "requests_approval_nonce_unique";--> statement-breakpoint
ALTER TABLE "requests" DROP COLUMN "approval_nonce";--> statement-breakpoint
-- NOT VALID (hand-edited, drizzle-kit cannot express it): m1 rows created straight into
-- `sent` keep their history; every new event is checked. m2-approval-page task 3.1.
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_legal" CHECK (("request_events"."from_status" IS NULL AND "request_events"."to_status" = 'awaiting_approval' AND "request_events"."actor" = 'principal')
        OR ("request_events"."from_status" IS NOT NULL AND ("request_events"."from_status", "request_events"."to_status", "request_events"."actor") IN (('awaiting_approval', 'sent', 'principal'), ('awaiting_approval', 'not_sent', 'principal'), ('awaiting_approval', 'not_sent', 'platform'), ('sent', 'accepted', 'participant'), ('sent', 'declined', 'participant'), ('sent', 'cancelled', 'principal'), ('sent', 'expired', 'platform'), ('accepted', 'answered', 'participant'), ('accepted', 'cancelled', 'principal'), ('accepted', 'expired', 'platform')))) NOT VALID;