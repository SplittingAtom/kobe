ALTER TABLE "model_catalog" ADD COLUMN "input_modalities" text[] DEFAULT '{text}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "model_catalog" ADD CONSTRAINT "model_catalog_input_modalities" CHECK ("model_catalog"."input_modalities" <@ ARRAY['text','image']::text[]
        AND "model_catalog"."input_modalities" @> ARRAY['text']::text[]);