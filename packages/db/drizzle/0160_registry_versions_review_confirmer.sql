ALTER TABLE "registry_versions" DROP CONSTRAINT "registry_versions_review";--> statement-breakpoint
ALTER TABLE "registry_versions" ADD CONSTRAINT "registry_versions_review" CHECK ("registry_versions"."reviewed_by" IS NULL OR "registry_versions"."approved_at" IS NULL
        OR ("registry_versions"."reviewed_by" = "registry_versions"."submitted_by"
          OR COALESCE("registry_versions"."reviewed_by"::text = "registry_versions"."provenance" #>> '{confirmedBy,userId}', false))
          = "registry_versions"."self_approved");