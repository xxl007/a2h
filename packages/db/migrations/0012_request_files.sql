CREATE TABLE "request_files" (
	"id" varchar(23) PRIMARY KEY NOT NULL,
	"request_id" varchar(16) NOT NULL,
	"principal_id" varchar(64) NOT NULL,
	"name" varchar(255) NOT NULL,
	"declared_type" varchar(15) NOT NULL,
	"media_type" varchar(15),
	"size_bytes" integer NOT NULL,
	"state" varchar(9) NOT NULL,
	"refused_reason" varchar(13),
	"object_key" varchar(512) NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "request_files_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "request_files_id_format" CHECK ("request_files"."id" ~ '^f[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "request_files_principal_opaque" CHECK ("request_files"."principal_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
	CONSTRAINT "request_files_name_length" CHECK (char_length("request_files"."name") BETWEEN 1 AND 255),
	CONSTRAINT "request_files_declared_type_known" CHECK ("request_files"."declared_type" IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/csv', 'text/markdown')),
	CONSTRAINT "request_files_media_type_known" CHECK ("request_files"."media_type" IN ('application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'text/plain', 'text/csv', 'text/markdown')),
	CONSTRAINT "request_files_size" CHECK ("request_files"."size_bytes" BETWEEN 1 AND 26214400),
	CONSTRAINT "request_files_state_known" CHECK ("request_files"."state" IN ('uploading', 'checking', 'ready', 'refused')),
	CONSTRAINT "request_files_refused_reason_known" CHECK ("request_files"."refused_reason" IN ('type', 'size', 'count', 'malware', 'not_checked', 'upload_failed')),
	CONSTRAINT "request_files_refused_has_reason" CHECK (("request_files"."state" = 'refused') = ("request_files"."refused_reason" IS NOT NULL)),
	CONSTRAINT "request_files_checked_type" CHECK ("request_files"."state" NOT IN ('checking', 'ready') OR "request_files"."media_type" IS NOT NULL),
	CONSTRAINT "request_files_ready_complete" CHECK (("request_files"."state" = 'ready') = ("request_files"."ready_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "blocked_manifests" DROP CONSTRAINT "blocked_manifests_code_known";--> statement-breakpoint
ALTER TABLE "blocked_manifests" ALTER COLUMN "code" SET DATA TYPE varchar(24);--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "attachments_accepted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "rules" ADD COLUMN "attachments_max_total_bytes" integer DEFAULT 52428800 NOT NULL;--> statement-breakpoint
ALTER TABLE "request_files" ADD CONSTRAINT "request_files_request_id_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "request_files_request_live_idx" ON "request_files" USING btree ("request_id") WHERE "request_files"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "blocked_manifests" ADD CONSTRAINT "blocked_manifests_code_known" CHECK ("blocked_manifests"."code" IN ('type_not_accepted', 'bid_below_reserve', 'free_lane_mismatch', 'asker_not_allowed', 'quiet_hours', 'interruption_budget', 'latency_mismatch', 'attachments_not_accepted', 'attachments_over_total'));--> statement-breakpoint
ALTER TABLE "rules" ADD CONSTRAINT "rules_attachments_max_total_bytes" CHECK ("rules"."attachments_max_total_bytes" BETWEEN 0 AND 52428800);--> statement-breakpoint
-- Hand-written (m2-attachments D4, spec "Sent files are fixed"): a request's
-- files change only while it awaits approval. Once it is sent nothing about
-- them changes, whoever asks; once it is not sent, the only change is marking
-- them deleted (the worker's files-delete job, D5).
CREATE FUNCTION a2h_request_files_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rid varchar;
  st varchar;
BEGIN
  IF TG_OP = 'INSERT' THEN rid := NEW.request_id; ELSE rid := OLD.request_id; END IF;
  IF TG_OP = 'UPDATE' AND NEW.request_id IS DISTINCT FROM OLD.request_id THEN
    RAISE EXCEPTION 'request_files of a sent request are fixed: a file never moves to another request' USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT status INTO st FROM requests WHERE id = rid;
  IF st = 'awaiting_approval' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND st = 'not_sent' AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
    AND (NEW.id, NEW.principal_id, NEW.name, NEW.declared_type, NEW.media_type, NEW.size_bytes, NEW.state, NEW.refused_reason, NEW.object_key, NEW.created_at, NEW.ready_at)
      IS NOT DISTINCT FROM (OLD.id, OLD.principal_id, OLD.name, OLD.declared_type, OLD.media_type, OLD.size_bytes, OLD.state, OLD.refused_reason, OLD.object_key, OLD.created_at, OLD.ready_at) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'request_files of a sent request are fixed: % refused on a request in status %', TG_OP, coalesce(st, 'unknown') USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER request_files_fixed BEFORE INSERT OR UPDATE OR DELETE ON request_files FOR EACH ROW EXECUTE FUNCTION a2h_request_files_fixed();
--> statement-breakpoint
CREATE TRIGGER request_files_no_truncate BEFORE TRUNCATE ON request_files FOR EACH STATEMENT EXECUTE FUNCTION a2h_append_only();
