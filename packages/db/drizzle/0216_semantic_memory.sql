CREATE TABLE "portable_memory_item_versions" (
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"statement" text NOT NULL,
	"statement_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, statement)) STORED NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"lint_override" boolean DEFAULT false NOT NULL,
	"policy_override" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"pass_id" uuid,
	CONSTRAINT "portable_memory_item_versions_item_id_version_pk" PRIMARY KEY("item_id","version"),
	CONSTRAINT "portable_memory_item_versions_version" CHECK ("portable_memory_item_versions"."version" >= 1),
	CONSTRAINT "portable_memory_item_versions_statement" CHECK (char_length(btrim("portable_memory_item_versions"."statement")) >= 1 AND char_length("portable_memory_item_versions"."statement") <= 500),
	CONSTRAINT "portable_memory_item_versions_actor" CHECK ("portable_memory_item_versions"."actor_kind" IN ('user', 'import', 'pass')),
	CONSTRAINT "portable_memory_item_versions_pass" CHECK (("portable_memory_item_versions"."actor_kind" = 'pass') = ("portable_memory_item_versions"."pass_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "portable_memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"superseded_by" uuid,
	"pinned" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portable_memory_items_id_owner_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "portable_memory_items_kind" CHECK ("portable_memory_items"."kind" IN ('preference')),
	CONSTRAINT "portable_memory_items_status" CHECK ("portable_memory_items"."status" IN ('active', 'archived', 'superseded')),
	CONSTRAINT "portable_memory_items_superseded" CHECK (("portable_memory_items"."status" = 'superseded') = ("portable_memory_items"."superseded_by" IS NOT NULL) AND "portable_memory_items"."superseded_by" IS DISTINCT FROM "portable_memory_items"."id"),
	CONSTRAINT "portable_memory_items_tags" CHECK (cardinality("portable_memory_items"."tags") <= 5 AND array_position("portable_memory_items"."tags", NULL) IS NULL AND '' <> ALL("portable_memory_items"."tags") AND char_length(array_to_string("portable_memory_items"."tags", '')) <= 200),
	CONSTRAINT "portable_memory_items_version" CHECK ("portable_memory_items"."current_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "run_memory_items" (
	"team_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_memory_items_team_id_run_id_item_id_pk" PRIMARY KEY("team_id","run_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "semantic_memory_item_versions" (
	"team_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"statement" text NOT NULL,
	"statement_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, statement)) STORED NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"lint_override" boolean DEFAULT false NOT NULL,
	"policy_override" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"pass_id" uuid,
	"source_thread_id" uuid,
	"source_entry_ids" text[],
	"evidence" jsonb,
	CONSTRAINT "semantic_memory_item_versions_team_id_item_id_version_pk" PRIMARY KEY("team_id","item_id","version"),
	CONSTRAINT "semantic_memory_item_versions_version" CHECK ("semantic_memory_item_versions"."version" >= 1),
	CONSTRAINT "semantic_memory_item_versions_statement" CHECK (char_length(btrim("semantic_memory_item_versions"."statement")) >= 1 AND char_length("semantic_memory_item_versions"."statement") <= 500),
	CONSTRAINT "semantic_memory_item_versions_actor" CHECK ("semantic_memory_item_versions"."actor_kind" IN ('user', 'import', 'pass')),
	CONSTRAINT "semantic_memory_item_versions_pass" CHECK (("semantic_memory_item_versions"."actor_kind" = 'pass') = ("semantic_memory_item_versions"."pass_id" IS NOT NULL)),
	CONSTRAINT "semantic_memory_item_versions_sources" CHECK ("semantic_memory_item_versions"."source_entry_ids" IS NULL OR ("semantic_memory_item_versions"."source_thread_id" IS NOT NULL AND cardinality("semantic_memory_item_versions"."source_entry_ids") BETWEEN 1 AND 50)),
	CONSTRAINT "semantic_memory_item_versions_evidence" CHECK ("semantic_memory_item_versions"."evidence" IS NULL OR (jsonb_typeof("semantic_memory_item_versions"."evidence") IN ('array', 'object') AND octet_length("semantic_memory_item_versions"."evidence"::text) <= 16384))
);
--> statement-breakpoint
CREATE TABLE "semantic_memory_items" (
	"team_id" uuid NOT NULL,
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" uuid,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"superseded_by" uuid,
	"pinned" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"as_of" date,
	CONSTRAINT "semantic_memory_items_team_id_id_pk" PRIMARY KEY("team_id","id"),
	CONSTRAINT "semantic_memory_items_scope" CHECK ("semantic_memory_items"."scope" IN ('user', 'team')),
	CONSTRAINT "semantic_memory_items_owner" CHECK (("semantic_memory_items"."scope" = 'user') = ("semantic_memory_items"."owner_user_id" IS NOT NULL)),
	CONSTRAINT "semantic_memory_items_kind" CHECK ("semantic_memory_items"."kind" IN ('preference', 'fact', 'convention', 'definition', 'decision')),
	CONSTRAINT "semantic_memory_items_status" CHECK ("semantic_memory_items"."status" IN ('active', 'archived', 'superseded')),
	CONSTRAINT "semantic_memory_items_superseded" CHECK (("semantic_memory_items"."status" = 'superseded') = ("semantic_memory_items"."superseded_by" IS NOT NULL) AND "semantic_memory_items"."superseded_by" IS DISTINCT FROM "semantic_memory_items"."id"),
	CONSTRAINT "semantic_memory_items_tags" CHECK (cardinality("semantic_memory_items"."tags") <= 5 AND array_position("semantic_memory_items"."tags", NULL) IS NULL AND '' <> ALL("semantic_memory_items"."tags") AND char_length(array_to_string("semantic_memory_items"."tags", '')) <= 200),
	CONSTRAINT "semantic_memory_items_version" CHECK ("semantic_memory_items"."current_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "site_memory_item_versions" (
	"item_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"statement" text NOT NULL,
	"statement_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english'::regconfig, statement)) STORED NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"lint_override" boolean DEFAULT false NOT NULL,
	"policy_override" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_kind" text NOT NULL,
	"proposal_id" uuid,
	CONSTRAINT "site_memory_item_versions_item_id_version_pk" PRIMARY KEY("item_id","version"),
	CONSTRAINT "site_memory_item_versions_version" CHECK ("site_memory_item_versions"."version" >= 1),
	CONSTRAINT "site_memory_item_versions_statement" CHECK (char_length(btrim("site_memory_item_versions"."statement")) >= 1 AND char_length("site_memory_item_versions"."statement") <= 500),
	CONSTRAINT "site_memory_item_versions_actor" CHECK ("site_memory_item_versions"."actor_kind" IN ('user', 'import', 'proposal')),
	CONSTRAINT "site_memory_item_versions_proposal" CHECK (("site_memory_item_versions"."actor_kind" = 'proposal') = ("site_memory_item_versions"."proposal_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "site_memory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"superseded_by" uuid,
	"pinned" boolean DEFAULT false NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"policy" boolean DEFAULT false NOT NULL,
	"as_of" date,
	CONSTRAINT "site_memory_items_kind" CHECK ("site_memory_items"."kind" IN ('preference', 'fact', 'convention', 'definition', 'decision')),
	CONSTRAINT "site_memory_items_status" CHECK ("site_memory_items"."status" IN ('active', 'archived', 'superseded')),
	CONSTRAINT "site_memory_items_superseded" CHECK (("site_memory_items"."status" = 'superseded') = ("site_memory_items"."superseded_by" IS NOT NULL) AND "site_memory_items"."superseded_by" IS DISTINCT FROM "site_memory_items"."id"),
	CONSTRAINT "site_memory_items_tags" CHECK (cardinality("site_memory_items"."tags") <= 5 AND array_position("site_memory_items"."tags", NULL) IS NULL AND '' <> ALL("site_memory_items"."tags") AND char_length(array_to_string("site_memory_items"."tags", '')) <= 200),
	CONSTRAINT "site_memory_items_version" CHECK ("site_memory_items"."current_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "portable_memory_item_versions" ADD CONSTRAINT "portable_memory_item_versions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_memory_item_versions" ADD CONSTRAINT "portable_memory_item_versions_item_fk" FOREIGN KEY ("item_id") REFERENCES "public"."portable_memory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_memory_items" ADD CONSTRAINT "portable_memory_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portable_memory_items" ADD CONSTRAINT "portable_memory_items_superseded_by_fk" FOREIGN KEY ("superseded_by","owner_user_id") REFERENCES "public"."portable_memory_items"("id","owner_user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_memory_items" ADD CONSTRAINT "run_memory_items_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_memory_items" ADD CONSTRAINT "run_memory_items_run_fk" FOREIGN KEY ("team_id","run_id") REFERENCES "public"."runs"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_memory_items" ADD CONSTRAINT "run_memory_items_version_fk" FOREIGN KEY ("team_id","item_id","version") REFERENCES "public"."semantic_memory_item_versions"("team_id","item_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_memory_item_versions" ADD CONSTRAINT "semantic_memory_item_versions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_memory_item_versions" ADD CONSTRAINT "semantic_memory_item_versions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_memory_item_versions" ADD CONSTRAINT "semantic_memory_item_versions_item_fk" FOREIGN KEY ("team_id","item_id") REFERENCES "public"."semantic_memory_items"("team_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_memory_items" ADD CONSTRAINT "semantic_memory_items_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_memory_items" ADD CONSTRAINT "semantic_memory_items_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "semantic_memory_items" ADD CONSTRAINT "semantic_memory_items_superseded_by_fk" FOREIGN KEY ("team_id","superseded_by") REFERENCES "public"."semantic_memory_items"("team_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_memory_item_versions" ADD CONSTRAINT "site_memory_item_versions_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_memory_item_versions" ADD CONSTRAINT "site_memory_item_versions_item_fk" FOREIGN KEY ("item_id") REFERENCES "public"."site_memory_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_memory_items" ADD CONSTRAINT "site_memory_items_superseded_by_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."site_memory_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "portable_memory_item_versions_tsv_idx" ON "portable_memory_item_versions" USING gin ("statement_tsv");--> statement-breakpoint
CREATE INDEX "portable_memory_item_versions_trgm_idx" ON "portable_memory_item_versions" USING gin ("statement" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "portable_memory_items_owner_idx" ON "portable_memory_items" USING btree ("owner_user_id","status");--> statement-breakpoint
CREATE INDEX "run_memory_items_item_idx" ON "run_memory_items" USING btree ("team_id","item_id");--> statement-breakpoint
CREATE INDEX "semantic_memory_items_scope_idx" ON "semantic_memory_items" USING btree ("team_id","scope","status");--> statement-breakpoint
CREATE INDEX "semantic_memory_items_owner_idx" ON "semantic_memory_items" USING btree ("team_id","owner_user_id","status") WHERE "semantic_memory_items"."scope" = 'user';--> statement-breakpoint
CREATE INDEX "site_memory_item_versions_tsv_idx" ON "site_memory_item_versions" USING gin ("statement_tsv");--> statement-breakpoint
CREATE INDEX "site_memory_item_versions_trgm_idx" ON "site_memory_item_versions" USING gin ("statement" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "site_memory_items_status_idx" ON "site_memory_items" USING btree ("status","policy");