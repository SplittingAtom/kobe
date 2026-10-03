CREATE TYPE "public"."legal_hold_status" AS ENUM('pending', 'active', 'denied', 'withdrawn', 'released');--> statement-breakpoint
CREATE TABLE "legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"user_id" uuid,
	"reason" text NOT NULL,
	"status" "legal_hold_status" DEFAULT 'pending' NOT NULL,
	"placed_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"self_approved" boolean DEFAULT false NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"release_requested_by" uuid,
	"release_requested_at" timestamp with time zone,
	"release_reason" text,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"release_self_approved" boolean DEFAULT false NOT NULL,
	CONSTRAINT "legal_holds_reason" CHECK (char_length(btrim("legal_holds"."reason")) BETWEEN 1 AND 2000),
	CONSTRAINT "legal_holds_release_reason" CHECK ("legal_holds"."release_reason" IS NULL OR char_length(btrim("legal_holds"."release_reason")) BETWEEN 1 AND 2000),
	CONSTRAINT "legal_holds_subject_not_requester" CHECK ("legal_holds"."user_id" IS DISTINCT FROM "legal_holds"."placed_by"),
	CONSTRAINT "legal_holds_two_person" CHECK ("legal_holds"."approved_by" IS NULL OR ("legal_holds"."approved_by" = "legal_holds"."placed_by") = "legal_holds"."self_approved"),
	CONSTRAINT "legal_holds_release_two_person" CHECK ("legal_holds"."released_by" IS NULL OR ("legal_holds"."released_by" = "legal_holds"."release_requested_by") = "legal_holds"."release_self_approved"),
	CONSTRAINT "legal_holds_active_shape" CHECK ("legal_holds"."status" NOT IN ('active', 'released') OR ("legal_holds"."approved_by" IS NOT NULL AND "legal_holds"."approved_at" IS NOT NULL)),
	CONSTRAINT "legal_holds_released_shape" CHECK (("legal_holds"."status" = 'released') = ("legal_holds"."released_by" IS NOT NULL AND "legal_holds"."released_at" IS NOT NULL)),
	CONSTRAINT "legal_holds_release_request_shape" CHECK (("legal_holds"."release_requested_by" IS NULL) = ("legal_holds"."release_requested_at" IS NULL) AND ("legal_holds"."release_requested_by" IS NULL) = ("legal_holds"."release_reason" IS NULL) AND ("legal_holds"."release_requested_by" IS NULL OR "legal_holds"."status" IN ('active', 'released')))
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "hash_version" smallint;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "pii_salt" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "pii_commitment" text;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_placed_by_users_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_release_requested_by_users_id_fk" FOREIGN KEY ("release_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legal_holds_team_idx" ON "legal_holds" USING btree ("team_id","requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "legal_holds_active_idx" ON "legal_holds" USING btree ("team_id","user_id") WHERE "legal_holds"."status" = 'active';--> statement-breakpoint
CREATE INDEX "legal_holds_active_user_idx" ON "legal_holds" USING btree ("user_id") WHERE "legal_holds"."status" = 'active' AND "legal_holds"."user_id" IS NOT NULL;