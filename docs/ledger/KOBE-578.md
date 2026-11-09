# KOBE-578: Workspaces: Server — roles, visibility, ownership, mount-on-conversation (WS-3)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (coordinator pushes and opens the PR)
- **Branch / worktree:** `kobe-578-server-roles-mounts` in `../Kobe-wt578`
- **Depends on:** KOBE-576 (protocol), KOBE-577 (database); no migration here

## Plan

Wire the PR3 matrix through `projects/access.ts` (`decide`, `loadAccess`) everywhere; PR4
creation gate; PJ2 list filter; PR5 owner transfer and owner-less listing; PR6 memory write gate;
MT1–MT4 mount-on-conversation with the MT3 cap; PJ3/MT4 offboarding; audit rows.

## Decisions

- **One decision point.** `projects/access.ts` `decide(teamRole, explicit, visibility)` wraps
  `projectPermissions` + `effectiveProjectRole`; `loadAccess`, `listProjects`, the create gate and
  the owner-less route use it. Set queries (lists of viewable ids, mounts) use `viewableBy()`,
  the SQL mirror of `view` (visibility `workspace`, an explicit row, or team admin).
- **Matrix changes vs. before:** uploads and file removal need `edit` (were `manage`); import
  (KOBE-585) is `access.can.edit` (no builder special case; `canAddToProject` no longer used by
  the server, the protocol helper stays); `propose_project_file` also needs `edit` (readers must
  not write into a project through it until WS-7 removes it).
- **Team admins act as owners everywhere (PR3):** they now read/write project memory, read
  threads shared to every project (`memberProjectIds` includes all projects for a team admin),
  and their runs get instructions in restricted projects without a row (`projectRunContext` now
  gates on `can.converse`, was "has a role").
- **`run.start.project.access`** = `write` when the thread owner may edit (editor, owner, team
  admin), else `read`. Not tied to a checkout: the checkout/commit gate is 579/580's.
- **PJ2:** `GET /v1/projects?role=editor&include_archived=` parsed with `listProjectsQuerySchema`
  (strict; `role=owner` is 400).
- **PR5 owner-less listing (spec silent on the shape):** `projectSchema` is strict and a protocol
  change belongs in its own PR, so no flag on `Project`. Instead `GET /v1/projects/no-owner`
  (team admins; others 403) answers `projectListResponseSchema` with the projects that have no
  owner row. The web (581) shows "No owner: assign one" for those ids.
- **PR5 transfer:** `POST /v1/projects/{id}/owner {user_id}` (`manage_members`, project row lock).
  Target must be in the workspace (422 `not_in_team`) and becomes owner. An owner handing over to
  someone else becomes editor (`previous_owner_user_id` = caller); a team admin without an owner
  row assigns and nobody is demoted (null). Transfer to oneself by an owner is a no-op beyond the
  audit row. Audited `project.owner_transferred {toUserId, fromUserId}`.
- **Owner-less arises** only when the sole owner leaves the workspace or is deactivated (MT4
  drops their rows). Last-owner refusals (`last_owner`) on demote/remove unchanged.
- **PR6 memory:** `memory/access.ts` `projectMemoryAccess` → none | read | write. Panel PUT,
  DELETE and restore need write: a reader gets 403 `read_only`. The agent's project `remember` is
  refused `not_allowed` before any approval is asked, with "You can read this project's memory but
  not change it…"; the audit reason is the existing `not_allowed` (no new enum value, no DB
  change). Personal memory unaffected.
- **MT1 mounts:** `openProjects()` = projects with a non-trashed thread owned by the member or a
  checkout, that the member may view, while the member is in the team and not deactivated.
  `desiredFor` skips checked-out projects and the diff ignores every row under a checked-out
  `projects/<slug>/` (never written, never deleted). Archived threads still count (not Trash).
  `reconcileProject` now targets thread owners + checkout holders of the project.
- **reconcileUser triggers:** thread create with a project, move (in or out), trash, restore, fork;
  run start, member add/remove and visibility change as before; team member removal (new, in
  `routes/team.ts`) and deactivation (new lifecycle step `projects` in `deps.ts`).
- **MT3 cap (no migration):** the limit is `teams.settings -> 'projects.max_mounted_per_member'`
  (positive integer) else `PROJECT_MOUNTS_MAX_PER_MEMBER` (20). No chart value and no write route
  yet (smallest reading: the protocol constant is the default; a Workspace settings UI/route can
  write the key later). Refused on thread create and move into a project that is not open yet:
  409 `too_many_mounts {limit}` (`tooManyMountsErrorSchema`); a move excludes the moving thread
  from the count. Restore and fork do not re-check the cap (may exceed it by one; noted).
