# KOBE-154: 56b: Migration: memory_docs, versions and memory switches

- **Status:** in progress (PR below)
- **Branch / worktree:** `kobe-154-memory-migration` in `../Kobe-wt154`
- **Depends on:** KOBE-37, KOBE-142, [KOBE-153](KOBE-153.md) (contract)

## Plan

Migration-only (spec D24): `schema/memory.ts`, `0073_memory` (generated), `0074_memory_rls` (custom),
`tenancy/workspace.ts`, probe fixtures, `BLOB_REF_COLUMNS`, `BREAK_GLASS_READABLE_TABLES`,
`memory.db.test.ts`, catalog quals. No server, web or sandbox code.

## Decisions

- **Tables:** `memory_docs` (PK `team_id,id`; `scope` user|project; `owner_user_id` set iff user;
  `project_id` set iff project; `path`; `current_version`; `deleted_at` soft delete; timestamps),
  `memory_doc_versions` (PK `team_id,doc_id,version`; `blob_ref`, `size_bytes` 0..65536, `sha256`,
  `actor_kind` user|agent, `actor_user_id`, `run_id`, `tool_call_id`; FK to doc ON DELETE CASCADE;
  immutable trigger), `team_memory_settings` (`memory_enabled`, `project_memory_enabled`, both default
  true; no row = both on). Checks mirror the protocol path rules (relative `.md`, 1-4 segments,
  <= 200 chars, no `..`).
- **Project identity:** key on `(team_id, project_id)`; `project_id` null for personal docs, no FK
  until KOBE-160 creates `projects` and adds it (as `threads.project_id`). Uniqueness is two partial
  unique indexes (user: `team,owner,path`; project: `team,project,path`), deleted rows included, so
  re-creating a deleted path revives the row. Personal memory is per (user, team) by `team_id` +
  `owner_user_id`.
- **Content in S3, not Postgres:** spec data model (`memory_docs ... blob_ref`), ticket ac-2 and
  `artifact_versions` do the same; keeps the always-loaded index out of row bloat, versions are
  content-addressed objects so Undo is a pointer copy, and backup cross-checks `blob_ref`. Key
  suggestion `teams/<team>/memory/<doc>/<version>`; deliberately **not** `thread: true` (no thread
  tree; the thread purge must not delete memory). Registered in `BLOB_REF_COLUMNS`.
- **Install switch:** an `install_settings` key (`MEMORY_INSTALL_ENABLED_KEY = "memory.enabled"`,
  absent = on), no table; effective = install AND team (as retention's maximum).
- **`run_id` on versions has no FK:** purging a run (retention) must neither block on nor delete
  memory history; the id is a historical reference.
- **Break-glass: yes** (decided by the spec, not discretion). D24 "Memory follows team retention,
  break-glass, and legal hold"; D5 line "Install admins cannot read team content (threads, files,
  memory, artifacts) except through break-glass". `break_glass_read` (SELECT only) on `memory_docs`
  and `memory_doc_versions`, in `0074`: team grant = all team memory; user grant = that user's
  personal memory (project docs have no owner, so excluded); thread grant = none (memory belongs to
  no thread). `team_memory_settings` is configuration: team policy only. Both tables are in
  `BREAK_GLASS_READABLE_TABLES`; exact quals pinned in `catalog.db.test.ts`.
- **Legal hold:** statement-level delete guard + truncate guard on both tables. Docs keyed on owner;
  a project doc (no owner) is covered by ANY active hold in its team (conservative: a user-only hold
  must not let project memory go). Version guard follows the doc's owner and skips rows whose doc is
  already gone (cascade; the docs guard decided in the same statement). Soft delete is an UPDATE and
  stays allowed.
- **Retention (D24 "follows team retention"):** not decidable in a migration. The retention job
  (KOBE-18) only purges thread trees; what "retention" means for memory (age of last version?) is for
  the feature PR.

## Open questions (for Chris or the coordinator)

- Retention semantics for memory (above): purge docs whose newest version is older than the team
  period? Needs a decision before KOBE-155..158 implement it.
- KOBE-160 must add `memory_docs.project_id -> projects(team_id, id)` and decide cascade on project
  delete (legal-hold guard already protects project docs).

## Evidence

- ac-1: `probe.db.test.ts` runs the new fixtures (all three tables, incl. break-glass cases);
  `memory.db.test.ts` covers checks, uniqueness, cross-team FK, cascade, immutability, legal hold,
  break-glass scopes; `catalog.db.test.ts` pins RLS/policies.
- ac-2: `blob-refs.test.ts` green with the `memory_doc_versions.blob_ref` entry.
- ac-3: `team_memory_settings` defaults true (`memory.db.test.ts`); install key constant in schema.
