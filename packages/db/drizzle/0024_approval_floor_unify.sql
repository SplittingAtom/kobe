-- One approval floor (spec D6: the policy floor, "minimum approval mode", is install-wide; teams
-- tighten only through ask/deny rules). Two keys existed: `policy.approval_floor` (KOBE-46) and
-- `policy.approval_mode_floor` (KOBE-24), plus a team floor in `teams.settings.approval_mode_floor`
-- that the spec does not provide. Keep `policy.approval_floor`, set to the stricter of both install
-- values (an unreadable value counts as `ask-all`, as both readers treated it: fail closed), and drop
-- the other key and every team floor. Idempotent.
WITH ranked AS (
  SELECT CASE value WHEN 'auto' THEN 0 WHEN 'ask-on-write' THEN 1 ELSE 2 END AS rank
    FROM install_settings
   WHERE key IN ('policy.approval_floor', 'policy.approval_mode_floor')
)
INSERT INTO install_settings (key, value)
SELECT 'policy.approval_floor', (ARRAY['auto', 'ask-on-write', 'ask-all'])[max(rank) + 1]
  FROM ranked
HAVING count(*) > 0
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();--> statement-breakpoint
DELETE FROM install_settings WHERE key = 'policy.approval_mode_floor';--> statement-breakpoint
-- A dropped team floor stricter than `auto` loosened that team: say so in the migration log (also
-- in docs/install.md, upgrade notes). Teams that want it back add an `ask` rule (e.g. on `*`).
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT id, settings ->> 'approval_mode_floor' AS floor FROM teams
            WHERE settings ? 'approval_mode_floor'
              AND settings ->> 'approval_mode_floor' IS DISTINCT FROM 'auto'
            ORDER BY id
  LOOP
    RAISE NOTICE 'kobe: dropped team approval floor % of team % (no team floor, spec D6)',
      t.floor, t.id;
  END LOOP;
END $$;--> statement-breakpoint
UPDATE teams SET settings = settings - 'approval_mode_floor' WHERE settings ? 'approval_mode_floor';
