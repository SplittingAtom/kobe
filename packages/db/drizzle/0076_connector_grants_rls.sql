-- Team isolation for connector_grants (KOBE-108, spec D5): the canonical policy as in
-- 0005_conversations_rls.sql.
--
-- Deliberately NO break_glass_read policy (D10): a grant holds a user's credential, which is not
-- content an install admin may read, even under a grant; break-glass sees threads, files, memory
-- and artifacts only. The ciphertext is also useless without the install key.
--
-- Legal hold (D18) does not apply: a grant is a credential, not retained team content (no thread,
-- file, memory or audit data), and a user must be able to remove their key and be deleted while a
-- hold is active. The audit trail of add/replace/remove is in audit_log, which holds do guard.

ALTER TABLE "connector_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "connector_grants" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_isolation" ON "connector_grants"
  USING ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid)
  WITH CHECK ("team_id" = NULLIF(current_setting('kobe.team_id', true), '')::uuid);
