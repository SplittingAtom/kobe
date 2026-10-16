-- KOBE-221 (CE20): share scope team. Expand-only: the constant default is metadata-only (no table
-- rewrite, PG >= 11), so every existing row and every insert from a previous release is unshared.
-- The share-scope CHECK and the Shared with me index follow in 0106.
ALTER TABLE "threads" ADD COLUMN "shared_to_team" boolean DEFAULT false NOT NULL;