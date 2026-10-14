-- Fork provenance (KOBE-215, CE16). A fork names its source as (team_id, forked_from_thread_id),
-- so the key can never reach another team's thread. Purging the source (retention, Trash purge,
-- Delete forever, team deletion) keeps the fork and only clears the link: the column list limits
-- SET NULL to forked_from_thread_id, because team_id is NOT NULL and part of threads' key
-- (PostgreSQL 15+; the chart and CI run 17). forked_at_entry_id is provenance text and stays.
-- drizzle cannot express the column list, hence SQL-only (like threads_schedule_fk, 0087).
-- Validating the key reads threads once; the column is new and all null, so nothing can fail.
-- threads_forked_from_idx (0095) serves the SET NULL lookup on every purge.
ALTER TABLE "threads" ADD CONSTRAINT "threads_forked_from_fk"
  FOREIGN KEY ("team_id", "forked_from_thread_id") REFERENCES "threads" ("team_id", "id")
  ON DELETE SET NULL ("forked_from_thread_id");
