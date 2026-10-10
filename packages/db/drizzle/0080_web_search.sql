CREATE TABLE "team_web_search" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"enabled_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_search_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"provider" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sealed" text NOT NULL,
	"key_id" text NOT NULL,
	"hint" text NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_search_settings_singleton" CHECK ("web_search_settings"."id" = 1),
	CONSTRAINT "web_search_settings_provider" CHECK ("web_search_settings"."provider" IN ('brave', 'tavily', 'exa')),
	CONSTRAINT "web_search_settings_sealed" CHECK ("web_search_settings"."sealed" ~ '^e1\.[A-Za-z0-9_.-]+$' AND char_length("web_search_settings"."sealed") <= 16384),
	CONSTRAINT "web_search_settings_key_id" CHECK (char_length("web_search_settings"."key_id") BETWEEN 1 AND 64),
	CONSTRAINT "web_search_settings_hint" CHECK (char_length("web_search_settings"."hint") <= 16)
);
--> statement-breakpoint
ALTER TABLE "team_web_search" ADD CONSTRAINT "team_web_search_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_web_search" ADD CONSTRAINT "team_web_search_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_search_settings" ADD CONSTRAINT "web_search_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;