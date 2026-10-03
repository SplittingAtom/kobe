CREATE TABLE "egress_domains" (
	"domain" text PRIMARY KEY NOT NULL,
	"preset" text,
	"in_ceiling" boolean DEFAULT false NOT NULL,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "egress_domains_domain" CHECK (char_length("egress_domains"."domain") <= 253 AND "egress_domains"."domain" ~ '^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "egress_domains_preset" CHECK ("egress_domains"."preset" IS NULL OR "egress_domains"."preset" IN ('package_registries', 'git_hosts', 'web_search')),
	CONSTRAINT "egress_domains_note" CHECK ("egress_domains"."note" IS NULL OR char_length("egress_domains"."note") <= 200)
);
--> statement-breakpoint
CREATE TABLE "team_egress" (
	"team_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"enabled_by" uuid NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_egress_team_id_domain_pk" PRIMARY KEY("team_id","domain")
);
--> statement-breakpoint
ALTER TABLE "egress_domains" ADD CONSTRAINT "egress_domains_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_egress" ADD CONSTRAINT "team_egress_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_egress" ADD CONSTRAINT "team_egress_domain_egress_domains_domain_fk" FOREIGN KEY ("domain") REFERENCES "public"."egress_domains"("domain") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_egress" ADD CONSTRAINT "team_egress_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;