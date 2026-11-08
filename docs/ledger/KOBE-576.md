# KOBE-576: Workspaces: Protocol shapes (`packages/protocol`) (WS-1)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (coordinator pushes and opens the PR)
- **Branch / worktree:** `kobe-576-workspaces-protocol` in `../Kobe-wt576`
- **Depends on:** none (spec `docs/specs/workspaces.md`, WS-1 in §15)

## Plan

Additive, strict shapes in `packages/protocol` only; the server and web get the smallest bridge that
keeps `pnpm typecheck` green until KOBE-577 (database), 578 (server) and 581 (web) land.

## Decisions

- `teamRoleSchema` = `team_admin | contributor | member`; `TEAM_ROLES` constant. `builder` is NOT
  accepted on input (MG0, coordinator review): no input schema. The DB-to-wire mapping stays in the
  server bridge.
- `projects.ts`: `projectVisibilitySchema` replaces `members_mode` everywhere (project, create,
  update, members response); no compatibility shim (MG0). `projectRoleSchema` = `owner | editor |
reader`. `projectPermissions(teamRole, projectRole, visibility)` per PR3; actions are `create,
view, converse, edit, manage, manage_members` (`use` is gone: `converse` is its reader-level
  successor). `effectiveProjectRole` exported. `create` ignores the project (team role only).
- `canAddToProject(teamRole, projectRole, visibility)` is now exactly `edit` (editor, owner, team
  admin). The old `contentOwner` argument is dropped. Behaviour change: a member without a row can
  no longer add to a workspace-visibility project (they are an implicit reader); matches PR3.
- `Project` gains `visibility`, `head_commit_id`, `live_bytes`, `history_bytes`, `live_objects`,
  `history_objects` (nullable) and keeps `my_role` (owner|editor|reader|null).
- Create: `member_user_ids` is only valid with `visibility: "restricted"` (as the old
  `selected` rule). `addProjectMemberRequest.role` stays optional (server picks the default).
- New `packages/protocol/src/project-commits.ts` (exported from the index; kept out of `projects.ts`
  for size): constants (`PROJECT_COMMIT_MESSAGE_MAX` 500, `PROJECT_HISTORY_MAX_COMMITS` 1000,
  `PROJECT_MOUNTS_MAX_PER_MEMBER` 20, history page 50/200), `PROJECT_AUDIT_EVENTS` (7 names),
  `PROJECT_COMMIT_ERROR_CODES` (`commit_conflict`, `nothing_to_commit`, `too_many_mounts`,
  `checkout_required`, `commit_not_found`) spread into `PROJECT_ERROR_CODES` (`quota_exceeded` and
  `read_only` already there). Typed error bodies: `commitConflictErrorSchema {head_seq}`,
  `projectQuotaErrorSchema {limit: bytes|objects}`, `tooManyMountsErrorSchema {limit}`.
