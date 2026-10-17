-- KOBE-276 re-review R1, R4. Custom, so db:rebase keeps this SQL as written.
--
-- agent_eval_cases.hidden_at (0120) is set by the retention pass when a hold keeps a case that
-- would otherwise have been purged; from then on the case looks purged for good. It may be set
-- once and never cleared or moved, so the immutability trigger now covers it too (an unhidden
-- case would show the hold). orbit_evals.case_skips must be an object (counts by reason).

CREATE OR REPLACE FUNCTION "public"."agent_eval_cases_immutable"() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.id, NEW.user_id, NEW.agent_scope, NEW.agent_id, NEW.agent_version, NEW.content,
      NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.user_id, OLD.agent_scope, OLD.agent_id, OLD.agent_version,
      OLD.content, OLD.created_at)
     OR (NEW.feedback_id IS DISTINCT FROM OLD.feedback_id AND NEW.feedback_id IS NOT NULL)
     OR (OLD.hidden_at IS NOT NULL AND NEW.hidden_at IS DISTINCT FROM OLD.hidden_at) THEN
    RAISE EXCEPTION 'a shared eval case''s copy is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER "agent_eval_cases_immutable" ON "agent_eval_cases";--> statement-breakpoint
-- Every column but team_id, which is left to RLS and the foreign keys (as for every team table).
CREATE TRIGGER "agent_eval_cases_immutable" BEFORE UPDATE OF "id", "feedback_id", "user_id",
    "agent_scope", "agent_id", "agent_version", "content", "created_at", "hidden_at"
  ON "agent_eval_cases"
  FOR EACH ROW EXECUTE FUNCTION "public"."agent_eval_cases_immutable"();--> statement-breakpoint

ALTER TABLE "orbit_evals" ADD CONSTRAINT "orbit_evals_case_skips"
  CHECK (jsonb_typeof("case_skips") = 'object') NOT VALID;--> statement-breakpoint
ALTER TABLE "orbit_evals" VALIDATE CONSTRAINT "orbit_evals_case_skips";
