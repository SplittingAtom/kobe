CREATE TABLE "run_usage" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"sandbox_id" uuid NOT NULL,
	"run_id" uuid,
	"thread_id" uuid,
	"agent_id" uuid,
	"route" text NOT NULL,
	"model" text NOT NULL,
	"status" smallint NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"usage_source" text NOT NULL,
	"cost_usd" numeric(20, 10),
	"duration_ms" integer NOT NULL,
	"ttfb_ms" integer,
	"aborted" boolean DEFAULT false NOT NULL,
	CONSTRAINT "run_usage_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "run_usage_route" CHECK ("run_usage"."route" IN ('openai', 'anthropic', 'gemini')),
	CONSTRAINT "run_usage_source" CHECK ("run_usage"."usage_source" IN ('reported', 'estimated')),
	CONSTRAINT "run_usage_model" CHECK (char_length("run_usage"."model") BETWEEN 1 AND 240),
	CONSTRAINT "run_usage_status" CHECK ("run_usage"."status" BETWEEN 100 AND 599),
	CONSTRAINT "run_usage_tokens" CHECK ("run_usage"."input_tokens" >= 0 AND "run_usage"."output_tokens" >= 0 AND "run_usage"."cache_read_tokens" >= 0 AND "run_usage"."cache_write_tokens" >= 0),
	CONSTRAINT "run_usage_cost" CHECK ("run_usage"."cost_usd" IS NULL OR "run_usage"."cost_usd" >= 0),
	CONSTRAINT "run_usage_timing" CHECK ("run_usage"."duration_ms" >= 0 AND ("run_usage"."ttfb_ms" IS NULL OR "run_usage"."ttfb_ms" >= 0)),
	CONSTRAINT "run_usage_thread_needs_run" CHECK ("run_usage"."thread_id" IS NULL OR "run_usage"."run_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "input_usd_per_mtok" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "output_usd_per_mtok" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "cache_read_usd_per_mtok" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "cache_write_usd_per_mtok" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "run_usage" ADD CONSTRAINT "run_usage_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_usage" ADD CONSTRAINT "run_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_usage_team_at_idx" ON "run_usage" USING btree ("team_id","at");--> statement-breakpoint
CREATE INDEX "run_usage_user_at_idx" ON "run_usage" USING btree ("team_id","user_id","at");--> statement-breakpoint
CREATE INDEX "run_usage_run_idx" ON "run_usage" USING btree ("team_id","run_id") WHERE "run_usage"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "run_usage_thread_idx" ON "run_usage" USING btree ("team_id","thread_id") WHERE "run_usage"."thread_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_prices" CHECK (("model_catalog"."input_usd_per_mtok" IS NULL OR "model_catalog"."input_usd_per_mtok" BETWEEN 0 AND 10000) AND ("model_catalog"."output_usd_per_mtok" IS NULL OR "model_catalog"."output_usd_per_mtok" BETWEEN 0 AND 10000) AND ("model_catalog"."cache_read_usd_per_mtok" IS NULL OR "model_catalog"."cache_read_usd_per_mtok" BETWEEN 0 AND 10000) AND ("model_catalog"."cache_write_usd_per_mtok" IS NULL OR "model_catalog"."cache_write_usd_per_mtok" BETWEEN 0 AND 10000));--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_price_set" CHECK (("model_catalog"."input_usd_per_mtok" IS NULL) = ("model_catalog"."output_usd_per_mtok" IS NULL)
        AND ("model_catalog"."input_usd_per_mtok" IS NOT NULL OR ("model_catalog"."cache_read_usd_per_mtok" IS NULL AND "model_catalog"."cache_write_usd_per_mtok" IS NULL)));