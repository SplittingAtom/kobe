CREATE TABLE "gallery_agent_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"attack_success_rate" double precision NOT NULL,
	"attempts" integer NOT NULL,
	"attack_successes" integer NOT NULL,
	"threshold" double precision NOT NULL,
	"report" jsonb,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gallery_agent_scores_status" CHECK ("gallery_agent_scores"."status" IN ('passed', 'blocked')),
	CONSTRAINT "gallery_agent_scores_rate" CHECK ("gallery_agent_scores"."attack_success_rate" >= 0 AND "gallery_agent_scores"."attack_success_rate" <= 1 AND "gallery_agent_scores"."threshold" >= 0 AND "gallery_agent_scores"."threshold" <= 1)
);
--> statement-breakpoint
ALTER TABLE "orbit_evals" DROP CONSTRAINT "orbit_evals_scope";--> statement-breakpoint
ALTER TABLE "gallery_agent_scores" ADD CONSTRAINT "gallery_agent_scores_agent_id_install_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."install_agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gallery_agent_scores" ADD CONSTRAINT "gallery_agent_scores_version_fk" FOREIGN KEY ("agent_id","version") REFERENCES "public"."install_agent_versions"("agent_id","version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gallery_agent_scores_agent_idx" ON "gallery_agent_scores" USING btree ("agent_id","version","evaluated_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "orbit_evals" ADD CONSTRAINT "orbit_evals_scope" CHECK ("orbit_evals"."agent_scope" IN ('team', 'personal', 'gallery'));