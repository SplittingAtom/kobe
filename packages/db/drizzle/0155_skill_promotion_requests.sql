CREATE TABLE "skill_promotion_requests" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"skill_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"semver" text NOT NULL,
	"package_hash" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	"registry_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_promotion_requests_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "skill_promotion_requests_state" CHECK ("skill_promotion_requests"."state" IN ('pending', 'confirmed', 'declined', 'cancelled')),
	CONSTRAINT "skill_promotion_requests_decision" CHECK (("skill_promotion_requests"."state" = 'pending') = ("skill_promotion_requests"."decided_at" IS NULL)
        AND ("skill_promotion_requests"."decided_at" IS NULL) = ("skill_promotion_requests"."decided_by" IS NULL)
        AND ("skill_promotion_requests"."state" = 'confirmed') = ("skill_promotion_requests"."registry_version_id" IS NOT NULL)),
	CONSTRAINT "skill_promotion_requests_note" CHECK ("skill_promotion_requests"."note" IS NULL OR char_length("skill_promotion_requests"."note") BETWEEN 1 AND 1000),
	CONSTRAINT "skill_promotion_requests_version" CHECK ("skill_promotion_requests"."version" > 0),
	CONSTRAINT "skill_promotion_requests_hash" CHECK ("skill_promotion_requests"."package_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "team_skill_settings" ADD COLUMN "builders_may_promote" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_promotion_requests" ADD CONSTRAINT "skill_promotion_requests_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_promotion_requests" ADD CONSTRAINT "skill_promotion_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_promotion_requests" ADD CONSTRAINT "skill_promotion_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_promotion_requests" ADD CONSTRAINT "skill_promotion_requests_registry_version_id_registry_versions_id_fk" FOREIGN KEY ("registry_version_id") REFERENCES "public"."registry_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_promotion_requests" ADD CONSTRAINT "skill_promotion_requests_skill_fk" FOREIGN KEY ("team_id","skill_id") REFERENCES "public"."team_skills"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_promotion_requests_queue_idx" ON "skill_promotion_requests" USING btree ("team_id","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_promotion_requests_open_uq" ON "skill_promotion_requests" USING btree ("team_id","skill_id","version") WHERE "skill_promotion_requests"."state" = 'pending';