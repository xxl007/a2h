CREATE TABLE "principal_policies" (
	"principal_id" varchar(64) PRIMARY KEY NOT NULL,
	"currency" char(3) NOT NULL,
	"monthly_budget_minor" integer NOT NULL,
	"per_request_cap_minor" integer NOT NULL,
	"ask_first_above_minor" integer,
	"daily_request_limit" integer NOT NULL,
	"throttled_daily_limit" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principal_policies_currency_format" CHECK ("principal_policies"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "principal_policies_money_non_negative" CHECK ("principal_policies"."monthly_budget_minor" >= 0 AND "principal_policies"."per_request_cap_minor" >= 0 AND ("principal_policies"."ask_first_above_minor" IS NULL OR "principal_policies"."ask_first_above_minor" >= 0)),
	CONSTRAINT "principal_policies_limits_non_negative" CHECK ("principal_policies"."daily_request_limit" >= 0 AND "principal_policies"."throttled_daily_limit" >= 0)
);
--> statement-breakpoint
CREATE TABLE "principals" (
	"principal_id" varchar(64) PRIMARY KEY NOT NULL,
	"identity_mode" varchar(21) DEFAULT 'real_name' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "principals_id_opaque" CHECK ("principals"."principal_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
	CONSTRAINT "principals_identity_mode_known" CHECK ("principals"."identity_mode" IN ('real_name', 'verified_organisation', 'verified_pseudonymous'))
);
--> statement-breakpoint
CREATE TABLE "rate_limit_windows" (
	"principal_id" varchar(64) NOT NULL,
	"window_kind" varchar(6) NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_limit_windows_pkey" PRIMARY KEY("principal_id","window_kind","window_start"),
	CONSTRAINT "rate_limit_windows_kind_known" CHECK ("rate_limit_windows"."window_kind" IN ('minute', 'day')),
	CONSTRAINT "rate_limit_windows_start_aligned" CHECK (date_trunc("rate_limit_windows"."window_kind", "rate_limit_windows"."window_start" AT TIME ZONE 'UTC') = "rate_limit_windows"."window_start" AT TIME ZONE 'UTC'),
	CONSTRAINT "rate_limit_windows_count_non_negative" CHECK ("rate_limit_windows"."count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "principal_policies" ADD CONSTRAINT "principal_policies_principal_id_principals_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "principals"("principal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_limit_windows" ADD CONSTRAINT "rate_limit_windows_principal_id_principals_principal_id_fk" FOREIGN KEY ("principal_id") REFERENCES "principals"("principal_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rate_limit_windows_start_idx" ON "rate_limit_windows" USING btree ("window_start");