CREATE TABLE "administrator_actions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "administrator_actions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_user_id" text NOT NULL,
	"subject_user_id" text NOT NULL,
	"action" varchar(22) NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "administrator_actions_action_known" CHECK ("administrator_actions"."action" IN ('remove_access', 'restore_access', 'grant_administrator', 'withdraw_administrator'))
);
--> statement-breakpoint
ALTER TABLE "principals" DROP CONSTRAINT "principals_verification_method_known";--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "access_removed_at" timestamp;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "is_administrator" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "last_idp_sign_in_at" timestamp;--> statement-breakpoint
ALTER TABLE "administrator_actions" ADD CONSTRAINT "administrator_actions_actor_user_id_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "administrator_actions" ADD CONSTRAINT "administrator_actions_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "administrator_actions_at_idx" ON "administrator_actions" USING btree ("at");--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_verification_method_known" CHECK ("principals"."verification_method" IS NULL OR "principals"."verification_method" IN ('owner_allowlist', 'organisation_idp'));--> statement-breakpoint
-- Hand-written from here (Drizzle has no trigger API): administrator_actions
-- is append-only, like the tables of 0001_append_only.sql. An action is
-- written once, in the transaction of the change it records, and never
-- edited or removed (spec platform/administration "Action recorded").
CREATE TRIGGER administrator_actions_append_only BEFORE UPDATE OR DELETE ON administrator_actions FOR EACH ROW EXECUTE FUNCTION a2h_append_only();
--> statement-breakpoint
CREATE TRIGGER administrator_actions_no_truncate BEFORE TRUNCATE ON administrator_actions FOR EACH STATEMENT EXECUTE FUNCTION a2h_append_only();
