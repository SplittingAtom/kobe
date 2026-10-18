ALTER TABLE "threads" ADD COLUMN "thinking_level" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "thinking_level" text;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "thinking_control" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "thinking_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "thinking_default" text;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "thinking_max" text;--> statement-breakpoint
ALTER TABLE "team_models" ADD COLUMN "thinking_max" text;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_thinking_values" CHECK ("model_catalog"."thinking_control" IN ('none', 'reasoning_effort', 'anthropic_adaptive', 'anthropic_effort', 'anthropic_budget', 'gemini_budget')
        AND ("model_catalog"."thinking_default" IS NULL OR "model_catalog"."thinking_default" IN ('off', 'low', 'medium', 'high')) AND ("model_catalog"."thinking_max" IS NULL OR "model_catalog"."thinking_max" IN ('off', 'low', 'medium', 'high')));--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_thinking_shape" CHECK (CASE WHEN "model_catalog"."thinking_control" = 'none'
          THEN NOT "model_catalog"."thinking_allowed" AND "model_catalog"."thinking_default" IS NULL AND "model_catalog"."thinking_max" IS NULL
        WHEN NOT "model_catalog"."reasoning" THEN false
        WHEN NOT "model_catalog"."thinking_allowed"
          THEN "model_catalog"."thinking_control" NOT IN ('anthropic_effort')
            AND "model_catalog"."thinking_default" IS NULL AND "model_catalog"."thinking_max" IS NULL
        ELSE "model_catalog"."thinking_default" IS NOT NULL AND "model_catalog"."thinking_max" IS NOT NULL
          AND "model_catalog"."thinking_max" <> 'off'
          AND array_position(ARRAY['off', 'low', 'medium', 'high']::text[], "model_catalog"."thinking_default") <= array_position(ARRAY['off', 'low', 'medium', 'high']::text[], "model_catalog"."thinking_max")
          AND ("model_catalog"."thinking_default" <> 'off'
            OR "model_catalog"."thinking_control" NOT IN ('anthropic_effort'))
        END);--> statement-breakpoint
ALTER TABLE "team_models" ADD CONSTRAINT "team_models_thinking_max" CHECK ("team_models"."thinking_max" IS NULL OR "team_models"."thinking_max" IN ('off', 'low', 'medium', 'high'));