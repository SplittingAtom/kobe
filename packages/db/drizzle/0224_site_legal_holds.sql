CREATE TABLE "site_legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reason" text NOT NULL,
	"status" "legal_hold_status" DEFAULT 'pending' NOT NULL,
	"placed_by" uuid NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"self_approved" boolean DEFAULT false NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"release_requested_by" uuid,
	"release_requested_at" timestamp with time zone,
	"release_reason" text,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"release_self_approved" boolean DEFAULT false NOT NULL,
	CONSTRAINT "site_legal_holds_reason" CHECK (char_length(btrim("site_legal_holds"."reason")) BETWEEN 1 AND 2000),
	CONSTRAINT "site_legal_holds_release_reason" CHECK ("site_legal_holds"."release_reason" IS NULL OR char_length(btrim("site_legal_holds"."release_reason")) BETWEEN 1 AND 2000),
	CONSTRAINT "site_legal_holds_two_person" CHECK ("site_legal_holds"."approved_by" IS NULL OR ("site_legal_holds"."approved_by" = "site_legal_holds"."placed_by") = "site_legal_holds"."self_approved"),
	CONSTRAINT "site_legal_holds_release_two_person" CHECK ("site_legal_holds"."released_by" IS NULL OR ("site_legal_holds"."released_by" = "site_legal_holds"."release_requested_by") = "site_legal_holds"."release_self_approved"),
	CONSTRAINT "site_legal_holds_active_shape" CHECK ("site_legal_holds"."status" NOT IN ('active', 'released') OR ("site_legal_holds"."approved_by" IS NOT NULL AND "site_legal_holds"."approved_at" IS NOT NULL)),
	CONSTRAINT "site_legal_holds_released_shape" CHECK (("site_legal_holds"."status" = 'released') = ("site_legal_holds"."released_by" IS NOT NULL AND "site_legal_holds"."released_at" IS NOT NULL)),
	CONSTRAINT "site_legal_holds_release_request_shape" CHECK (("site_legal_holds"."release_requested_by" IS NULL) = ("site_legal_holds"."release_requested_at" IS NULL) AND ("site_legal_holds"."release_requested_by" IS NULL) = ("site_legal_holds"."release_reason" IS NULL) AND ("site_legal_holds"."release_requested_by" IS NULL OR "site_legal_holds"."status" IN ('active', 'released')))
);
--> statement-breakpoint
ALTER TABLE "site_legal_holds" ADD CONSTRAINT "site_legal_holds_placed_by_users_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_legal_holds" ADD CONSTRAINT "site_legal_holds_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_legal_holds" ADD CONSTRAINT "site_legal_holds_closed_by_users_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_legal_holds" ADD CONSTRAINT "site_legal_holds_release_requested_by_users_id_fk" FOREIGN KEY ("release_requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_legal_holds" ADD CONSTRAINT "site_legal_holds_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_legal_holds_requested_idx" ON "site_legal_holds" USING btree ("requested_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "site_legal_holds_active_idx" ON "site_legal_holds" USING btree ("status") WHERE "site_legal_holds"."status" = 'active';