CREATE TABLE "skill_rescan_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_set" integer NOT NULL,
	"rule_set_version" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"scanned" integer DEFAULT 0 NOT NULL,
	"changed" integer DEFAULT 0 NOT NULL,
	"suspended" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"suspensions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "skill_rescan_runs_rule_set_unique" UNIQUE("rule_set"),
	CONSTRAINT "skill_rescan_runs_status" CHECK ("skill_rescan_runs"."status" IN ('running', 'done', 'failed')),
	CONSTRAINT "skill_rescan_runs_counts" CHECK ("skill_rescan_runs"."scanned" >= 0 AND "skill_rescan_runs"."changed" >= 0 AND "skill_rescan_runs"."suspended" >= 0 AND "skill_rescan_runs"."failed" >= 0),
	CONSTRAINT "skill_rescan_runs_suspensions" CHECK (jsonb_typeof("skill_rescan_runs"."suspensions") = 'array' AND jsonb_array_length("skill_rescan_runs"."suspensions") <= 100),
	CONSTRAINT "skill_rescan_runs_finished" CHECK (("skill_rescan_runs"."status" = 'running') = ("skill_rescan_runs"."finished_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "personal_skill_scans" ADD COLUMN "rule_set" integer;--> statement-breakpoint
ALTER TABLE "personal_skill_scans" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "personal_skill_scans" ADD COLUMN "suspension_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_skill_reviews" ADD COLUMN "rule_set" integer;--> statement-breakpoint
ALTER TABLE "team_skill_reviews" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "team_skill_reviews" ADD COLUMN "suspension_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registry_versions" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "personal_skill_scans_rule_set_idx" ON "personal_skill_scans" USING btree ("rule_set");--> statement-breakpoint
CREATE INDEX "team_skill_reviews_rule_set_idx" ON "team_skill_reviews" USING btree ("team_id","rule_set");