CREATE TABLE "sso_link_expectations" (
	"provider_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sso_link_expectations_provider_id_user_id_pk" PRIMARY KEY("provider_id","user_id"),
	CONSTRAINT "sso_link_expectations_expiry" CHECK ("sso_link_expectations"."expires_at" > "sso_link_expectations"."created_at")
);
--> statement-breakpoint
ALTER TABLE "sso_link_expectations" ADD CONSTRAINT "sso_link_expectations_provider_id_sso_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sso_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_link_expectations" ADD CONSTRAINT "sso_link_expectations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_link_expectations" ADD CONSTRAINT "sso_link_expectations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sso_link_expectations_user_idx" ON "sso_link_expectations" USING btree ("user_id");