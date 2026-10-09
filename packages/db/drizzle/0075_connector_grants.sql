CREATE TABLE "connector_grants" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"kind" text DEFAULT 'api_key' NOT NULL,
	"sealed" text NOT NULL,
	"key_id" text NOT NULL,
	"hint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_grants_team_id_user_id_connector_id_pk" PRIMARY KEY("team_id","user_id","connector_id"),
	CONSTRAINT "connector_grants_kind" CHECK ("connector_grants"."kind" IN ('api_key')),
	CONSTRAINT "connector_grants_sealed" CHECK ("connector_grants"."sealed" ~ '^e1\.[A-Za-z0-9_.-]+$' AND char_length("connector_grants"."sealed") <= 16384),
	CONSTRAINT "connector_grants_key_id" CHECK (char_length("connector_grants"."key_id") BETWEEN 1 AND 64),
	CONSTRAINT "connector_grants_hint" CHECK (char_length("connector_grants"."hint") <= 16)
);
--> statement-breakpoint
ALTER TABLE "connector_grants" ADD CONSTRAINT "connector_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_grants" ADD CONSTRAINT "connector_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_grants" ADD CONSTRAINT "connector_grants_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_grants_connector_idx" ON "connector_grants" USING btree ("team_id","connector_id");