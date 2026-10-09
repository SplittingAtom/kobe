# KOBE-161: 57c: Projects API, authz and instructions applied to threads

- **Status:** in review
- **Branch / worktree:** `kobe-161-projects-api` in `../Kobe-wt161`
- **Depends on:** [KOBE-159](KOBE-159.md) (contract), [KOBE-160](KOBE-160.md) (tables). No migration.

## Plan

Server only: `projects/{access,repository,run-context,slug}.ts`, `routes/projects.ts` (mounted at
`/v1/projects`), `threads/references.ts` seams implemented, run.start plumbing, audit events.

## Decisions

- **Authz:** every check goes through `loadAccess` -> `projectPermissions(teamRole, effectiveRole)`.
  Effective role = explicit `project_members` row, else implicit `member` in mode `team`, else none.
  Cannot view (or no such project) = 404 for every route; viewing without the action = 403.
  Team admins view and manage all projects (`my_role: null` when not a member).
- **Routes:** `POST/GET /v1/projects`, `GET/PATCH/DELETE /:id`, `GET/POST /:id/members`,
  `PATCH/DELETE /:id/members/:user_id`. Slug immutable; derived from the name with `-2`.. suffixes;
  an explicit taken slug is 409 `slug_taken`. Switching mode to `selected` keeps existing rows
  (owners only in mode `team`): add members first. PATCH on an implicit member in mode `team`
  creates the row (to promote an owner).
- **Delete** is refused (409 `project_in_use`, message lists counts) while threads (any, also in
  Trash), project memory docs or project files exist: matches the RESTRICT FKs, and files go through
  KOBE-162 so their blobs are queued. Archive (`archived: true`) is the normal retirement. The
  contract comment "threads stay, unshared" for DELETE is superseded by the ticket and the FKs.
- **default_agent_id:** validated with `findPinnableAgent` + `canPinAgent` (team, personal, gallery;
  active and published). At thread creation without `agent_id` the project's default is pinned when
  the creator can still start it, else the team default (no error). A personal agent as default only
  works for its owner (open question).
- **Instructions to runs:** `ThreadRow.projectId` -> `projectRunContext` in both plan builders
  (`lifecycle.ts`: new start and recovery restart) -> `StartPlan.project` -> `RunStartRequest.project`
  -> `run.start.project`. Read fresh at every run start (edits apply to the next run). Sent only while
  the thread owner is a project member (not for admin-only access), and stripped in `delivery.ts`
  for agents without capability `projects`. Truncated at 8 KiB on a char boundary with
  `truncated: true` (only an over-long old row; API and DB refuse more).
- **Thread seams:** `viewerProjectIds(tx, teamId, userId)` (signature gained `teamId`) = member
  projects (archived included, so shared threads stay readable); `canCreateInProject(tx, viewer, id)`
  = `can.use` and not archived. Search/list/artifacts/pending already took `projectIds`.
- **Audit** (`project.*`, `docs/audit-log.md`): ids, mode, role, changed field names; never name,
  description or instructions.
- **Memory seam (KOBE-155, PR #146):** not merged; TODO in `projects/access.ts` to use `loadAccess`.

## Open questions (for Chris or the coordinator)

- `project_in_use` is not in `PROJECT_ERROR_CODES` (contract change belongs in its own PR).
- Personal agent as project default: allow (current) or restrict to team/gallery?

## Evidence

- ac-1: `projects.db.test.ts` "instructions reach project runs" (capability, non-member, no project).
- ac-2: "hides selected-mode projects", "enforces owner vs member rules".
- ac-3: "lists and searches shared threads for members only".
