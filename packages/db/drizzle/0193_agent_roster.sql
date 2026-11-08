CREATE TABLE "site_agent_roster" (
	"site_agent_id" uuid NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"version_rule" text DEFAULT 'latest' NOT NULL,
	"pinned_version" integer,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	"removed_at" timestamp with time zone,
	CONSTRAINT "site_agent_roster_site_agent_id_pk" PRIMARY KEY("site_agent_id"),
	CONSTRAINT "site_agent_roster_state" CHECK ("site_agent_roster"."state" IN ('proposed', 'active', 'removed', 'suspended')),
	CONSTRAINT "site_agent_roster_version_rule" CHECK ("site_agent_roster"."version_rule" IN ('latest', 'pinned')),
	CONSTRAINT "site_agent_roster_pinned_version" CHECK (("site_agent_roster"."version_rule" = 'pinned') = ("site_agent_roster"."pinned_version" IS NOT NULL) AND ("site_agent_roster"."pinned_version" IS NULL OR "site_agent_roster"."pinned_version" > 0)),
	CONSTRAINT "site_agent_roster_decided" CHECK (("site_agent_roster"."decided_by" IS NULL) = ("site_agent_roster"."decided_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "team_agent_roster" (
	"team_id" uuid NOT NULL,
	"site_agent_id" uuid NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"version_rule" text DEFAULT 'latest' NOT NULL,
	"pinned_version" integer,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	"removed_at" timestamp with time zone,
	CONSTRAINT "team_agent_roster_team_id_site_agent_id_pk" PRIMARY KEY("team_id","site_agent_id"),
	CONSTRAINT "team_agent_roster_state" CHECK ("team_agent_roster"."state" IN ('proposed', 'active', 'removed', 'suspended')),
	CONSTRAINT "team_agent_roster_version_rule" CHECK ("team_agent_roster"."version_rule" IN ('latest', 'pinned')),
	CONSTRAINT "team_agent_roster_pinned_version" CHECK (("team_agent_roster"."version_rule" = 'pinned') = ("team_agent_roster"."pinned_version" IS NOT NULL) AND ("team_agent_roster"."pinned_version" IS NULL OR "team_agent_roster"."pinned_version" > 0)),
	CONSTRAINT "team_agent_roster_decided" CHECK (("team_agent_roster"."decided_by" IS NULL) = ("team_agent_roster"."decided_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "schedules" DROP CONSTRAINT "schedules_paused_by";--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_paused_by";--> statement-breakpoint
ALTER TABLE "site_agents" ADD COLUMN "bound_team_id" uuid;--> statement-breakpoint
ALTER TABLE "site_agent_roster" ADD CONSTRAINT "site_agent_roster_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_agent_roster" ADD CONSTRAINT "site_agent_roster_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_agent_roster" ADD CONSTRAINT "team_agent_roster_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_agent_roster" ADD CONSTRAINT "team_agent_roster_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_agent_roster" ADD CONSTRAINT "team_agent_roster_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_agent_roster_agent_idx" ON "team_agent_roster" USING btree ("site_agent_id");--> statement-breakpoint
ALTER TABLE "site_agents" ADD CONSTRAINT "site_agents_bound_team_scope" CHECK ("site_agents"."bound_team_id" IS NULL OR "site_agents"."scope" = 'personal');--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_paused_by" CHECK ("schedules"."paused_by" IN ('team_admin', 'deactivation', 'agent_unavailable'));--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_paused_by" CHECK ("notifications"."paused_by" IN ('team_admin', 'deactivation', 'agent_unavailable'));