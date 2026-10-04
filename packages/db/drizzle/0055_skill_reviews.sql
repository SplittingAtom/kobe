CREATE TYPE "public"."skill_review_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TABLE "install_skill_scans" (
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"flagged" boolean NOT NULL,
	"findings" jsonb NOT NULL,
	"scripts" jsonb NOT NULL,
	"skipped" jsonb NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "install_skill_scans_skill_id_version_pk" PRIMARY KEY("skill_id","version")
);
--> statement-breakpoint
CREATE TABLE "team_skill_reviews" (
	"team_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"scope" text NOT NULL,
	"slug" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" "skill_review_status" DEFAULT 'pending' NOT NULL,
	"unscanned" boolean DEFAULT false NOT NULL,
	"flagged" boolean NOT NULL,
	"findings" jsonb NOT NULL,
	"scripts" jsonb NOT NULL,
	"skipped" jsonb NOT NULL,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	CONSTRAINT "team_skill_reviews_team_id_skill_id_version_pk" PRIMARY KEY("team_id","skill_id","version"),
	CONSTRAINT "team_skill_reviews_scope" CHECK ("team_skill_reviews"."scope" IN ('team', 'personal')),
	CONSTRAINT "team_skill_reviews_decided" CHECK (("team_skill_reviews"."status" = 'pending') = ("team_skill_reviews"."reviewed_by" IS NULL AND "team_skill_reviews"."reviewed_at" IS NULL)),
	CONSTRAINT "team_skill_reviews_json" CHECK (jsonb_typeof("team_skill_reviews"."findings") = 'array' AND jsonb_typeof("team_skill_reviews"."scripts") = 'array' AND jsonb_typeof("team_skill_reviews"."skipped") = 'array'),
	CONSTRAINT "team_skill_reviews_note" CHECK (char_length("team_skill_reviews"."review_note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "team_skill_settings" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"personal_skills_disabled" boolean DEFAULT false NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "install_skill_scans" ADD CONSTRAINT "install_skill_scans_version_fk" FOREIGN KEY ("skill_id","version") REFERENCES "public"."install_skill_versions"("skill_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_reviews" ADD CONSTRAINT "team_skill_reviews_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_reviews" ADD CONSTRAINT "team_skill_reviews_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_settings" ADD CONSTRAINT "team_skill_settings_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_skill_settings" ADD CONSTRAINT "team_skill_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_skill_reviews_queue_idx" ON "team_skill_reviews" USING btree ("team_id","status","flagged" DESC NULLS LAST,"scanned_at");