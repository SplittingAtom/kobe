-- KOBE-275: team isolation, break-glass read and legal-hold guards for answer_feedback (0108), spec
-- D5, D10, D18. Custom, so db:rebase keeps this SQL as written. The table is new and empty, so
-- nothing here scans or rewrites existing data.
--
-- Team isolation: the canonical policy, as in 0005_conversations_rls.sql.
--
-- Break-glass (D10): a rating's comment is thread content, so a SELECT-only break_glass_read
-- policy shaped like thread_entries' (0023) and artifacts' (0067): a team grant reads the team's
-- ratings, a user grant those on that user's threads, a thread grant that thread's.
--
-- Legal hold (D18): ratings follow their thread, like artifacts: while a hold covers the thread's
-- owner, deleting a rating (a member clearing it, or a purge) and changing one are refused with
-- KH001, and TRUNCATE while any hold is active. Only the thread owner's hold counts, never the
-- rater's: a rater's hold must not stall the purge of someone else's unheld thread (the purge would
-- fail on every pass). New ratings stay allowed: an insert removes nothing.

ALTER TABLE "answer_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "answer_feedback" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "answer_feedback"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "answer_feedback" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND "thread_id" = COALESCE((SELECT g.thread_id FROM "public"."break_glass_active_grant"() g), "thread_id")
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL OR EXISTS (
      SELECT 1 FROM "public"."threads" t
      WHERE t."team_id" = "answer_feedback"."team_id" AND t."id" = "answer_feedback"."thread_id"
        AND t."owner_user_id" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g)))
  );--> statement-breakpoint

-- Deletes come in bulk (a thread's cascade): one check per statement over the distinct threads. A
-- thread already gone in the same statement (cascade) counts for team-wide holds only; its own
-- BEFORE DELETE guard has checked the owner. SECURITY INVOKER (the default), as every Kobe function.
CREATE FUNCTION "public"."answer_feedback_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.thread_id FROM gone d) g
    LEFT JOIN "public"."threads" t ON t.team_id = g.team_id AND t.id = g.thread_id
    WHERE "public"."legal_hold_covers"(g.team_id, t.owner_user_id)) THEN
    RAISE EXCEPTION 'answer feedback under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "answer_feedback_legal_hold" AFTER DELETE ON "answer_feedback"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."answer_feedback_legal_hold_guard"();--> statement-breakpoint

-- A change rewrites the rating, its reasons and its comment: refused while held, like a delete.
CREATE FUNCTION "public"."answer_feedback_legal_hold_keep"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF "public"."legal_hold_covers"(OLD.team_id,
       (SELECT t.owner_user_id FROM "public"."threads" t
         WHERE t.team_id = OLD.team_id AND t.id = OLD.thread_id)) THEN
    RAISE EXCEPTION 'answer feedback under legal hold cannot be changed' USING ERRCODE = 'KH001';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "answer_feedback_legal_hold_update" BEFORE UPDATE ON "answer_feedback"
  FOR EACH ROW EXECUTE FUNCTION "public"."answer_feedback_legal_hold_keep"();--> statement-breakpoint
CREATE TRIGGER "answer_feedback_legal_hold_truncate" BEFORE TRUNCATE ON "answer_feedback"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();
