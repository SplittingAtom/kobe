CREATE TABLE "team_agent_suspensions" (
	"team_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_scope" text NOT NULL,
	"suspended_by" uuid NOT NULL,
	"suspended_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_agent_suspensions_team_id_agent_id_pk" PRIMARY KEY("team_id","agent_id"),
	CONSTRAINT "team_agent_suspensions_scope" CHECK ("team_agent_suspensions"."agent_scope" IN ('personal', 'gallery'))
);
--> statement-breakpoint
ALTER TABLE "team_agent_suspensions" ADD CONSTRAINT "team_agent_suspensions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_agent_suspensions" ADD CONSTRAINT "team_agent_suspensions_suspended_by_users_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_agent_suspensions_agent_idx" ON "team_agent_suspensions" USING btree ("agent_id");