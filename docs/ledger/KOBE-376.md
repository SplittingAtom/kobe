# KOBE-376: SMA1: Semantic memory schema — split tables (Workspace RLS, portable, Site) and run records

- **Status:** in review (local commit; coordinator opens the PR)
- **Branch / worktree:** `kobe-376-sm-schema` in `../Kobe-wt376` (from origin/main 9cc3c25f)
- **Depends on:** none. v1.3 wave A1, first of the serial migrations; lands alone.

## Plan

Schema only: `packages/db/src/schema/semantic-memory.ts`, migrations `0216_semantic_memory`
(generated) + `0217_semantic_memory_rls` (custom: RLS, immutability trigger), new tenancy area
`tenancy/memory.ts` (+ probe fixtures `testing/probe-fixtures/memory.ts`), tests, an upgrade note
in `docs/install.md`. No feature code.

## Decisions

- **Tables.** Workspace (team tables, canonical `team_isolation` policy, ENABLE + FORCE RLS,
  composite keys): `semantic_memory_items` (scope `user|team`, owner set exactly for `user`),
  `semantic_memory_item_versions`, `run_memory_items` (FK `(team_id, run_id)` → runs and
  `(team_id, item_id, version)` → versions, both cascade). Portable (site-wide, like
  `personal_skills`): `portable_memory_items` (kind = `preference` only) + versions. Site
  (site-wide, like `site_settings`): `site_memory_items` (`policy` flag) + versions.
- **New area file** `tenancy/memory.ts` (the brief named it); `memory_docs` (Notes) stays in
  `workspace.ts`. Grants as personal skills: items full DML, versions SELECT + INSERT only.
- **Versions immutable** via `semantic_memory_versions_immutable()` (invoker rights, pinned
  `search_path`), copied from `skill_versions_immutable` (0051): no UPDATE, no direct DELETE;
  cascades from the item or team pass; a cross-team move is left to RLS (42501).
- **Statement:** 1..500 chars after trimming; `statement_tsv` = `to_tsvector('english'::regconfig,
statement)` stored generated (Q11, no language setting).
- **Policy only in the Site table:** no `policy` column elsewhere and no `policy` kind anywhere.
- **Supersession:** `superseded_by` set exactly when `status = 'superseded'`; self-FK stays inside
  the Workspace (`(team_id, superseded_by)`) or the owner (`(superseded_by, owner_user_id)` on
  portable). NO ACTION, so the replacement can't be deleted alone.
- **Tags:** ≤ 5, no empty/NULL element, ≤ 200 chars total. `as_of` (date) on Workspace and Site
  items (facts/decisions); not on portable (preferences only).
- **Provenance:** Workspace versions carry `pass_id` (exactly when `actor_kind = 'pass'`),
  `source_thread_id`, `source_entry_ids` (≤ 50, need a thread), `evidence` (array/object, ≤ 16 KiB).
  No FKs on pass/thread ids (passes don't exist yet, and purges must not block on history; same
  rule as `memory_doc_versions.run_id`). **Portable and Site versions have no thread links or
  evidence** (walls: those are Workspace content). Site versions take `actor_kind`
  `user|import|proposal` with `proposal_id` (KOBE-402, no FK yet) instead of `pass`.
- `actor_user_id` NOT NULL on every version (a person always clicks save; users are never deleted).
- **Indexes:** GIN tsvector + `gin_trgm_ops` only on `portable_memory_item_versions` and
  `site_memory_item_versions`. Workspace: btree `(team_id, scope, status)` and partial
  `(team_id, owner_user_id, status) WHERE scope = 'user'`; versions use their PK.
- **pg_trgm:** already created by `0013_thread_search.sql` (`CREATE EXTENSION IF NOT EXISTS`,
  trusted since PG 13, so the DB owner can create it); 0216 needs nothing extra.
- No break-glass policy, legal-hold guard or stewards here (KOBE-386 / KOBE-380).

## Open questions (for Chris or the coordinator)

1. `run_memory_items` records only Workspace items (as the brief says). Portable and Site items a
   run used have no record table; if the context viewer / Gate D measurement needs them, a later
   migration adds `run_portable_memory_items` / `run_site_memory_items` (or nullable columns).
2. Portable versions keep no `source_thread_id`/`evidence` (they'd cross Workspaces). Provenance
   of an inferred portable preference then lives only on its candidate (KOBE-389). OK?
3. Legal hold / break-glass coverage of the new tables is left to KOBE-386.

## Evidence (acceptance criteria → test or command output)

- **ac-1:** `probe.db.test.ts` (fixtures for the 3 Workspace tables, raw SQL, no app filters) and
  `catalog.db.test.ts` green; `semantic-memory-upgrade.db.test.ts` "refuses run records and
  replacements that point into another Workspace" (invisible, 23503 composite FK, 42501 RLS).
  `tenancy.test.ts` asserts the split.
- **ac-2:** upgrade test: portable/Site have no team_id and no RLS; app-role privileges exactly
  items = S/I/U/D, versions = S/I; no SECURITY DEFINER anywhere; trigger `search_path` pinned.
- **ac-3:** upgrade test: non-preference portable kinds 23514; `policy` column 42703 outside the
  Site table, `policy` kind 23514; 501 chars and blank 23514 in all three version tables, 500 OK;
  generation expression is `to_tsvector('english'::regconfig, statement)`; stemming
  `'report':4 'run':1 'week':3`.
- **ac-4:** upgrade test lists GIN indexes on the semantic tables: exactly the four on the
  portable/Site version tables. Plans below.

### EXPLAIN plans (app role inside a team, FORCE RLS; 20 Workspaces × 1,000 team + 10 × 300 user items, ANALYZE)

Team scope, active (900 rows):

```
Result  One-Time Filter: (NULLIF(current_setting('kobe.team_id', true), '')::uuid = '<team>')
  ->  Bitmap Heap Scan on semantic_memory_items
        ->  Bitmap Index Scan on semantic_memory_items_scope_idx
              Index Cond: (team_id = '<team>') AND (scope = 'team') AND (status = 'active')
Execution Time: 1.176 ms
```

By owner, active (270 rows):

```
Result  One-Time Filter: (... kobe.team_id ... = '<team>')
  ->  Bitmap Heap Scan on semantic_memory_items
        ->  Bitmap Index Scan on semantic_memory_items_owner_idx
              Index Cond: (team_id = '<team>') AND (owner_user_id = '<user>') AND (status = 'active')
Execution Time: 1.271 ms
```

Selector shape (team OR own items, current version, `websearch_to_tsquery('english', …)`,
`ts_rank`, top 50):

```
Limit -> Sort (top-N heapsort) -> Result (One-Time Filter kobe.team_id)
  ->  Hash Join  Hash Cond: (v.item_id = i.id) AND (v.version = i.current_version)
        ->  Bitmap Heap Scan on semantic_memory_item_versions v  (4000 rows)
              ->  Bitmap Index Scan on semantic_memory_item_versions_team_id_item_id_version_pk
        ->  Hash -> Bitmap Heap Scan on semantic_memory_items i  (1170 rows)
              ->  BitmapOr: semantic_memory_items_scope_idx | semantic_memory_items_owner_idx
Execution Time: 7.243 ms
```

The versions side reads every version in the team (no GIN under RLS, as designed); the version
cap per item (KOBE-378) bounds it.

- Commands: `pnpm verify` green (a first run hit an unrelated sandbox-agent `checkouts.test.ts`
  ENOTEMPTY tmp-cleanup flake; rerun clean); `@kobe/db test:db` 116 files / 1826 tests and
  `@kobe/server test:db` 231 files / 2895 tests pass.
