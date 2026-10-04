CREATE TABLE "skill_blocklist" (
	"content_hash" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"added_by" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_blocklist_hash" CHECK ("skill_blocklist"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "skill_blocklist_reason" CHECK (char_length(btrim("skill_blocklist"."reason")) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "skill_blocklist" ADD CONSTRAINT "skill_blocklist_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_blocklist_added_idx" ON "skill_blocklist" USING btree ("added_at" DESC NULLS LAST,"content_hash");