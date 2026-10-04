CREATE TYPE "public"."model_provider_kind" AS ENUM('openai', 'anthropic', 'gemini', 'ollama', 'openai_compatible');--> statement-breakpoint
CREATE TABLE "model_catalog" (
	"alias" text PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"label" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_catalog_alias" CHECK ("model_catalog"."alias" ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'),
	CONSTRAINT "model_catalog_model" CHECK ("model_catalog"."model" ~ '^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$'),
	CONSTRAINT "model_catalog_label" CHECK ("model_catalog"."label" IS NULL OR char_length("model_catalog"."label") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "model_gateway_keys" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"vk_id" text NOT NULL,
	"vk_value_enc" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_gateway_keys_team_id_user_id_pk" PRIMARY KEY("team_id","user_id"),
	CONSTRAINT "model_gateway_keys_vk_id" CHECK (char_length("model_gateway_keys"."vk_id") BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE TABLE "model_gateway_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"desired_version" bigint DEFAULT 1 NOT NULL,
	"synced_version" bigint DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "model_gateway_state_singleton" CHECK ("model_gateway_state"."id" = 1),
	CONSTRAINT "model_gateway_state_error" CHECK ("model_gateway_state"."last_error" IS NULL OR "model_gateway_state"."last_error" ~ '^[a-z0-9_]{1,64}$')
);
--> statement-breakpoint
CREATE TABLE "model_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" "model_provider_kind" NOT NULL,
	"name" text NOT NULL,
	"base_url" text,
	"allow_private_network" boolean DEFAULT false NOT NULL,
	"api_key_enc" text,
	"key_revision" integer DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_providers_id" CHECK ("model_providers"."id" ~ '^[a-z][a-z0-9-]{0,30}[a-z0-9]$'),
	CONSTRAINT "model_providers_vendor_id" CHECK ("model_providers"."kind" = 'openai_compatible' OR "model_providers"."id" = "model_providers"."kind"::text),
	CONSTRAINT "model_providers_base_url" CHECK (CASE WHEN "model_providers"."base_url" IS NULL THEN "model_providers"."kind" NOT IN ('ollama', 'openai_compatible')
        ELSE "model_providers"."base_url" ~ '^https?://' AND char_length("model_providers"."base_url") <= 2048 END),
	CONSTRAINT "model_providers_key" CHECK ("model_providers"."kind" IN ('ollama', 'openai_compatible') OR "model_providers"."api_key_enc" IS NOT NULL),
	CONSTRAINT "model_providers_name" CHECK (char_length("model_providers"."name") BETWEEN 1 AND 100),
	CONSTRAINT "model_providers_key_revision" CHECK ("model_providers"."key_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "team_models" (
	"team_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"enabled_by" uuid NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_models_team_id_alias_pk" PRIMARY KEY("team_id","alias")
);
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_keys" ADD CONSTRAINT "model_gateway_keys_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_gateway_keys" ADD CONSTRAINT "model_gateway_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_providers" ADD CONSTRAINT "model_providers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_models" ADD CONSTRAINT "team_models_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_models" ADD CONSTRAINT "team_models_alias_model_catalog_alias_fk" FOREIGN KEY ("alias") REFERENCES "public"."model_catalog"("alias") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_models" ADD CONSTRAINT "team_models_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_models_default_idx" ON "team_models" USING btree ("team_id") WHERE "team_models"."is_default";