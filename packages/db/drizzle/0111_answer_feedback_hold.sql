-- KOBE-275 review (B1, S2): a legal hold never refuses or reveals itself to a member changing or
-- clearing their rating. Custom, so db:rebase keeps this SQL as written. Both tables are new
-- (0108, 0110), so nothing here scans or rewrites existing data.
--
-- 0109 refused a change or clear while a hold covered the thread's owner (KH001 → 409): that told
-- the member, and any reader of a shared thread, that a hold exists. Instead, while a hold covers
-- the thread's owner OR the rater, the old row is copied into answer_feedback_history and the
-- change goes through as usual. Copies are made only while the thread still exists, i.e. for a
-- member's own change or clear: a purge reaches ratings by cascade after the thread row is gone, and
-- the thread's own guard has already refused a held thread (a rater's hold must not stall the purge
-- of someone else's unheld thread, so it isn't checked there).
--
-- answer_feedback_history: the canonical team policy, a break_glass_read policy shaped like
-- answer_feedback's (thread-bound), immutable, and its rows' deletion and TRUNCATE refused while a
-- hold covers the thread's owner (the same guard as 0109 had for answer_feedback; it goes with its
-- thread by cascade once the hold is released).

DROP TRIGGER "answer_feedback_legal_hold" ON "answer_feedback";--> statement-breakpoint
DROP TRIGGER "answer_feedback_legal_hold_update" ON "answer_feedback";--> statement-breakpoint
DROP FUNCTION "public"."answer_feedback_legal_hold_keep"();--> statement-breakpoint
DROP FUNCTION "public"."answer_feedback_legal_hold_guard"();--> statement-breakpoint

-- Whether a hold covers a rating of `rater` on the existing thread `thread` (false once it is gone).
CREATE FUNCTION "public"."answer_feedback_held"(team uuid, thread uuid, rater uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."threads" t
     WHERE t.team_id = team AND t.id = thread
       AND ("public"."legal_hold_covers"(team, t.owner_user_id)
         OR "public"."legal_hold_covers"(team, rater)))
$$;--> statement-breakpoint

CREATE FUNCTION "public"."answer_feedback_keep_changed"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  -- An unchanged write (a retry) keeps nothing.
  IF (NEW.rating, NEW.reasons, NEW.comment, NEW.entry_id)
     IS NOT DISTINCT FROM (OLD.rating, OLD.reasons, OLD.comment, OLD.entry_id) THEN
    RETURN NEW;
  END IF;
  PERFORM "public"."legal_hold_lock_shared"();
  IF "public"."answer_feedback_held"(OLD.team_id, OLD.thread_id, OLD.user_id) THEN
    INSERT INTO "public"."answer_feedback_history"
      (team_id, feedback_id, thread_id, run_id, entry_id, user_id, rating, reasons, comment,
       agent_scope, agent_id, agent_version, model_alias, rated_at, rated_updated_at, change)
    VALUES (OLD.team_id, OLD.id, OLD.thread_id, OLD.run_id, OLD.entry_id, OLD.user_id, OLD.rating,
       OLD.reasons, OLD.comment, OLD.agent_scope, OLD.agent_id, OLD.agent_version, OLD.model_alias,
       OLD.created_at, OLD.updated_at, 'changed');
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "answer_feedback_keep_changed" BEFORE UPDATE ON "answer_feedback"
  FOR EACH ROW EXECUTE FUNCTION "public"."answer_feedback_keep_changed"();--> statement-breakpoint

CREATE FUNCTION "public"."answer_feedback_keep_cleared"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  INSERT INTO "public"."answer_feedback_history"
    (team_id, feedback_id, thread_id, run_id, entry_id, user_id, rating, reasons, comment,
     agent_scope, agent_id, agent_version, model_alias, rated_at, rated_updated_at, change)
  SELECT d.team_id, d.id, d.thread_id, d.run_id, d.entry_id, d.user_id, d.rating, d.reasons,
         d.comment, d.agent_scope, d.agent_id, d.agent_version, d.model_alias, d.created_at,
         d.updated_at, 'cleared'
    FROM gone d
   WHERE "public"."answer_feedback_held"(d.team_id, d.thread_id, d.user_id);
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "answer_feedback_keep_cleared" AFTER DELETE ON "answer_feedback"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."answer_feedback_keep_cleared"();--> statement-breakpoint

ALTER TABLE "answer_feedback_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "answer_feedback_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "answer_feedback_history"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "answer_feedback_history" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND "thread_id" = COALESCE((SELECT g.thread_id FROM "public"."break_glass_active_grant"() g), "thread_id")
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL OR EXISTS (
      SELECT 1 FROM "public"."threads" t
      WHERE t."team_id" = "answer_feedback_history"."team_id" AND t."id" = "answer_feedback_history"."thread_id"
        AND t."owner_user_id" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g)))
  );--> statement-breakpoint

CREATE FUNCTION "public"."answer_feedback_history_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.thread_id FROM gone d) g
    LEFT JOIN "public"."threads" t ON t.team_id = g.team_id AND t.id = g.thread_id
    WHERE "public"."legal_hold_covers"(g.team_id, t.owner_user_id)) THEN
    RAISE EXCEPTION 'answer feedback history under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "answer_feedback_history_legal_hold" AFTER DELETE ON "answer_feedback_history"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."answer_feedback_history_legal_hold_guard"();--> statement-breakpoint
CREATE TRIGGER "answer_feedback_history_legal_hold_truncate" BEFORE TRUNCATE ON "answer_feedback_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint

CREATE FUNCTION "public"."answer_feedback_history_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'answer feedback history is immutable' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
-- Every column but team_id, which is left to RLS and the foreign keys (as for artifact_versions).
CREATE TRIGGER "answer_feedback_history_immutable" BEFORE UPDATE OF "id", "feedback_id", "thread_id",
    "run_id", "entry_id", "user_id", "rating", "reasons", "comment", "agent_scope", "agent_id",
    "agent_version", "model_alias", "rated_at", "rated_updated_at", "change", "kept_at"
  ON "answer_feedback_history"
  FOR EACH ROW EXECUTE FUNCTION "public"."answer_feedback_history_immutable"();
