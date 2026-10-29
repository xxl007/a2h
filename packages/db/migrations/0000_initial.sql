CREATE TABLE "answers" (
	"request_id" varchar(16) PRIMARY KEY NOT NULL,
	"participant_id" varchar(64) NOT NULL,
	"body" jsonb NOT NULL,
	"confidence" smallint NOT NULL,
	"answered_personally" boolean NOT NULL,
	"signed_at" varchar(40) NOT NULL,
	"key_id" varchar(64) NOT NULL,
	"signature" varchar(88) NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answers_body_object" CHECK (jsonb_typeof("answers"."body") = 'object'),
	CONSTRAINT "answers_confidence_range" CHECK ("answers"."confidence" BETWEEN 1 AND 5),
	CONSTRAINT "answers_answered_personally" CHECK ("answers"."answered_personally" = true),
	CONSTRAINT "answers_signed_at_iso" CHECK ("answers"."signed_at" ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$'),
	CONSTRAINT "answers_signature_format" CHECK ("answers"."signature" ~ '^[A-Za-z0-9+/]{86}==$')
);
--> statement-breakpoint
CREATE TABLE "blocked_manifests" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "blocked_manifests_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"request_id" varchar(16),
	"participant_id" varchar(64) NOT NULL,
	"principal_id" varchar(64) NOT NULL,
	"stage" varchar(8) NOT NULL,
	"code" varchar(19) NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blocked_manifests_request_id_format" CHECK ("blocked_manifests"."request_id" ~ '^A2H-[0-9a-f]{4}$'),
	CONSTRAINT "blocked_manifests_principal_opaque" CHECK ("blocked_manifests"."principal_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
	CONSTRAINT "blocked_manifests_stage_rules" CHECK ("blocked_manifests"."stage" = 'rules'),
	CONSTRAINT "blocked_manifests_code_known" CHECK ("blocked_manifests"."code" IN ('type_not_accepted', 'bid_below_reserve', 'free_lane_mismatch', 'asker_not_allowed', 'quiet_hours', 'interruption_budget', 'latency_mismatch'))
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"handle" varchar(32) NOT NULL,
	"display_label" varchar(80) NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"persona" varchar(9),
	"identity_verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participants_handle_unique" UNIQUE("handle"),
	CONSTRAINT "participants_id_opaque" CHECK ("participants"."id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
	CONSTRAINT "participants_handle_format" CHECK ("participants"."handle" ~ '^[a-z][a-z0-9]*(?:-[a-z0-9]+)*-[0-9a-f]{4}$'),
	CONSTRAINT "participants_label_not_empty" CHECK (length(btrim("participants"."display_label")) > 0),
	CONSTRAINT "participants_simulated_handle" CHECK ("participants"."simulated" = (left("participants"."handle", 4) = 'sim-')),
	CONSTRAINT "participants_simulated_label" CHECK ("participants"."simulated" = (right("participants"."display_label", 11) = '(simulated)')),
	CONSTRAINT "participants_simulated_persona" CHECK ("participants"."simulated" = ("participants"."persona" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"participant_id" varchar(64) PRIMARY KEY NOT NULL,
	"topics" jsonb NOT NULL,
	"rating" numeric(2, 1) NOT NULL,
	"answers_count" integer DEFAULT 0 NOT NULL,
	"disputes_lost" integer DEFAULT 0 NOT NULL,
	"typical_latency_seconds" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_topics_array" CHECK (jsonb_typeof("profiles"."topics") = 'array' AND jsonb_array_length("profiles"."topics") >= 1),
	CONSTRAINT "profiles_rating_range" CHECK ("profiles"."rating" BETWEEN 0 AND 5),
	CONSTRAINT "profiles_counts" CHECK ("profiles"."answers_count" >= 0 AND "profiles"."disputes_lost" >= 0 AND "profiles"."typical_latency_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "request_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "request_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"request_id" varchar(16) NOT NULL,
	"from_status" varchar(9),
	"to_status" varchar(9) NOT NULL,
	"actor" varchar(11) NOT NULL,
	"reason_code" varchar(40),
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "request_events_request_to_unique" UNIQUE("request_id","to_status"),
	CONSTRAINT "request_events_legal" CHECK (("request_events"."from_status" IS NULL AND "request_events"."to_status" = 'sent' AND "request_events"."actor" = 'principal')
        OR ("request_events"."from_status", "request_events"."to_status", "request_events"."actor") IN (('sent', 'accepted', 'participant'), ('sent', 'declined', 'participant'), ('sent', 'cancelled', 'principal'), ('sent', 'expired', 'platform'), ('accepted', 'answered', 'participant'), ('accepted', 'cancelled', 'principal'), ('accepted', 'expired', 'platform'))),
	CONSTRAINT "request_events_reason_code" CHECK ("request_events"."reason_code" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "request_events_reason_on_decline_only" CHECK ("request_events"."reason_code" IS NULL OR "request_events"."to_status" = 'declined')
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" varchar(16) PRIMARY KEY NOT NULL,
	"principal_id" varchar(64) NOT NULL,
	"participant_id" varchar(64) NOT NULL,
	"intent" varchar(13) NOT NULL,
	"audience" varchar(30) NOT NULL,
	"time_shape" varchar(9) NOT NULL,
	"format" varchar(12) NOT NULL,
	"lane" varchar(6) NOT NULL,
	"free_lane" varchar(16),
	"question" text NOT NULL,
	"options" jsonb,
	"scale" jsonb,
	"attachments" jsonb,
	"data_terms" jsonb NOT NULL,
	"bid_minor" integer NOT NULL,
	"cleared_minor" integer,
	"currency" char(3) NOT NULL,
	"status" varchar(9) DEFAULT 'sent' NOT NULL,
	"deliver_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requests_id_format" CHECK ("requests"."id" ~ '^A2H-[0-9a-f]{4}$'),
	CONSTRAINT "requests_principal_opaque" CHECK ("requests"."principal_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
	CONSTRAINT "requests_intent_known" CHECK ("requests"."intent" IN ('observation', 'verification', 'judgment', 'opinion', 'estimate', 'knowledge', 'authorisation', 'action', 'referral')),
	CONSTRAINT "requests_audience_known" CHECK ("requests"."audience" IN ('named_individual', 'role_qualified_first_to_accept', 'panel_sample', 'population_in_place')),
	CONSTRAINT "requests_time_shape_known" CHECK ("requests"."time_shape" IN ('one_shot', 'threaded', 'recurring')),
	CONSTRAINT "requests_format_known" CHECK ("requests"."format" IN ('single_field', 'poll', 'form', 'upload', 'voice')),
	CONSTRAINT "requests_lane_known" CHECK ("requests"."lane" IN ('paid', 'free', 'bounty')),
	CONSTRAINT "requests_free_lane_known" CHECK ("requests"."free_lane" IN ('own_publications', 'facts_about_self')),
	CONSTRAINT "requests_status_known" CHECK ("requests"."status" IN ('sent', 'accepted', 'answered', 'declined', 'expired', 'cancelled')),
	CONSTRAINT "requests_question_length" CHECK (length(btrim("requests"."question")) > 0 AND char_length("requests"."question") <= 2000),
	CONSTRAINT "requests_currency_format" CHECK ("requests"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "requests_lane_coherent" CHECK (CASE WHEN "requests"."lane" = 'free' THEN "requests"."free_lane" IS NOT NULL AND "requests"."bid_minor" = 0
          ELSE "requests"."free_lane" IS NULL AND "requests"."bid_minor" > 0 END),
	CONSTRAINT "requests_cleared" CHECK ("requests"."cleared_minor" IS NULL OR ("requests"."status" = 'answered' AND "requests"."cleared_minor" BETWEEN 0 AND "requests"."bid_minor")),
	CONSTRAINT "requests_data_terms_object" CHECK (jsonb_typeof("requests"."data_terms") = 'object')
);
--> statement-breakpoint
CREATE TABLE "rule_types" (
	"participant_id" varchar(64) NOT NULL,
	"intent" varchar(13) NOT NULL,
	"accepted" boolean NOT NULL,
	"reserve_net_minor" integer NOT NULL,
	"currency" char(3) NOT NULL,
	CONSTRAINT "rule_types_pkey" PRIMARY KEY("participant_id","intent"),
	CONSTRAINT "rule_types_intent_known" CHECK ("rule_types"."intent" IN ('observation', 'verification', 'judgment', 'opinion', 'estimate', 'knowledge', 'authorisation', 'action', 'referral')),
	CONSTRAINT "rule_types_reserve_non_negative" CHECK ("rule_types"."reserve_net_minor" >= 0),
	CONSTRAINT "rule_types_currency_format" CHECK ("rule_types"."currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"participant_id" varchar(64) PRIMARY KEY NOT NULL,
	"who_may_ask" varchar(18) NOT NULL,
	"free_lanes" varchar(32)[] DEFAULT '{}' NOT NULL,
	"quiet_start" varchar(5),
	"quiet_end" varchar(5),
	"quiet_time_zone" varchar(64),
	"max_interruptions_per_day" integer NOT NULL,
	"latency_promise_seconds" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rules_who_may_ask_known" CHECK ("rules"."who_may_ask" IN ('anyone_verified', 'organisations_only')),
	CONSTRAINT "rules_free_lanes_known" CHECK ("rules"."free_lanes" <@ ARRAY['own_publications', 'facts_about_self']::varchar[]),
	CONSTRAINT "rules_quiet_hours_complete" CHECK (("rules"."quiet_start" IS NULL) = ("rules"."quiet_end" IS NULL) AND ("rules"."quiet_start" IS NULL) = ("rules"."quiet_time_zone" IS NULL)),
	CONSTRAINT "rules_quiet_start_format" CHECK ("rules"."quiet_start" ~ '^([01]\d|2[0-3]):[0-5]\d$'),
	CONSTRAINT "rules_quiet_end_format" CHECK ("rules"."quiet_end" ~ '^([01]\d|2[0-3]):[0-5]\d$'),
	CONSTRAINT "rules_counts" CHECK ("rules"."max_interruptions_per_day" >= 0 AND "rules"."latency_promise_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "schema_migrations" (
	"name" varchar(255) PRIMARY KEY NOT NULL,
	"checksum" char(64) NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signing_keys" (
	"key_id" varchar(64) PRIMARY KEY NOT NULL,
	"participant_id" varchar(64),
	"public_key" varchar(44) NOT NULL,
	"status" varchar(7) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "signing_keys_public_key_unique" UNIQUE("public_key"),
	CONSTRAINT "signing_keys_key_id_opaque" CHECK ("signing_keys"."key_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
	CONSTRAINT "signing_keys_public_key_format" CHECK ("signing_keys"."public_key" ~ '^[A-Za-z0-9+/]{43}=$'),
	CONSTRAINT "signing_keys_status_known" CHECK ("signing_keys"."status" IN ('active', 'rotated', 'revoked')),
	CONSTRAINT "signing_keys_status_times" CHECK (CASE "signing_keys"."status"
        WHEN 'active' THEN "signing_keys"."rotated_at" IS NULL AND "signing_keys"."revoked_at" IS NULL
        WHEN 'rotated' THEN "signing_keys"."rotated_at" IS NOT NULL AND "signing_keys"."revoked_at" IS NULL
        WHEN 'revoked' THEN "signing_keys"."revoked_at" IS NOT NULL
      END)
);
--> statement-breakpoint
CREATE TABLE "simulated_personas" (
	"persona" varchar(9) PRIMARY KEY NOT NULL,
	"delay_seconds" integer NOT NULL,
	"decline_reason_code" varchar(40),
	CONSTRAINT "simulated_personas_persona_known" CHECK ("simulated_personas"."persona" IN ('prompt', 'decline', 'slow', 'cant_tell', 'silent')),
	CONSTRAINT "simulated_personas_delay_under_two_minutes" CHECK ("simulated_personas"."delay_seconds" BETWEEN 1 AND 119),
	CONSTRAINT "simulated_personas_reason_code" CHECK ("simulated_personas"."decline_reason_code" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "simulated_personas_reason_on_decline_only" CHECK (("simulated_personas"."persona" = 'decline') = ("simulated_personas"."decline_reason_code" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_key_id_signing_keys_key_id_fk" FOREIGN KEY ("key_id") REFERENCES "signing_keys"("key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blocked_manifests" ADD CONSTRAINT "blocked_manifests_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_persona_simulated_personas_persona_fk" FOREIGN KEY ("persona") REFERENCES "simulated_personas"("persona") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_events" ADD CONSTRAINT "request_events_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rule_types" ADD CONSTRAINT "rule_types_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signing_keys" ADD CONSTRAINT "signing_keys_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blocked_manifests_participant_at_idx" ON "blocked_manifests" USING btree ("participant_id","at");--> statement-breakpoint
CREATE INDEX "requests_principal_created_idx" ON "requests" USING btree ("principal_id","created_at");--> statement-breakpoint
CREATE INDEX "requests_participant_idx" ON "requests" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "requests_open_expiry_idx" ON "requests" USING btree ("expires_at") WHERE "requests"."status" IN ('sent', 'accepted');--> statement-breakpoint
CREATE UNIQUE INDEX "signing_keys_one_active" ON "signing_keys" USING btree ((coalesce("participant_id", ''))) WHERE "signing_keys"."status" = 'active';