-- Thread search (KOBE-33; spec D9, D24, §5.4 threads.tsv, §6.1 GET /v1/threads?q=): Postgres full-text
-- over message text and titles, trigram on titles. Custom SQL (not in the Drizzle schema): the entry
-- column depends on a function, and db:rebase replays custom migrations after generated ones.
--
-- No GIN index on purpose. Under FORCE RLS the planner may use a user qual as an index condition only
-- if its operator is LEAKPROOF; the text-search and trigram operators (@@, %, <%, LIKE) are not, so a
-- GIN index would only ever be scanned by team_id (the whole team) and filtered row by row, while
-- every append paid for it. Search is driven instead by the viewer's visible threads (leakproof uuid
-- equality on threads_owner_activity_idx / threads_project_activity_idx, then the entry key below),
-- so its cost grows with what the viewer can read, not with the team.

-- Trusted extension (PG 13+): the database owner can create it without superuser. Spec D4 requires it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

-- The searchable text of a Pi session v3 entry (D15): the text of user and assistant messages
-- (string content, or the `text` blocks of a content array). Thinking, tool calls, tool results,
-- system prompts, summaries and extension entries are not indexed. Capped at 100,000 characters so a
-- huge inline payload can never exceed the 1 MB tsvector limit and fail the append (bodies over 64 KB
-- go to S3 anyway). IMMUTABLE: it backs a stored generated column; changing it requires recomputing
-- the column (ALTER COLUMN ... SET EXPRESSION).
CREATE FUNCTION "public"."kobe_entry_search_text"(entry_type text, payload jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN CASE
    WHEN entry_type = 'message' AND payload #>> '{message,role}' IN ('user', 'assistant') THEN
      left(
        (SELECT string_agg(part #>> '{}', E'\n')
         FROM jsonb_array_elements(
           jsonb_path_query_array(payload, '$.message.content ? (@.type() == "string")', '{}', true)
           || jsonb_path_query_array(payload, '$.message.content[*] ? (@.type == "text").text', '{}', true)
         ) AS part),
        100000)
  END;--> statement-breakpoint

-- One tsvector per entry, computed once at append (not per token: entries are committed messages) and
-- only for message entries; NULL for everything else. English stemming, fixed for v1.
ALTER TABLE "thread_entries" ADD COLUMN "tsv" tsvector
  GENERATED ALWAYS AS (to_tsvector('english'::regconfig, "public"."kobe_entry_search_text"("type", "payload"))) STORED;--> statement-breakpoint

-- §5.4 threads.tsv: the title, weight A so title matches outrank body matches. Recomputed only when
-- the title changes; not indexed, so the hot counter updates on threads stay HOT.
ALTER TABLE "threads" ADD COLUMN "tsv" tsvector
  GENERATED ALWAYS AS (setweight(to_tsvector('english'::regconfig, coalesce("title", '')), 'A')) STORED;--> statement-breakpoint

-- The searchable entries of one thread: lets search visit only message entries of the viewer's
-- threads instead of every entry (tool results are often most of a thread).
CREATE INDEX "thread_entries_search_idx" ON "thread_entries" USING btree ("team_id", "thread_id")
  WHERE "tsv" IS NOT NULL;