- **MT4/PJ3:** `projects/offboard.ts` `endProjectStandingInTx` deletes the member's
  `project_checkouts` rows (audit `project.checkout_discarded {reason: member_removed}` each)
  and their `project_members` rows (then `endUnreachableThreadRules`), called from
  `teams/members.ts removeMemberInTx` (also the Skill reviewer grant path). Deactivation runs
  `endUserProjects` in every workspace with the system actor and reason `member_removed`, then
  reconciles. Reactivation does not restore project rows (spec: "drop their explicit rows").
- **Audit:** `project.created {visibility}`, `visibility_changed`, `member_role_changed {to,
roles}` were already written by 577; added `owner_transferred` and `checkout_discarded`.
  `docs/audit-log.md` rows updated for the actual payload semantics.
- **OpenAPI:** only the thread routes are in the document; `too_many_mounts` added to create and
  move. The project routes are not in the OpenAPI document (as before).

## Open for 579 / 580 / 581 / 582

- Review fixes (coordinator): `reconcileProject` also reaches every workspace still holding a live
  row under `projects/<slug>/`, so file removal never deletes an object a stale row names; team
  role changes reconcile the member (a demoted admin loses restricted mounts); losing the
  `skill_reviewer` grant reconciles mounts in the Registry team; `transferOwner` refuses a
  deactivated target (422 `invalid_input`); `policy/live-rule.ts` reuses `viewableBy`.
- 579: a working copy that reuses project objects faces the same delete ordering: never delete a
  project object while any workspace row (checkout or mount) names it.
- 579/581: the mount cap is checked without a lock, so two concurrent project conversations can
  pass it by one (acceptable for a soft cap; lock the member's workspace if it must be exact).

- 579: checkout rows make the project open (mounted) with no thread; reconcile leaves the folder
  alone, so checkout must write the working copy itself and Discard must call `reconcileUser`
  (the head comes back, or the mount goes if no thread keeps it). The cap is not checked on
  checkout (spec only names conversations).
- 579: `GET /v1/projects/{id}/commits*` must use `loadAccess(..., "view")` so restricted 404s hold.
- 580: `run.start.project.access` is always sent now (server built from this branch); an older
  sandbox-agent with a protocol before 576 would reject the strict `runProjectContextSchema`.
  Consider a capability if mixed versions matter (gate1 is reinstalled whole, MG0).
- 581: owner-less = `GET /v1/projects/no-owner` (ids to flag); the cap setting key is
  `projects.max_mounted_per_member` in `teams.settings` (needs a write route + UI with GV3's
  `history_keep`); `too_many_mounts` body has `limit`; readers get 403 `read_only` on memory writes.
- 582: gate1 spec step "member2 sees the imported file" must open a project conversation first
  (MT1); `project-import.db.test.ts` already does.

## Open questions (for Chris or the coordinator)

- Owner-less flag on `Project` (additive protocol field) vs. the separate route chosen here.
- Should restore/fork also enforce `too_many_mounts`? Spec names only "a new project conversation".

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/project-roles.db.test.ts` ("the matrix, row by row": reader converses,
  reads memory, cannot upload/manage/remember; editor uploads; owner re-roles and changes
  visibility with audit; team admin everything; restricted 404 on list, get, files, members,
  upload, owner, memory list/put, thread create, shared thread read and project thread list);
  agent `remember` refusal in `memory-agent.db.test.ts` ("a reader's remember…"); panel 403 in
  `memory.db.test.ts`; run access in `project-roles.db.test.ts` ("run.start.project.access").
- ac-2: `services/server/src/project-mounts.db.test.ts` (first thread mounts, second survives,
  last trashed unmounts, restore/move; checkout folder skipped; restricted reader loses mount on
  removal; leaving the workspace unmounts, discards checkouts, drops rows; deactivation; cap 2 and
  default 20 → `too_many_mounts`). Older mount tests rewritten for MT1 in
  `project-files.db.test.ts`, `project-import.db.test.ts`.
- ac-3: `project-roles.db.test.ts` ("owners (PR5)": last owner stays, owner hands over, team admin
  assigns, owner-less listed to admins and cleared).
- Checks: server unit 2540 passed (one egress config timeout under load, passes alone); server
  db suite 2532 passed, 3 timeouts under load (agent-roster, run-prompt, runs-resolver) pass alone
  (52); `pnpm typecheck`, `pnpm lint`, `pnpm format:check` clean; OpenAPI regenerated.
