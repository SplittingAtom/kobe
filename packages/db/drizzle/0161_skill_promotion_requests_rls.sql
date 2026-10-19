-- KOBE-333 (Skills v1.2, SK19; D5, D10): row security for 0155_skill_promotion_requests. Custom, so
-- db:rebase keeps this SQL as written. The table is new and empty: nothing is backfilled.
--
-- Team isolation, as in 0001_team_rls.sql: ENABLE + FORCE RLS and the canonical policy. Which
-- members read or decide a request (its Builder; the team's admins) is the server's decision.
-- Break-glass (D10): a SELECT-only break_glass_read policy shaped like skill_drafts' (0144): a team
-- grant reads the team's requests, a user grant those the user made, a thread grant none.
ALTER TABLE "skill_promotion_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_promotion_requests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "skill_promotion_requests"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "skill_promotion_requests" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND (SELECT g.thread_id FROM "public"."break_glass_active_grant"() g) IS NULL
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL
      OR "requested_by" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g))
  );
