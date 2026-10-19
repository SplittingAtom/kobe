ALTER TABLE "model_spend_daily" ADD COLUMN "eval_cost_usd" numeric(24, 10) DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_spend_daily" ADD COLUMN "eval_tokens" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "team_skill_settings" ADD COLUMN "eval_cap_usd" numeric(14, 2);--> statement-breakpoint
ALTER TABLE "team_skill_settings" ADD COLUMN "eval_cap_tokens" bigint;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD COLUMN "eval" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "team_skill_settings" ADD CONSTRAINT "team_skill_settings_eval_cap" CHECK (("team_skill_settings"."eval_cap_usd" IS NULL OR "team_skill_settings"."eval_cap_tokens" IS NULL)
        AND ("team_skill_settings"."eval_cap_usd" IS NULL OR ("team_skill_settings"."eval_cap_usd" > 0 AND "team_skill_settings"."eval_cap_usd" <= 1000000))
        AND ("team_skill_settings"."eval_cap_tokens" IS NULL OR "team_skill_settings"."eval_cap_tokens" BETWEEN 1 AND 1000000000000));