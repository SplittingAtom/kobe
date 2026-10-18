CREATE TABLE "skill_hash_checks" (
	"stored_hash" text PRIMARY KEY NOT NULL,
	"runtime_hash" text,
	"problems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_hash_checks_stored_hash" CHECK ("skill_hash_checks"."stored_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skill_hash_checks_runtime_hash" CHECK ("skill_hash_checks"."runtime_hash" IS NULL OR "skill_hash_checks"."runtime_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skill_hash_checks_outcome" CHECK (jsonb_typeof("skill_hash_checks"."problems") = 'array' AND ("skill_hash_checks"."runtime_hash" IS NULL) = (jsonb_array_length("skill_hash_checks"."problems") > 0))
);
--> statement-breakpoint
ALTER TABLE "personal_skill_versions" ADD COLUMN "package_storage_key" text;--> statement-breakpoint
ALTER TABLE "team_skill_versions" ADD COLUMN "package_storage_key" text;--> statement-breakpoint
CREATE INDEX "skill_hash_checks_runtime_idx" ON "skill_hash_checks" USING btree ("runtime_hash");--> statement-breakpoint
ALTER TABLE "personal_skill_versions" ADD CONSTRAINT "personal_skill_versions_package_storage" CHECK ("personal_skill_versions"."package_storage_key" IS NULL OR "personal_skill_versions"."package_hash" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "team_skill_versions" ADD CONSTRAINT "team_skill_versions_package_storage" CHECK ("team_skill_versions"."package_storage_key" IS NULL OR "team_skill_versions"."package_hash" IS NOT NULL);