-- KOBE-380: the new site_grant value 'memory_steward' is usable only after the transaction that
-- adds it commits. Migrations run in one transaction (a fresh install runs them all at once), so
-- no later statement or migration may use the literal (no policy or CHECK keyed on it): Site
-- steward checks stay in the server (grantsOf).
ALTER TYPE "public"."site_grant" ADD VALUE 'memory_steward';--> statement-breakpoint
CREATE TABLE "memory_stewards" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_stewards_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "memory_stewards" ADD CONSTRAINT "memory_stewards_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_stewards" ADD CONSTRAINT "memory_stewards_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_stewards" ADD CONSTRAINT "memory_stewards_member_fk" FOREIGN KEY ("team_id","user_id") REFERENCES "public"."team_members"("team_id","user_id") ON DELETE cascade ON UPDATE no action;