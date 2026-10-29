CREATE TABLE "site_branding_assets" (
	"kind" text PRIMARY KEY NOT NULL,
	"bytes" "bytea" NOT NULL,
	"content_type" text NOT NULL,
	"sha256" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer,
	"height" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "site_branding_assets_kind" CHECK ("site_branding_assets"."kind" IN ('logo', 'logo_dark', 'favicon')),
	CONSTRAINT "site_branding_assets_sha256" CHECK ("site_branding_assets"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "site_branding_assets_size" CHECK ("site_branding_assets"."byte_size" = octet_length("site_branding_assets"."bytes") AND "site_branding_assets"."byte_size" > 0 AND "site_branding_assets"."byte_size" <= CASE WHEN "site_branding_assets"."kind" = 'favicon' THEN 262144 ELSE 524288 END),
	CONSTRAINT "site_branding_assets_dimensions" CHECK (("site_branding_assets"."width" IS NULL OR "site_branding_assets"."width" BETWEEN 1 AND 4096) AND ("site_branding_assets"."height" IS NULL OR "site_branding_assets"."height" BETWEEN 1 AND 4096)),
	CONSTRAINT "site_branding_assets_content_type" CHECK (CASE WHEN "site_branding_assets"."kind" = 'favicon' THEN "site_branding_assets"."content_type" IN ('image/png', 'image/svg+xml', 'image/x-icon') ELSE "site_branding_assets"."content_type" IN ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml') END)
);
--> statement-breakpoint
ALTER TABLE "site_branding_assets" ADD CONSTRAINT "site_branding_assets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;