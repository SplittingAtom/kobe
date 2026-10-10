# KOBE-162: 57d: Project files, read-only mounts and agent-proposed adds

- **Status:** in review
- **Branch / worktree:** `kobe-162-project-files-mounts` in `../Kobe-wt162`
- **Depends on:** [KOBE-159](KOBE-159.md) (contract), [KOBE-160](KOBE-160.md) (tables), [KOBE-161](KOBE-161.md) (access),
  [KOBE-27](KOBE-27.md) (workspace sync), [KOBE-71](KOBE-71.md) (uids). No migration.

## Plan

Server: `projects/{files,mounts,proposals}.ts`, file routes in `routes/projects.ts`, `approvals/server-write.ts`
(steps shared with project memory), wire handler `project.file_propose`. Sandbox: sync hardening in
`workspace/fs.ts`, kobe-tools `propose_project_file`, `tools/project-broker.ts`, capability `projects`.

## Decisions

- **Mount mechanism (ac-1): the existing S3-backed workspace sync, hardened, not a new volume or mount.**
  Each member's (team, user) workspace manifest gets one server-origin row per project file under
  `projects/<slug>/<path>` pointing at the project file's own object (no copy per member). The sandbox pulls
  it before every run and every interval (KOBE-27); the agent, which holds the only S3-free, token-free path,
  writes it. Why not a separate emptyDir or bind mount: the workspace volume check (`volume.ts`) and the
  restore/pull logic already treat `projects/` as a server-owned mirror; a second volume would need its own
  device exception in the confused-deputy guard, a pod spec change and a reconcile of its lifecycle, for no
  stronger guarantee than the uid rule below. S3 credentials stay in the server; the sandbox never sees them.
- **Read-only against tools is by uid, not convention.** Under Pi identities (KOBE-71/166) Pi (2000+n) and its
  tools (executor on: partner 3000+n) run as other uids that only hold the workspace group. The agent (uid 1000)
  creates everything in `projects/`: files `0444`, directories `0555` (`0755` while being filled, never group-
  writable). Neither uid can write, create, delete, rename or chmod inside it. Gap fixed here: directories of
  server-owned areas were created `0775` and stayed group-writable until the next `lockServerOwned` (a window
  where a tool could write); `ensureParents` now makes them `0755` from the start.
- **Swapping the whole folder:** the workspace root is group-writable (D13), so a tool can rename `projects/`
  away and make its own. Every write into the area now first moves a top-level area folder that is not the
  agent's (not a directory, or another uid) to `projects.replaced-<random>` (user data, synced as such) and
  rebuilds the real one. Without identities (dev, same uid) the modes are a speed bump, as before.
- **Removal and freshness.** `ProjectMounts.reconcileUser` makes a user's `projects/` rows exactly the files of
  their projects (puts changed, deletes the rest; no-op without a diff). It runs at every `run.start` (delivery,
  before the sandbox pulls), after member add/remove, after a file upload/delete (all members), and after a
  members-mode change (whole team). So a removed member's files are gone at the next run at the latest, and
  mid-run by the sandbox's next periodic pull (`intervalMs`, default 60 s): not instant, no push channel
  exists. Someone who leaves the team gets no rows either. Failures are logged, never block a run.
- **Slugs are safe path components:** DB check `^[a-z0-9][a-z0-9-]*$` (<= 40) and the protocol schema; file paths
  go through `workspacePathSchema` (no `..`, no leading `/`, no control characters); `putServerFile` validates
  again and refuses a key outside `teams/<t>/projects/`. Tested with `../` and absolute folders.
- **Files API:** `GET/POST /v1/projects/:id/files`, `DELETE .../files/:file_id`. Upload streams through a staging
  object (`UploadMeter`, 50 MiB), copies to `<prefix>teams/<t>/projects/<p>/files/<id>`, then one transaction:
  project locked, archived, 500-file cap, name taken, team storage quota, row, audit `project.file_added`.
  Delete: row + audit, mounts reconciled, then the object is deleted. Names/paths never reach the audit log.
  Needs `manage` (owner or team admin); members read. Legal hold refuses delete (409).
