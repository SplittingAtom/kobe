CREATE TABLE "agent_transfers" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"site_agent_id" uuid NOT NULL,
	"from_user_id" uuid NOT NULL,
	"to_user_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "agent_transfers_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "agent_transfers_state" CHECK ("agent_transfers"."state" IN ('pending', 'accepted', 'declined', 'cancelled')),
	CONSTRAINT "agent_transfers_decided" CHECK (("agent_transfers"."state" = 'pending') = ("agent_transfers"."decided_at" IS NULL)),
	CONSTRAINT "agent_transfers_parties" CHECK ("agent_transfers"."from_user_id" <> "agent_transfers"."to_user_id")
);
--> statement-breakpoint
ALTER TABLE "agent_transfers" ADD CONSTRAINT "agent_transfers_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_transfers" ADD CONSTRAINT "agent_transfers_site_agent_id_site_agents_id_fk" FOREIGN KEY ("site_agent_id") REFERENCES "public"."site_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_transfers" ADD CONSTRAINT "agent_transfers_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_transfers" ADD CONSTRAINT "agent_transfers_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_transfers_one_pending" ON "agent_transfers" USING btree ("site_agent_id") WHERE "agent_transfers"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "agent_transfers_to_idx" ON "agent_transfers" USING btree ("team_id","to_user_id");--> statement-breakpoint
CREATE INDEX "agent_transfers_from_idx" ON "agent_transfers" USING btree ("team_id","from_user_id");