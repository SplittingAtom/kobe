# KOBE-585: Add to project: an artifact version or a workspace file becomes a read-only project file

- **Status:** in review (PR #488)
- **Branch / worktree:** `kobe-585-add-to-project` in `../Kobe-wt585`
- **Depends on:** none (workspaces lane WS-2; lane brief on `docs/workspaces-lane`, PR #486)

## Plan

1. Protocol: `canAddToProject` beside `projectPermissions`, `importProjectFileRequestSchema`,
   error code `file_exists` (additive, `packages/protocol/src/projects.ts`).
2. Server: `POST /v1/projects/:id/files/import` (`routes/projects.ts`, logic in
   `projects/import.ts`): artifact version (`findVersionBlob` + `readArtifactBytes`, the Edit as
   file loader) or the caller's own synced file (`currentEntry` + workspace store) through
   `uploadProjectFile`; mounts reconcile for every member. `readArtifactVersion` (serve.ts) tells
   missing from too large. `projectRoutes` now takes the
   workspace store (`app.ts`, one line).
3. Audit: `project.file_added` gains optional `importedFrom` (ids only).
4. Web: `components/projects/add-to-project.tsx` (action + dialog) on the artifact header, the file
   tab header and the `open_file` card, owner only.
5. gate1 spec `e2e/browser/tests/add-to-project.spec.ts`; docs.

## Decisions

- **Editors are builders** (Chris 2026-11-08, via the coordinator): rights = team admins, project
  owners, project members with team role `builder`, and the content's owner when a project member.
  Encoded once in `canAddToProject`; a future editor scope/role changes only that function.
- **No migration.** `project_files_source` CHECK allows `upload | proposal` only, so imported files
  are `source: "upload"`; the audit row carries `importedFrom` (`{kind: artifact, artifactId,
version}` or just `{kind: workspace_file}`: no path, name or hash of one, review of PR #488). Follow-up: a migration may add `import`
  plus a source-thread column, which the "Imported from <conversation title>" label on project
  pages needs (not built: no column holds the thread today).
- **Clash code** `already_exists` (409), the upload route's own (review of PR #488: no second code
  for one condition; the ticket said `file_exists`). Add as copy computes the first free `-N` from
  the project's file list and sends one request (retries only on a 409 race).
- **A non-member is 404, not 403.** The coordinator asked for 403 for "a plain member who owns the
  content but is not a project member"; every project route answers 404 to anyone who may not view
  a project (non-members cannot tell it exists), so the import does too. The db test asserts the
  refusal (404) and no audit row. 403 is for members who may view the project but lack the right
  (e.g. a plain member reading someone else's shared artifact).
- Order of refusals: project 404 → archived 409 (before any source is read) → source 404
  (artifact not readable or its blob purged/outside the thread tree, path not in the caller's
  manifest or agent-internal) → right 403 → name 422 → copy (413 over the artifact cap or the file
  cap, 503 only on a storage error).
- Default name: artifact `<artifactFileStem(title)>.<ext>` (`@kobe/protocol`, shared with the web
  and Edit as file), file = its base name. The stored MIME comes from the artifact's kind/language
  (`artifactMimeType`); for a workspace file from its extension, else octet-stream.
- Web: the action is absent for readers (read-only thread), not disabled. Projects offered = the
  caller's non-archived listed projects (members, or all for admins), each passing
  `canAddToProject(…, contentOwner=true)`. No toast system in the chat: the dialog shows
  "Added to <project> as projects/<slug>/<path>" with a link to `/me/projects/<id>`.
- `docs/ledger/workspaces-lane.md` is not on main yet (PR #486): evidence stays here for the
  coordinator to carry over.

## Open questions (for Chris or the coordinator)

- ac-3's gate1 run needs this build deployed to gate1; the spec is written, not yet run there.
- Should a migration add `source: "import"` and the source thread (for the "Imported from" label)?

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/project-import.db.test.ts` (9 tests: owner copy + audit ids only,
  409 `already_exists` + rename, purged 404 / too large 413, per role admin/owner/builder/member/outsider, unknown version/other
  team/bad names, archived, workspace file own-only + internal paths); `packages/protocol/src/add-to-project.test.ts`
  (role matrix incl. builder); `services/server/src/projects/import.test.ts`.
- ac-2: mounts for every member and nobody else, read-only PUT 403 (same db test, second
  describe); web `apps/web/components/projects/add-to-project.test.tsx` (artifact header, file
  card, file tab, Add as copy, absent for readers).
- ac-3: `e2e/browser/tests/add-to-project.spec.ts` (to run on gate1 after deploy);
  docs/file-editing.md §3f, docs/audit-log.md `project.file_added` row; verify + CI: see PR.