- **Agent-proposed add (ac-2):** `propose_project_file` -> kobe-policy -> `project.file_propose` after the file is
  pushed (push-then-propose, like `share_file`). The server (`projects/proposals.ts`) re-checks: capability, run
  active, call allowed with the same input hash (`BOUND_TOOLS`), thread has a project, user is a member, pushed
  entry unchanged. The add needs the signed approval of exactly that input: an approval from the policy check is
  verified and consumed (`approvalHolds`), otherwise the broker asks, the sandbox gets `pending_approval`, and on
  approval the blob is copied server-side (workspace object -> project key), row + audit (`source: proposal`),
  mounts reconciled. Denied/expired/ended: nothing. `auto` mode and scheduled runs are refused at once with a
  `policy.denied` event (D32). No verifier configured: closed. `decide.ts` now leaves `propose_project_file`
  approvals unconsumed for the server (like project `remember`). Refusals: `sandbox.project_file_refused`.
  Idempotent without a table: same path + sha + proposal source + user answers `applied` again.
- **Shared with memory:** `approvals/server-write.ts` holds `hasApproval`, `approvalHolds`, `noPromptCode`,
  `recordDeniedWrite`; `memory/agent.ts` uses them (behaviour unchanged, its tests are the guard).
- **ac-3:** project memory already used `canAccessProject` (KOBE-156/157, REST and wire); one added test shows a
  removed member loses memory and file mount in the same step, and an admin who did not join has neither.
- **Protocol (additive):** `BUILTIN_TOOLS.propose_project_file` (risk write), `ProjectFilePropose(Result)Frame`
  type aliases. The contract itself (KOBE-159) is unchanged.

## Review round (Opus review of #210)

- **Quota (HIGH):** `storageUsed` now adds `SUM(project_files.size_bytes)` once; server-written `projects/` rows
  are excluded from `workspace_sync.live_bytes` (`countedBytes` in `workspace-sync/store.ts`), so members' own
  budgets are untouched. Test: 50 members, usage = one copy, member live_bytes 0.
- **Symlink swap (HIGH):** area roots are opened once with `O_DIRECTORY|O_NOFOLLOW` (`holdAreaRoot`), checked for
  type, device and agent uid; a symlink or foreign folder is moved aside; mkdir/chmod/rm/lock below it go through
  `/proc/self/fd/N` and `fchmod` on the handle (path fallback where /proc is missing). Below the root every dir
  is agent-owned and not group-writable, so only the root's name can be swapped. Tests: `fs.test.ts`, real-helper
  "a symlink swapped in for projects/". The sticky bit on /workspace was not set: the mount root is not ours to chmod.
- **Archived projects (MEDIUM):** stay mounted, read-only. Spec CE19/KOBE-161: archive = retirement, content stays
  readable (shared threads of archived projects stay readable too); only new adds are refused (`archived`).
- **Failed reconcile (MEDIUM):** each user's reconcile is one transaction (all or nothing). Reconcile methods now
  report success; the file object is deleted only when every member's workspace was updated, so a row never
  points at a deleted object; the next run start heals the stale row. Test with an injected failure.

## Open questions (for Chris or the coordinator)

- The sandbox does not yet apply `run.start.project` instructions to the prompt (no ticket in this PR's scope);
  the agent now announces `projects`, so the server already sends them.
- Orphans: a crash between row delete and object delete leaves an object nothing references (no sweep for the
  `projects/` key tree); `kobe backup` cross-check does not flag it.
- Real-helper test `workspace/projects.readonly.real.test.ts` needs Linux + sudo (`test-identities.sh`, runs in
  CI's `ci.yml`); it was not run on this Mac.

## Evidence

| Criterion                                    | Test                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 read-only vs tools, executor on and off | `sandbox-agent/src/workspace/projects.readonly.real.test.ts` (real helper: Pi uid and partner uid cannot write, create, delete, rename, chmod; folder swap is undone); `fs.test.ts` (dirs never group-writable, swapped root moved aside); `sync.test.ts` "keeps project files read-only" |
| ac-1 members only, removal                   | `server/src/project-files.db.test.ts` "mounts under projects/<slug>/ for members only...", "mode team...", "every run start..."                                                                                                                                                           |
| ac-1 API, slug/path safety                   | `project-files.db.test.ts` "lets owners and admins add and remove files..."                                                                                                                                                                                                               |
| ac-2                                         | `server/src/project-propose.db.test.ts` (approval, deny, unchecked/forged, capability, non-member, stale push, auto/schedule); sandbox `tools/project-broker.test.ts`, `kobe-tools/project-tool.test.ts`                                                                                  |
| ac-3                                         | `project-files.db.test.ts` "one membership decides files and memory"; existing `memory.db.test.ts`, `memory-agent.db.test.ts`                                                                                                                                                             |
