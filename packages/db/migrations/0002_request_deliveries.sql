CREATE TABLE "request_deliveries" (
	"request_id" varchar(16) PRIMARY KEY NOT NULL,
	"participant_id" varchar(64) NOT NULL,
	"outcome" varchar(9) NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_deliveries_outcome_known" CHECK ("request_deliveries"."outcome" IN ('delivered', 'blocked'))
);
--> statement-breakpoint
ALTER TABLE "request_deliveries" ADD CONSTRAINT "request_deliveries_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_deliveries" ADD CONSTRAINT "request_deliveries_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_deliveries_participant_at_idx" ON "request_deliveries" USING btree ("participant_id","at");