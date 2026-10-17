-- KOBE-276: team isolation, break-glass read, the rating key, immutability and legal-hold
-- handling for the shared eval cases (0112), spec D5, D10, D18. Custom, so db:rebase keeps this
-- SQL as written. Both case tables are new and empty; orbit_evals' new check is NOT VALID (the
-- table has rows; every existing row has no cases and satisfies it anyway).
--
-- Team isolation: the canonical policy on both tables, as in 0005_conversations_rls.sql.
--
-- Break-glass (D10): a case is a member's consented copy, not thread content (it has no thread),
-- so a SELECT-only break_glass_read policy shaped like memory_docs' (0074): a team grant reads the
-- team's cases, a user grant those that user shared, a thread grant none.
--
-- The rating key: (team_id, feedback_id) -> answer_feedback ON DELETE SET NULL (feedback_id), so
-- clearing the rating keeps the case (the member withdraws it on its own) and team_id stays.
--
-- Immutability: the copy and who shared it never change; only the owner's review does (status,
-- expected_behaviour, reviewed_at), and the key may only go to NULL (the SET NULL action).
--
-- Legal hold (D18), the KOBE-275 history pattern: a hold never refuses or shows itself. When a
-- case is deleted (the member withdraws it) while a hold covers the member, a trigger copies it
-- into agent_eval_case_history in the same statement and the withdrawal answers as usual. The
-- retention and offboarding purges select unheld cases only; a team with any hold can't be deleted
-- (legal_holds' team key). The history is immutable, readable under break-glass only, its rows'
-- deletion and TRUNCATE refused while a hold covers the member; the retention pass purges it once
-- none does. TRUNCATE of the cases is refused while any hold is active.

ALTER TABLE "orbit_evals" ADD CONSTRAINT "orbit_evals_cases" CHECK (
  ("case_scored" IS NULL) = ("case_failures" IS NULL)
  AND ("case_scored" IS NULL OR ("case_failures" >= 0 AND "case_failures" <= "case_scored"
    AND "case_scored" <= cardinality("case_ids")))) NOT VALID;--> statement-breakpoint

ALTER TABLE "agent_eval_cases" ADD CONSTRAINT "agent_eval_cases_feedback_fk"
  FOREIGN KEY ("team_id", "feedback_id") REFERENCES "public"."answer_feedback"("team_id", "id")
  ON DELETE SET NULL ("feedback_id");--> statement-breakpoint

ALTER TABLE "agent_eval_cases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_eval_cases" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "agent_eval_cases"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "agent_eval_cases" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND (SELECT g.thread_id FROM "public"."break_glass_active_grant"() g) IS NULL
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL
      OR "user_id" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g))
  );--> statement-breakpoint

CREATE FUNCTION "public"."agent_eval_cases_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.id, NEW.user_id, NEW.agent_scope, NEW.agent_id, NEW.agent_version, NEW.content,
      NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.agent_scope, OLD.agent_id, OLD.agent_version,
      OLD.content, OLD.created_at)
     OR (NEW.feedback_id IS DISTINCT FROM OLD.feedback_id AND NEW.feedback_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a shared eval case''s copy is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- Every column but team_id, which is left to RLS and the foreign keys (as for every team table).
CREATE TRIGGER "agent_eval_cases_immutable" BEFORE UPDATE OF "id", "feedback_id", "user_id",
    "agent_scope", "agent_id", "agent_version", "content", "created_at"
  ON "agent_eval_cases"
  FOR EACH ROW EXECUTE FUNCTION "public"."agent_eval_cases_immutable"();--> statement-breakpoint

-- Deletes come one by one (a withdrawal) or in batches (purges of unheld cases): one pass over
-- the statement's rows. SECURITY INVOKER (the default), as every Kobe function.
CREATE FUNCTION "public"."agent_eval_cases_keep_held"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  INSERT INTO "public"."agent_eval_case_history"
    (team_id, case_id, feedback_id, user_id, agent_scope, agent_id, agent_version, content,
     status, expected_behaviour, reviewed_at, shared_at)
  SELECT d.team_id, d.id, d.feedback_id, d.user_id, d.agent_scope, d.agent_id, d.agent_version,
         d.content, d.status, d.expected_behaviour, d.reviewed_at, d.created_at
    FROM gone d
   WHERE "public"."legal_hold_covers"(d.team_id, d.user_id);
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "agent_eval_cases_keep_held" AFTER DELETE ON "agent_eval_cases"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."agent_eval_cases_keep_held"();--> statement-breakpoint
CREATE TRIGGER "agent_eval_cases_legal_hold_truncate" BEFORE TRUNCATE ON "agent_eval_cases"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint

ALTER TABLE "agent_eval_case_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_eval_case_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "agent_eval_case_history"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "break_glass_read" ON "agent_eval_case_history" FOR SELECT
  USING (
    "team_id" = (SELECT g.team_id FROM "public"."break_glass_active_grant"() g)
    AND (SELECT g.thread_id FROM "public"."break_glass_active_grant"() g) IS NULL
    AND ((SELECT g.user_id FROM "public"."break_glass_active_grant"() g) IS NULL
      OR "user_id" = (SELECT g.user_id FROM "public"."break_glass_active_grant"() g))
  );--> statement-breakpoint

CREATE FUNCTION "public"."agent_eval_case_history_legal_hold_guard"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM "public"."legal_hold_lock_shared"();
  IF EXISTS (
    SELECT 1 FROM (SELECT DISTINCT d.team_id, d.user_id FROM gone d) g
    WHERE "public"."legal_hold_covers"(g.team_id, g.user_id)) THEN
    RAISE EXCEPTION 'eval case history under legal hold cannot be deleted' USING ERRCODE = 'KH001';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "agent_eval_case_history_legal_hold" AFTER DELETE ON "agent_eval_case_history"
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."agent_eval_case_history_legal_hold_guard"();--> statement-breakpoint
CREATE TRIGGER "agent_eval_case_history_legal_hold_truncate" BEFORE TRUNCATE ON "agent_eval_case_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."legal_hold_refuse_truncate"();--> statement-breakpoint

CREATE FUNCTION "public"."agent_eval_case_history_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'eval case history is immutable' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "agent_eval_case_history_immutable" BEFORE UPDATE OF "id", "case_id", "feedback_id",
    "user_id", "agent_scope", "agent_id", "agent_version", "content", "status",
    "expected_behaviour", "reviewed_at", "shared_at", "kept_at"
  ON "agent_eval_case_history"
  FOR EACH ROW EXECUTE FUNCTION "public"."agent_eval_case_history_immutable"();
