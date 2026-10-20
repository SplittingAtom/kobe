CREATE TABLE "thread_connectors_off" (
	"team_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"turned_off_by" uuid,
	"turned_off_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_connectors_off_team_id_thread_id_connector_id_pk" PRIMARY KEY("team_id","thread_id","connector_id")
);
--> statement-breakpoint
ALTER TABLE "thread_connectors_off" ADD CONSTRAINT "thread_connectors_off_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_connectors_off" ADD CONSTRAINT "thread_connectors_off_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_connectors_off" ADD CONSTRAINT "thread_connectors_off_turned_off_by_users_id_fk" FOREIGN KEY ("turned_off_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_connectors_off" ADD CONSTRAINT "thread_connectors_off_thread_fk" FOREIGN KEY ("team_id","thread_id") REFERENCES "public"."threads"("team_id","id") ON DELETE cascade ON UPDATE no action;