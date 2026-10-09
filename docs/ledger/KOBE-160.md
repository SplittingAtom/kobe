# KOBE-160: 57b: Migration: projects, members, files; threads.project_id FK

- **Status:** in review
- **Branch / worktree:** `kobe-160-projects-migration` in `../Kobe-wt160`
- **Depends on:** KOBE-154, [KOBE-159](KOBE-159.md) (contract)

## Plan

Migration-only (spec D23): `schema/projects.ts`, `0075_projects` (generated), `0076_projects_rls`
(custom), `tenancy/workspace.ts`, probe fixtures, `BLOB_REF_COLUMNS`, `BREAK_GLASS_READABLE_TABLES`,
`projects.db.test.ts`, catalog qual. No server, web or sandbox code. No `db:rebase` (coordinator, at merge).

## Decisions

- **Tables** (PK and every FK carry `team_id`): `projects` (slug unique per team, name, description,
  instructions <= 8192 bytes, `default_agent_id` null, `members_mode` team|selected, `created_by`,
  `archived_at`), `project_members` (PK team, project, user; role owner|member), `project_files`
  (path unique per project, size 0..50 MiB, sha256, mime, `blob_ref`, source upload|proposal,
  `added_by`). Checks mirror the protocol (slug, name, instructions bytes, relative `/` paths).
- **`default_agent_id` has no FK:** the agent may be a team, personal or gallery agent (two tables);
  the server validates. Open if the coordinator wants a team-agent-only FK.
- **FKs added:** `threads (team_id, project_id)` and `memory_docs (team_id, project_id)` -> projects,
  both **ON DELETE RESTRICT**. Why: threads are authors' private content and a shared thread must be
  unshared first, so a hard delete must detach them deliberately (SET NULL would orphan
  `shared_to_project` and silently move held content); project memory is under retention and legal
  hold, so the delete must remove docs explicitly and let the hold guard decide, never cascade.
  Archive (`archived_at`) is the normal retirement. Members and files CASCADE (the files' hold guard
  still refuses). Existing CHECK `threads_test_private` kept.
- **Break-glass:** `project_files` only (D5 lists files and memory as content): SELECT policy shaped
  like `memory_docs`: team grant = all, user grant = files that user added, thread grant = none.
  `projects`/`project_members` are configuration (name, slug, instructions meant for every member),
  like agents: team policy only. One policy to widen if the spec owner disagrees.
- **Legal hold:** `project_files` delete + truncate guards; any active hold in the team covers them
  (shared, ownerless; reuses `memory_legal_hold_covers(team, NULL)`), so a project delete's cascade
  is refused too. `projects` and `project_members` hold no content.
- **Blob registry:** `project_files.blob_ref`, not `thread: true` (key `teams/<team>/projects/<project>/files/<id>`).
  The feature PR must queue blobs before deleting a project.
- Existing tests that used random project ids (`memory.db`, `thread-search.db`) now create projects.

## Open questions

- Memory/thread index on `threads (team_id, project_id)` for the RESTRICT check was skipped
  (rare delete; the partial activity index excludes deleted rows).

## Evidence

- ac-1: `probe.db.test.ts` runs the three new fixtures; `projects.db.test.ts` covers checks, uniqueness,
  cross-team FKs, RESTRICT/CASCADE, holds, break-glass; `catalog.db.test.ts` pins the policy.
- ac-2: no existing rows touched; `journal.test.ts`, `migrate.db.test.ts` green.
- ac-3: `blob-refs.test.ts` green with the `project_files.blob_ref` entry.
