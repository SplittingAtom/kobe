# KOBE-33: Thread search

- **Status:** in review (PR #15)
- **Branch / worktree:** `kobe-33-thread-search` in `../Kobe-wt33`
- **Depends on:** KOBE-29 (merged). Consumers: KOBE-34 (Thread API, `GET /v1/threads?q=`), KOBE-14
  (active team, `requireTeam`), KOBE-57 (projects), KOBE-18 (retention).

## Acceptance criteria (derived from spec D5, D9, D18, D23, D24, §5.4, §6.1, U2, U15; Hadron not reachable)

1. ac-1 Postgres full-text search over thread content (user and assistant message text) and titles,
   plus trigram on titles (D24: "thread search is Postgres full-text and trigram", no vectors).
   Stemming and web-search syntax. The index stays current on every append and edit without app
   code, and costs the append path little.
2. ac-2 Visibility: the viewer's own threads plus threads shared to projects the viewer belongs to
   (D23); never another user's private thread, team admins included (D18); never Trash (D18); a
   retention cutoff (D18); a project filter (§6.1 `project_id`); nothing for a non-member.
3. ac-3 Team isolation (D5, D9 "search is team-scoped", U2): runs inside `withTeam()` under RLS; team A
   never finds team B's threads; refuses to run without an active team.
4. ac-4 Ranking (title hits above body hits), plain-text snippets with highlights and the matching
   entry, and cursor pagination that returns every hit exactly once.
5. ac-5 Input validated at the boundary (zod); bad cursors rejected.
6. ac-6 Index use checked with EXPLAIN on realistic data. Reads only Postgres, so it never wakes a
   sandbox (U15).

## Plan

- Custom migration `0009_thread_search.sql` (0006 originally; rebased onto KOBE-14, then KOBE-45): `pg_trgm`, `kobe_entry_search_text(type, payload)`,
  generated `thread_entries.tsv` and `threads.tsv`, partial index `thread_entries_search_idx`.
- `src/thread-search.ts` (`searchThreads(tx, input)`) and `src/thread-search-format.ts` (input
  schema, cursor, snippet parsing). Tests first: `thread-search.db.test.ts`,
  `thread-search-format.test.ts`.
- No HTTP route or UI. §6.1 puts search in `GET /v1/threads?q=` (KOBE-34, which needs KOBE-14's
  active team); the thread list UI is KOBE-32.

## Decisions

1. **No GIN or trigram index, because RLS makes them unusable.** Under FORCE RLS, the planner may use a
   user qual as an index condition only if its operator is `LEAKPROOF`. `@@` (`ts_match_vq`), `%`,
   `<%` and `LIKE` are not leakproof, and no GIN/GiST text operator is. So a GIN `(team_id, tsv)`
   (with btree_gin) is scanned by `team_id` only, which means every row of the team, with `@@` applied as a filter.
   Verified on a 300k-row prototype as a non-owner role. Such an index would cost every append and
   never narrow a search. Marking the operator leakproof needs superuser, and migrations run as a
   non-superuser owner. **This applies to every future search over a team table** (memory, agents,
   skills): drive the scan with leakproof equality (uuid/text btree) and filter text afterwards.
2. **Search is driven by the viewer's visible threads.** `threads_owner_activity_idx` (own) plus
   `threads_project_activity_idx` (shared, `project_id = ANY($projects)`) yields the visible set, and
   `thread_entries_search_idx (team_id, thread_id) WHERE tsv IS NOT NULL` yields their message
   entries. `@@` filters them, `DISTINCT ON` picks the best entry per thread, then the query scores,
   sorts and limits, and computes snippets for the page only. Cost grows with what the viewer can
   read, not with the team.
3. **Per-entry `tsv` (stored generated column), plus title-only `threads.tsv`.** §5.4 lists `tsv` on
   threads. Folding all entry text into one thread-level tsvector would rewrite the thread row on
   every append (not HOT), hit the 1 MB tsvector limit on long threads, and could not say which entry
   matched. So `threads.tsv` holds the title (weight A) and `thread_entries.tsv` holds each message's
   text (default weight D, so title hits rank higher). A generated column needs no trigger, writers
   cannot forget it, and edits recompute it.
4. **What is indexed:** the text of `message` entries with role `user` or `assistant` (string content
   or `text` blocks). Not indexed: thinking, tool calls, tool results (noisy, large), system prompts,
   compaction and branch summaries (duplicates), `custom_message`, `custom`, `session_info`.
   Entries on inactive branches are searchable; `matchedEntryId` may be off the active branch, and
   the UI can switch to it. Text is capped at 100,000 characters so a huge inline payload can never
   exceed the tsvector limit and fail the append.
5. **All search DDL is a custom migration, and the Drizzle schema does not declare the columns.** The
   entry column depends on a SQL function, and `db:rebase` replays custom migrations after generated
   ones, so the column cannot live in a generated migration. The app never reads or writes `tsv`.
   Both columns are documented in `schema/threads.ts`.
6. **English text-search config, fixed for v1.** Stemming helps (chart/charts). Non-English text still
   matches its exact tokens. Changing the config means `ALTER COLUMN … SET EXPRESSION`, which rewrites
   the table.
7. **Trigram is used on titles only, through `word_similarity(query, title) >= 0.6`** (partial words, typos).
   It adds `0.5 × similarity` to the score. There is no index (decision 1); it runs over the visible
   set.
8. **Ranking:** `score = max entry ts_rank + title ts_rank + trigram term` (ts_rank normalization 1,
   which divides by 1 + log length). Ties break by `last_activity_at DESC, id DESC`.
9. **Snippets are plain-text segments** (`{text, highlight}[]`), never HTML. ts_headline delimits matches
   with private-use characters U+E000/U+E001, which are stripped from the source first. ts_headline
   also drops HTML tag tokens from its output, so a snippet never carries markup.
10. **Pagination is a keyset on (score, last activity µs, id)**, using an opaque base64url cursor that
    zod validates. Microseconds travel as a decimal string because a JS Date has ms precision. A score
    can shift between pages when new entries arrive (acceptable for search).
11. **Visibility inputs come from the caller until their tables exist.** `projectIds` (the viewer's
    projects, KOBE-57) and `activeSince` (now minus the team retention period, KOBE-18; omit under
    legal hold or "forever"). The data layer adds `deleted_at IS NULL` (Trash) and requires the
    viewer to be in `team_members` (defence in depth behind `requireTeam`).
12. **Hot path:** the entry `tsv` is computed once per committed entry (entries are messages, not
    deltas). Measured cost is about 0.33 ms for a 300-word message and about 3.3 ms for 3,000 words; tool
    results short-circuit. `threads` has a BEFORE UPDATE trigger (KOBE-29 counter guard), so PG
    recomputes `threads.tsv` (title only, microseconds) on every thread update, including seq
    allocation. The value is unchanged and unindexed, so those updates stay HOT.

13. **Review round 1 (coordinator DB review of PR #15, approve with changes):**
    - **Errors:** `searchThreads` throws only `ThreadSearchError` (`invalid_input`, `no_team`,
      `timeout`, `failed`) carrying the SQLSTATE, never drizzle's error with SQL and parameters.
      Cursor micros are checked against the bigint range before any query (a 20-digit value used to
      fail the `::bigint` cast inside the caller's transaction).
    - **Bounded cost:** the search runs in a savepoint with `statement_timeout` (default 3 s,
      `timeoutMs` 100–30,000; lock waits count too). The caller's timeout is restored afterwards, and
      a timeout rolls back only the savepoint, so the caller's transaction stays usable (tested).
      `ts_headline` now runs only for the `limit` returned rows (not the look-ahead row), on the first
      20,000 characters of the entry. A match beyond that prefix gives an unhighlighted excerpt of
      the start.
    - **Exclusions on the trigram path:** the title trigram input is the query's positive words only
      (quotes, `or` and `-terms` removed, `splitQuery`), and a title whose `tsv` matches any excluded
      term or phrase never matches by trigram. Before, `qwerty -asdfgh` returned "qwerty asdfgh".
    - **Query semantics (documented on the input):** terms co-occur per message (or in the title),
      not across a thread. `a b` needs both in one message, and `a -b` excludes only messages
      containing b. A query of only exclusions (`-a -"b c"`) is rejected as `invalid_input`; the
      alternative was returning nothing.
    - **Privacy rests on the caller for two inputs:** `viewerUserId` must be the session user
      (KOBE-34) and `projectIds` the viewer's projects (KOBE-57). RLS cannot check either; the data
      layer adds only the team-membership check.
    - **`drizzle-kit push` hazard** noted next to `schema/threads.ts`: push would drop the SQL-only
      `tsv` columns. Migrations only.

## Deferred

- **KOBE-34:** `GET /v1/threads?q=&project_id=` should call `searchThreads` inside `withTeam` with
  the session user. Set `SET LOCAL statement_timeout` (e.g. 5 s) on that request.
- **KOBE-57:** pass the viewer's project ids. **KOBE-18:** pass `activeSince` from team retention.
- **KOBE-16 (break-glass):** no admin read path here; break-glass reads go through their own audited
  route.
- **KOBE-30/23 (writers):** store the Pi entry shape in `payload` (`message.role`,
  `message.content`). An entry whose body went to S3 (`blob_ref`) is searchable only through
  whatever text stays inline.

## Open questions (for Chris or the coordinator)

- Scale ceiling: a viewer with 2,000 threads / 40k message entries takes about 100 ms cold (below).
  At roughly 10× that, consider a per-thread aggregate or an inverted-index table keyed by
  `(team_id, lexeme)` (texteq is leakproof, so it can use an index under RLS). Not needed for v1.
- The migration adds two stored generated columns, which rewrites both tables under ACCESS EXCLUSIVE.
  That is fine before first release; after release, such changes need an expand/contract plan.
- External Postgres: the migration role must be able to `CREATE EXTENSION pg_trgm` (a trusted
  extension that the database owner may create), or an operator must pre-install it. Spec D4 already
  requires pg_trgm.

## Evidence (acceptance criteria → test or command output)

- Rebase onto main (KOBE-14 #12, contracts #13, KOBE-9): `db:rebase` re-created the migration as
  custom `0007_thread_search.sql` after `0006_session_active_teams.sql`, byte-identical to the
  original (diff empty; snapshot 0007 = 0006 apart from id chain).
- Rebase onto KOBE-45 (#17, `0007_agents`/`0008_agents_rls`): now `0009_thread_search.sql`, again
  byte-identical, custom (snapshot 0009 = 0008), last in the journal. A fresh migrate has both `tsv`
  columns (generated ALWAYS, stored) and `thread_entries_search_idx`.
- Backup/restore (KOBE-11, merged in): pg_dump leaves stored generated columns out of the data, so
  a restore recomputes them. `packages/cli` round-trip fixture now seeds a Pi user message;
  `backup-restore.db.test.ts` › "restores into a fresh install" asserts the dump's `COPY` lists
  for `threads`/`thread_entries` have no `tsv`, and after restore e1's `tsv` is
  `'forecast':2 'zebrafish':1` and the title's `'q3':1A 'report':2A` (row-for-row equality
  with the source already covered `tsv`). 22/22 with pg_dump 18.6 locally; CI uses 17.

- ac-1: `thread-search.db.test.ts` › "matching": user and assistant text with entry id and
  snippet; stemming, phrase, `-exclude`, `or`; title FTS, partial word (`kuberne`) and typo
  (`kubernetse`) via trigram; non-message entries, tool results, thinking and tool calls not
  indexed; title and payload edits re-index; a 600 KB message appends fine; stop-word-only query
  returns nothing. Hot-path timing as in decision 12.
- ac-2: › "visibility": another user's private and unshared project threads not found; shared
  threads only for `projectIds`; `projectId` filter; Trash; `activeSince`; non-member gets nothing.
- ac-3: › "team isolation": the same user and word in teams A and B, and each team finds only its own
  thread; outside `withTeam` it throws. Catalog and probe suites still green (generated columns on
  existing team tables).
- ac-4: › "ranking and pagination" (7 hits, pages of 3, each exactly once, sorted by score then
  activity) and "snippets are plain text". Title hits rank above body hits (› "matching").
- ac-5: › "input validation" (empty and overlong query, bad uuids, limit > 50, tampered cursor) and
  `thread-search-format.test.ts` (cursor round-trip and rejection, snippet parsing, strict schema).
- ac-6: EXPLAIN (ANALYZE, BUFFERS) as the app role on 2 teams × 100 members, 11,900 threads and
  357k entries (238k searchable) per team; the heavy viewer owns 2,000 threads:
  - visible: Bitmap Index Scan on `threads_owner_activity_idx` (team_id, owner_user_id), 2,000 rows;
  - entries: Index Scan on `thread_entries_search_idx` (team_id, thread_id = v.id) × 2,000 loops,
    40k rows, `@@` as join filter;
  - snippet: PK index scan, 21 loops.
  - Execution: common word 142 ms (cold, 17k buffers read), rare word 83 ms, two words 88 ms, title
    trigram 100 ms, with 20 project ids 90 ms. A 100-thread member scans 1/20 of that.
- Review round 1 re-measure (one viewer, 5,000 threads, one ~100 KB matching message each; old =
  7be7cea, same data and server, 3 runs each):

  | query                   | old      | new                  |
  | ----------------------- | -------- | -------------------- |
  | word, limit 50          | 1,640 ms | 1,190 ms             |
  | word, limit 20          | 1,210 ms | 1,010 ms             |
  | phrase, limit 50        | 1,650 ms | 1,190 ms             |
  | no hits, limit 50       | 425 ms   | 420 ms               |
  | phrase, `timeoutMs` 500 | —        | `timeout` at ~508 ms |

  The remaining ~1 s is matching and ranking 5,000 × 100 KB tsvectors, the floor of this
  pathological shape; the default 3 s timeout bounds it. Realistic data (decision 12 evidence)
  stays at 83–142 ms.

- Review round 1 tests: › "applies exclusions and phrases to the title trigram path",
  › "per-entry co-occurrence", › "statement timeout" (lock-held table → `timeout`, no SQL in the
  message, caller's team and `statement_timeout` intact), › "input validation" (out-of-range cursor,
  negation-only query → `invalid_input`); `thread-search-format.test.ts` (bigint bounds,
  `splitQuery`).
- `pnpm build test typecheck format:check license:check` green; `lint` green except the
  pre-existing `@kobe/chart` failure (Helm 4 `license` field); `pnpm --filter @kobe/db test:db`
  132/132; `db:check` clean.
