CREATE TABLE "scim_group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "scim_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scim_groups_provider_external" UNIQUE("provider_id","external_id"),
	CONSTRAINT "scim_groups_external_id" CHECK (char_length("scim_groups"."external_id") BETWEEN 1 AND 256),
	CONSTRAINT "scim_groups_display_name" CHECK (char_length("scim_groups"."display_name") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE TABLE "scim_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "scim_tokens_tokenHash_unique" UNIQUE("token_hash"),
	CONSTRAINT "scim_tokens_token_hash" CHECK ("scim_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "scim_tokens_prefix" CHECK (char_length("scim_tokens"."prefix") BETWEEN 1 AND 32)
);
--> statement-breakpoint
CREATE TABLE "session_sso_contexts" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"mfa_satisfied" boolean NOT NULL,
	"amr" text[] DEFAULT '{}'::text[] NOT NULL,
	"acr" text,
	"auth_time" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_sso_contexts_amr" CHECK (cardinality("session_sso_contexts"."amr") <= 32),
	CONSTRAINT "session_sso_contexts_acr" CHECK ("session_sso_contexts"."acr" IS NULL OR char_length("session_sso_contexts"."acr") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE TABLE "sso_access_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" uuid NOT NULL,
	"claim_value" text NOT NULL,
	"team_id" uuid NOT NULL,
	"role" "team_role" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_access_mappings_key" UNIQUE("provider_id","claim_value","team_id"),
	CONSTRAINT "sso_access_mappings_claim_value" CHECK (char_length("sso_access_mappings"."claim_value") BETWEEN 1 AND 256)
);
--> statement-breakpoint
CREATE TABLE "sso_identities" (
	"provider_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	"linked_via" text NOT NULL,
	"email_at_link" text,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sign_in_at" timestamp with time zone,
	CONSTRAINT "sso_identities_provider_id_subject_pk" PRIMARY KEY("provider_id","subject"),
	CONSTRAINT "sso_identities_provider_user" UNIQUE("provider_id","user_id"),
	CONSTRAINT "sso_identities_subject" CHECK (char_length("sso_identities"."subject") BETWEEN 1 AND 256),
	CONSTRAINT "sso_identities_linked_via" CHECK ("sso_identities"."linked_via" IN ('jit', 'local_proof', 'admin_expected', 'scim')),
	CONSTRAINT "sso_identities_email_at_link" CHECK ("sso_identities"."email_at_link" IS NULL OR char_length("sso_identities"."email_at_link") BETWEEN 1 AND 320)
);
--> statement-breakpoint
CREATE TABLE "sso_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"display_name" text NOT NULL,
	"kind" text NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_sealed" text,
	"client_secret_key_id" text,
	"tenant_id" uuid,
	"subject_claim" text NOT NULL,
	"access_claim" text NOT NULL,
	"mfa_rule" jsonb DEFAULT '{"amr_any":["mfa","hwk","swk","fido","otp","sc"],"acr_any":[],"acrs_any":[]}'::jsonb NOT NULL,
	"allowed_email_domains" text[] DEFAULT '{}'::text[] NOT NULL,
	"jit_provisioning" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"max_session_hours" integer,
	"managed_by" text DEFAULT 'console' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_providers_slug_unique" UNIQUE("slug"),
	CONSTRAINT "sso_providers_slug" CHECK ("sso_providers"."slug" ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
	CONSTRAINT "sso_providers_display_name" CHECK (char_length("sso_providers"."display_name") BETWEEN 1 AND 100),
	CONSTRAINT "sso_providers_kind" CHECK ("sso_providers"."kind" IN ('entra', 'oidc')),
	CONSTRAINT "sso_providers_issuer" CHECK ("sso_providers"."issuer" ~ '^https://[^[:space:]]+$' AND char_length("sso_providers"."issuer") <= 2048),
	CONSTRAINT "sso_providers_client_id" CHECK (char_length("sso_providers"."client_id") BETWEEN 1 AND 256),
	CONSTRAINT "sso_providers_entra_tenant" CHECK ("sso_providers"."kind" <> 'entra' OR "sso_providers"."tenant_id" IS NOT NULL),
	CONSTRAINT "sso_providers_subject_claim" CHECK ("sso_providers"."subject_claim" IN ('oid', 'sub')),
	CONSTRAINT "sso_providers_access_claim" CHECK ("sso_providers"."access_claim" IN ('roles', 'groups')),
	CONSTRAINT "sso_providers_managed_by" CHECK ("sso_providers"."managed_by" IN ('console', 'helm')),
	CONSTRAINT "sso_providers_secret_source" CHECK (("sso_providers"."managed_by" = 'console' AND "sso_providers"."client_secret_sealed" IS NOT NULL AND "sso_providers"."client_secret_key_id" IS NOT NULL)
        OR ("sso_providers"."managed_by" = 'helm' AND "sso_providers"."client_secret_sealed" IS NULL AND "sso_providers"."client_secret_key_id" IS NULL)),
	CONSTRAINT "sso_providers_client_secret_sealed" CHECK ("sso_providers"."client_secret_sealed" IS NULL OR ("sso_providers"."client_secret_sealed" ~ '^e1\.[A-Za-z0-9_.-]+$' AND char_length("sso_providers"."client_secret_sealed") <= 16384)),
	CONSTRAINT "sso_providers_client_secret_key_id" CHECK ("sso_providers"."client_secret_key_id" IS NULL OR char_length("sso_providers"."client_secret_key_id") BETWEEN 1 AND 64),
	CONSTRAINT "sso_providers_mfa_rule" CHECK (jsonb_typeof("sso_providers"."mfa_rule") = 'object' AND octet_length("sso_providers"."mfa_rule"::text) <= 4096),
	CONSTRAINT "sso_providers_allowed_email_domains" CHECK (cardinality("sso_providers"."allowed_email_domains") <= 50),
	CONSTRAINT "sso_providers_max_session_hours" CHECK ("sso_providers"."max_session_hours" IS NULL OR "sso_providers"."max_session_hours" BETWEEN 1 AND 8760)
);
--> statement-breakpoint
ALTER TABLE "team_members" DROP CONSTRAINT "team_members_added_via";--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_group_id_scim_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."scim_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_group_members" ADD CONSTRAINT "scim_group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_groups" ADD CONSTRAINT "scim_groups_provider_id_sso_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sso_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_provider_id_sso_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sso_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scim_tokens" ADD CONSTRAINT "scim_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_sso_contexts" ADD CONSTRAINT "session_sso_contexts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_sso_contexts" ADD CONSTRAINT "session_sso_contexts_provider_id_sso_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sso_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_access_mappings" ADD CONSTRAINT "sso_access_mappings_provider_id_sso_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sso_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_access_mappings" ADD CONSTRAINT "sso_access_mappings_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_access_mappings" ADD CONSTRAINT "sso_access_mappings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_provider_id_sso_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."sso_providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_identities" ADD CONSTRAINT "sso_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_providers" ADD CONSTRAINT "sso_providers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scim_group_members_user_idx" ON "scim_group_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scim_tokens_provider_live_idx" ON "scim_tokens" USING btree ("provider_id") WHERE "scim_tokens"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "session_sso_contexts_provider_idx" ON "session_sso_contexts" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "sso_access_mappings_team_idx" ON "sso_access_mappings" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "sso_identities_user_idx" ON "sso_identities" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_added_via" CHECK ("team_members"."added_via" IS NULL OR "team_members"."added_via" = 'skill_reviewer_grant' OR "team_members"."added_via" ~ '^idp:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');