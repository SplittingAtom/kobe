CREATE TYPE "public"."connector_auth_kind" AS ENUM('oauth', 'api_key', 'none');--> statement-breakpoint
CREATE TYPE "public"."connector_exposure" AS ENUM('read_only', 'all', 'custom');--> statement-breakpoint
CREATE TYPE "public"."connector_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"auth_kind" "connector_auth_kind" DEFAULT 'none' NOT NULL,
	"status" "connector_status" DEFAULT 'active' NOT NULL,
	"tools_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connectors_name" CHECK (char_length("connectors"."name") <= 64 AND "connectors"."name" ~ '^[a-z0-9]+([-_][a-z0-9]+)*$'),
	CONSTRAINT "connectors_url" CHECK (char_length("connectors"."url") <= 2048 AND "connectors"."url" ~ '^https?://[^[:space:]]+$'),
	CONSTRAINT "connectors_tools_snapshot" CHECK (jsonb_typeof("connectors"."tools_snapshot") = 'array'),
	CONSTRAINT "connectors_tools_hash" CHECK ("connectors"."tools_hash" IS NULL OR "connectors"."tools_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "team_connectors" (
	"team_id" uuid NOT NULL,
	"connector_id" uuid NOT NULL,
	"exposure" "connector_exposure" DEFAULT 'read_only' NOT NULL,
	"enabled_tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled_by" uuid NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_connectors_team_id_connector_id_pk" PRIMARY KEY("team_id","connector_id"),
	CONSTRAINT "team_connectors_enabled_tools" CHECK (cardinality("team_connectors"."enabled_tools") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "team_connectors" ADD CONSTRAINT "team_connectors_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_connectors" ADD CONSTRAINT "team_connectors_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_connectors" ADD CONSTRAINT "team_connectors_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connectors_name_key" ON "connectors" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "connectors_server_segment_key" ON "connectors" USING btree (replace("name", '-', '_'));