ALTER TABLE "model_catalog" ADD COLUMN "max_output_tokens" integer;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "context_window" integer;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD COLUMN "reasoning" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_max_output_tokens" CHECK ("model_catalog"."max_output_tokens" IS NULL OR "model_catalog"."max_output_tokens" BETWEEN 256 AND 131072);--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_context_window" CHECK ("model_catalog"."context_window" IS NULL OR "model_catalog"."context_window" BETWEEN 1024 AND 10000000);--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_output_within_context" CHECK ("model_catalog"."max_output_tokens" IS NULL OR "model_catalog"."context_window" IS NULL OR "model_catalog"."max_output_tokens" < "model_catalog"."context_window");