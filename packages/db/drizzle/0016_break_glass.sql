CREATE TYPE "public"."break_glass_status" AS ENUM('pending', 'approved', 'denied', 'revoked', 'expired');--> statement-breakpoint
CREATE TABLE "break_glass_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"approver_id" uuid,
	"user_id" uuid,
	"thread_id" uuid,
	"reason" text NOT NULL,
	"legal_hold" boolean DEFAULT false NOT NULL,
	"duration_minutes" integer DEFAULT 60 NOT NULL,
	"status" "break_glass_status" DEFAULT 'pending' NOT NULL,
	"self_approved" boolean DEFAULT false NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_expires_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"starts_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	CONSTRAINT "break_glass_grants_reason" CHECK (char_length(btrim("break_glass_grants"."reason")) BETWEEN 1 AND 2000),
	CONSTRAINT "break_glass_grants_duration" CHECK ("break_glass_grants"."duration_minutes" BETWEEN 1 AND 1440),
	CONSTRAINT "break_glass_grants_one_narrowing" CHECK ("break_glass_grants"."user_id" IS NULL OR "break_glass_grants"."thread_id" IS NULL),
	CONSTRAINT "break_glass_grants_subject_not_requester" CHECK ("break_glass_grants"."user_id" IS DISTINCT FROM "break_glass_grants"."admin_id"),
	CONSTRAINT "break_glass_grants_two_person" CHECK ("break_glass_grants"."approver_id" IS NULL OR ("break_glass_grants"."approver_id" = "break_glass_grants"."admin_id") = "break_glass_grants"."self_approved"),
	CONSTRAINT "break_glass_grants_window" CHECK (("break_glass_grants"."starts_at" IS NULL) = ("break_glass_grants"."expires_at" IS NULL) AND ("break_glass_grants"."starts_at" IS NULL OR ("break_glass_grants"."expires_at" > "break_glass_grants"."starts_at" AND "break_glass_grants"."expires_at" <= "break_glass_grants"."starts_at" + interval '24 hours'))),
	CONSTRAINT "break_glass_grants_approved_shape" CHECK ("break_glass_grants"."status" <> 'approved' OR ("break_glass_grants"."approver_id" IS NOT NULL AND "break_glass_grants"."starts_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_grants" ADD CONSTRAINT "break_glass_grants_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "break_glass_grants_team_idx" ON "break_glass_grants" USING btree ("team_id","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "break_glass_grants_status_idx" ON "break_glass_grants" USING btree ("status","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "break_glass_grants_open_idx" ON "break_glass_grants" USING btree ("expires_at","request_expires_at") WHERE "break_glass_grants"."status" IN ('pending', 'approved');