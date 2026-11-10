# KOBE-586: Promote a My files folder to a project (PF1-PF6), mount on create (PF5)

- **Status:** in review (branch commits; coordinator pushes and opens the PR)
- **Branch / worktree:** `kobe-586-promote-folder` in `../Kobe-wt586`
- **Depends on:** wave 1 (KOBE-587, 588, 589) and KOBE-590 (Files lists every project)

Authoritative: `docs/specs/projects-in-conversations.md` §8 (PF1-PF6). The ticket's visibility
field is gone (§7): the dialog asks for the name only.

## Plan (as built)

- **Protocol** (`packages/protocol/src/projects.ts`): `promoteFolderRequestSchema` (strict
  `{ path, name }`), `promotedFolderMessage(path)` = "Imported from My files/<path>".
- **Server** `POST /v1/projects/from-folder` (`routes/project-from-folder.ts`, logic in
  `projects/promote.ts`), mounted with one line in `app.ts`; OpenAPI in
  `openapi/project-commits.ts`, `openapi.json` regenerated.
  - `team.projects.create` via `decide(teamRole).can.create`: members 403.
  - Three steps like the commit (`commits.ts`): plan (read) → copy (no transaction, keys reserved
    in `retention_blob_deletions` first, `copyVerified` hash/size) → write. The write takes the
    Delete's locks (legal hold, then the member's workspace), plans again (same files, else
    another round, at most 3, then 503 `busy`), the team storage lock and quota, then in one
    savepoint: `createProject` (pre-chosen id, slug from the name with the existing
    `-2`, `-3` rule; `project.created`), `writeCommit` (one commit, `author_kind user`,
    `project.committed`) and the folder's Delete (`workspace-files/delete.ts`, now shared with
    the Files panel's Delete route; tombstones the sandbox pulls, `workspace.file_deleted`).
    Any failure rolls all three back; reserved blobs are collected by the blob deleter.
  - After the transaction: `projectMounts.reconcileUser` for the creator.
  - The folder is read from the caller's own manifest only (`listLive`/`currentEntry` with the
    session's owner; `sourceCheck` from `commits.ts` keeps copy sources to the member's tree).
- **PF5 mount on create** (`projects/mounts.ts openProjects`): see Decisions; `POST /v1/projects`
  now reconciles its creator; `membersOf` includes `created_by` so file changes reach them.
- **Web**: `promote-to-project` command (file-menu), `lib/projects/promote.ts` (who/where/name
  rule), `components/files/promote-dialog.tsx` (name only, prefilled, server errors in the
  dialog), `file-browser.tsx` (menu item on My files folders when `canCreateProjects`; after
  success: projects reloaded, tree relisted, Projects revealed, focus on the new row,
  `onPromoted`), `workspace-rail.tsx` (role of the active team from `useMyTeams`),
  `use-conversation-project.ts` `offerProject` (a new conversation with no project takes it as
  its draft project; `ChatSession.projectsChanged()` makes the project controls list again).

## Decisions

- **PF5 rule (spec silent beyond "mount at once"):** the creator keeps a project mounted while
  they have no thread of their own in it, live or in Trash (`projects.created_by`; no
  migration). Their first conversation hands the mount to MT1, so trashing it unmounts as
  usual. Moving their only thread out brings the creator mount back (they then have no thread
  in it). Such mounts neither count toward nor exempt from the mount cap (MT3,
  `mountCapRefusal` uses `creatorRule: false`). Spec §8 PF5 got a one-paragraph note.
- Atomicity: the folder's Delete runs in the same transaction as the project and commit, after
  both (stronger than "after": a failed delete also undoes the project).
- Refusals and answers: member 403 `forbidden`; outside My files (uploads, projects) 422; an
  internal path 404 (hidden, as the Files routes do); a file 422 "That is a file, not a folder";
  an unknown or empty folder 422 "This folder is empty; create the project from Projects
  instead" (folders exist only through files, so another member's folder answers the same);
  > 500 files 422; a file over `min(PROJECT_FILE_MAX_BYTES, upload max)` 413 naming it; a
  > path the project rules refuse or a `.conflict-` copy 422 naming it (as the commit); quota 507
  > `quota_exceeded {limit}`; legal hold 409 `legal_hold` (the Delete would be refused);
  > storage/copy failure 503.
- The quota counts the copied objects (as the commit does), though the member's own objects are
  freed by the workspace collector afterwards.
- No new audit event (created, committed, file_deleted exist): no `docs/audit-log.md` change.
- No migration.

## Open questions (for Chris or the coordinator)

- A creator who never converses in their project keeps it mounted indefinitely; an explicit
  "Unmount" or a time limit could follow if scratchspaces fill up.
- Gate1 browser spec step (ac-4) belongs to KOBE-593 (the lane's browser spec).

## Evidence (acceptance criteria → test or command output)

- ac-1 menu and dialog: `apps/web/components/files/promote-folder.test.tsx`,
  `promote-dialog.test.tsx`, `lib/projects/promote.test.ts`, `components/shell/rail-files.test.tsx`
  (contributor sees it, member not; draft takes the project).
- ac-2 one commit, owner, mounted, folder gone; ac-3 refusals leave everything as it was:
  `services/server/src/project-promote.db.test.ts` (permission matrix, every limit, tampered
  blob, legal hold, quota bytes and objects, slug conflict, audit rows).
- PF5: `project-promote.db.test.ts` (mount on create, handed to MT1), `project-mounts.db.test.ts`
  (updated: creator mounted at once; cap unaffected).
- Protocol: `packages/protocol/src/promote-folder.test.ts`. OpenAPI: `openapi/document.test.ts`.
