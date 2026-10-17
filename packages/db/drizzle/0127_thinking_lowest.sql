ALTER TABLE "model_catalog" DROP CONSTRAINT "model_catalog_thinking_values";--> statement-breakpoint
ALTER TABLE "model_catalog" DROP CONSTRAINT "model_catalog_thinking_shape";--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "thinking_lowest" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_thinking_values" CHECK ("model_catalog"."thinking_control" IN ('none', 'reasoning_effort', 'anthropic_adaptive', 'anthropic_effort', 'anthropic_budget', 'gemini_budget')
        AND ("model_catalog"."thinking_default" IS NULL OR "model_catalog"."thinking_default" IN ('off', 'low', 'medium', 'high')) AND ("model_catalog"."thinking_max" IS NULL OR "model_catalog"."thinking_max" IN ('off', 'low', 'medium', 'high'))
        AND "model_catalog"."thinking_lowest" IN ('off', 'low'));--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_thinking_shape" CHECK (CASE WHEN "model_catalog"."thinking_control" = 'none'
          THEN NOT "model_catalog"."thinking_allowed" AND "model_catalog"."thinking_default" IS NULL AND "model_catalog"."thinking_max" IS NULL
            AND "model_catalog"."thinking_lowest" = 'off'
        WHEN NOT "model_catalog"."reasoning" THEN false
        WHEN "model_catalog"."thinking_control" IN ('anthropic_effort')
          AND "model_catalog"."thinking_lowest" <> 'low' THEN false
        WHEN NOT "model_catalog"."thinking_allowed"
          THEN "model_catalog"."thinking_lowest" = 'off'
            AND "model_catalog"."thinking_default" IS NULL AND "model_catalog"."thinking_max" IS NULL
        ELSE "model_catalog"."thinking_default" IS NOT NULL AND "model_catalog"."thinking_max" IS NOT NULL
          AND "model_catalog"."thinking_max" <> 'off'
          AND array_position(ARRAY['off', 'low', 'medium', 'high']::text[], "model_catalog"."thinking_default") <= array_position(ARRAY['off', 'low', 'medium', 'high']::text[], "model_catalog"."thinking_max")
          AND array_position(ARRAY['off', 'low', 'medium', 'high']::text[], "model_catalog"."thinking_lowest") <= array_position(ARRAY['off', 'low', 'medium', 'high']::text[], "model_catalog"."thinking_default")
        END);