- Records: `projectCommitSchema`, `projectTreeEntrySchema`, `projectCheckoutSchema`
  (`base_commit_id`/`seq` nullable: a project with no commit yet). Requests/responses: checkout
  (empty body), `projectCheckoutsResponseSchema` (owners' "Working copies", adds `user_id`), commit
  `{message}` -> `committed {seq, commit_id} | nothing_to_commit` (conflict is the 409 body),
  update -> `{base_commit_seq, conflict_paths}`, history query (`before`, `limit`, coerced from the
  query string) and page (`next_before`), commit detail (commit, tree, diff added/modified/deleted
  with sizes), revert `{message?}` answering like a commit. Discard is 204, no schema.
- Sandbox wire: `run.start.project.access` (`read|write`, optional, on `runProjectContextSchema`);
  `workspaceManifestPageSchema.checkouts` (`workspaceCheckoutRefSchema`, default `[]`, so the
  parsed type always has it); frames `project.commit` / `project.commit_result` (result carries
  `outcome`: committed `{seq}`, commit_conflict `{head_seq}`, nothing_to_commit, pending_approval)
  in `project-frames.ts`; kobe-tools op `project.commit` and its ok/fail response in
  `kobeToolsRequestSchema` / `kobeToolsResponseSchema`. `propose_project_file` shapes untouched.
- Tool: `commitProjectToolInputSchema {message}`, in `PROJECT_TOOLS`/`projectToolInputSchema`, and
  `commit_project` in `BUILTIN_TOOLS` (kobe, write, primary arg `/message`; policy test updated).
  Registration only with `project.access: "write"` is KOBE-580's.
- PJ2 `listProjectsQuerySchema` (`role=editor`, `include_archived`) and PR5 `transferOwnerRequestSchema
{user_id}` / `transferOwnerResponseSchema {project_id, owner_user_id, previous_owner_user_id}`
  live in `project-commits.ts`.
- `slug` in `projectCheckoutSchema` and `workspaceCheckoutRefSchema` repeats the slug regex instead
  of importing `projectSlugSchema` (it would make `projects.ts` and `project-commits.ts` circular).

## Compile fallout (touched only to keep `pnpm typecheck` green)

Database still has `builder`, `members_mode` and role `member`, so two throwaway bridges:

- `services/server/src/authz/team-role.ts` (new): `toProtocolTeamRole` maps `builder` to
  `contributor`; used at the actor/permission call sites: `routes/{approvals,runs,usage,
thread-notebooks,thread-compact,thread-branch-summary,projects}.ts`, `projects/import.ts`.
- `services/server/src/projects/compat.ts` (new): `visibilityOf`/`membersModeOf` and
  `roleFromDb` (member -> editor)/`roleToDb` (editor and reader -> member; the reader distinction
  needs the KOBE-577 migration). Applied in `projects/{access,repository,import}.ts` and
  `routes/projects.ts`; `effectiveRole` now yields an implicit `reader` (was `member`); the add
  member default role is `editor`; `threads/references.ts` uses `can.converse`.
- Interim reader refusal: `POST/PATCH members` with `role: "reader"` answers 422
  `role_not_supported_yet` (it would read back as editor) until KOBE-577; tested in
  `projects.db.test.ts`.
- Web: `lib/projects/api.ts` translates at the edge (sends `visibility` and `editor`; reads
  `visibility` into `membersMode` and editor/reader into `member`); labels stay for KOBE-581.
  `components/projects/{projects-page,project-detail-page}.tsx` pass the new third argument
  and map `builder`/`member` inline. The web's own types (`membersMode`, `TeamRole` with
  `builder`) stay until KOBE-581.
- Db tests updated to the new request and response shapes (visibility, editor, reader); the orbit
  export fixture `minimal.yaml` regenerated for `commit_project`.

## Open for 577 / 578 / 579 / 580 / 581

- 577: define the 7 audit events from `PROJECT_AUDIT_EVENTS`; the migration maps `members_mode`
  to `visibility` and `member` rows to `editor` (MG2, MG3); rename the enum value (MG1).
- 578: delete `authz/team-role.ts`, `projects/compat.ts` and the web edge translation; `403 read_only` for readers; restricted projects 404.
- 579: commit routes use the schemas here; `commit_conflict` is HTTP 409 with `head_seq`,
  `nothing_to_commit` is a 200 status; quota refusals carry `limit`.
- 580: read `checkouts` from the manifest page; register `commit_project` only for
  `project.access === "write"`; treat absent `access` as read.
- 581: replace `membersMode`/`builder` in `apps/web/lib` with visibility and contributor.

## Open questions (for Chris or the coordinator)

- `PROJECT_COMMIT_ERROR_CODES` includes `commit_not_found` and `checkout_required` beyond the
  spec's list; drop if 579 prefers `not_found`.

## Evidence (acceptance criteria -> test or command output)

- ac-1: `packages/protocol/src/project-commits.test.ts`, `projects.test.ts`,
  `add-to-project.test.ts`, `policy.test.ts`; `pnpm --filter @kobe/protocol test` 1178 passed;
  `pnpm typecheck` 26/26.
