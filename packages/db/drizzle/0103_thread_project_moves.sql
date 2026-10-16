-- KOBE-220 (CE19): the thread's moves between projects, for the next run's marker. Expand-only:
-- the constant default is metadata-only (no table rewrite, PG >= 11) and every existing row and every
-- insert from a previous release gets '[]'. The shape CHECK and the Archived index follow in 0104.
ALTER TABLE "threads" ADD COLUMN "project_moves" jsonb DEFAULT '[]'::jsonb NOT NULL;
