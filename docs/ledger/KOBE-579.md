# KOBE-579: Workspaces WS-4: server commits (checkout, commit, update, discard, history, revert, quotas)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (coordinator pushes and opens the PR)
- **Branch / worktree:** `kobe-579-server-commits` in `../Kobe-wt579`
- **Depends on:** KOBE-576 (protocol), 577 (tables), 578 (access, mounts), 580 (sandbox contract).
  No migration.

## Plan

Server only. New modules: `projects/tree.ts` (trees, diff, diff hash, `writeCommit`, counters,
blob keys and queueing), `projects/checkouts.ts` (checkout, working-copy diff, Update, Discard),
`projects/commits.ts` (plan, hash-verified copy, write; revert; preview for the agent),
`projects/history.ts` (list, detail, file at commit, head zip), `projects/storage.ts` (object
budget, history rule, storage view, settings), `routes/project-commits.ts`,
`sandbox-wire/project-commit.ts`, `retention/project-history.ts`, `retention/export-projects.ts`,
`workspace-sync/checkouts.ts`, `openapi/project-commits.ts`.

## Decisions (spec silent: smallest consistent reading)

- **Every write of a project's files is a commit.** Upload, Add to project, `propose_project_file`
  and file removal each write a one-file commit (`Add <path>` / `Remove <path>`, author user) via
  `commitFiles`, so `project_files` always equals the head tree and the 577 hand-off is closed:
  a removed file's object stays (an older commit names it) and is released only by pruning.
- **Commit in three steps** (`commits.ts`): plan (read), copy without a transaction, write under
  the project row lock then the member's workspace lock (CM9), re-planning; a copied key is
  reserved in `retention_blob_deletions` first (due in 6 h) and cleared by the write, so a crash
  leaves nothing the deleter will not take. Copy = `get` → `verifyingStream(sha, size)` → `put`
  (bytes checked before the object completes) rather than an unverified S3 copy. Sources must lie
  in the member's own tree or the project's; destinations are `blobs/<sha256>` from verified ids.
- **Project objects in `retention_blob_deletions`** (no migration): `thread_id` carries the
  project id; the deleter (`retention/blobs.ts`) deletes such a key only inside that project's
  tree, only while no hold covers the team (`memory_legal_hold_covers(team, NULL)`, history's
  rule) and only when no tree entry, head file, live workspace row or hold-history row names it.
  Project delete queues all history keys in the delete's savepoint.
- **Counters (GV2):** recomputed from the trees after each commit/prune (`refreshProjectStorage`):
  live = distinct objects of the head tree, history = distinct objects only older commits name.
  `storageUsed` now counts `projects.live_bytes + history_bytes` instead of `project_files`.
  Objects used = scratchspaces' `blob_count` + unattached `files` + project objects. The object
  budget is checked on commits and project uploads under the team storage lock, and (coordinator
  2026-11-08) on a sync push's new blob, a Files upload and an FE4 save of new content as a soft
  check (`teamObjectsAllow`, uploads in flight counted): 507 `quota_exceeded {limit: objects}`.
- **Working-copy bytes:** `countedBytes` keys on the object, not the path: a row naming a project
  object counts 0 (shared, counted once in the project), anything else counts (a push, save or
  upload in a checkout counts against the member, GV2). Moves keep bytes unchanged.
- **Read-only rule:** `isReadOnlyPath(path, checkouts)`; the save, upload, delete and move routes
  pass the caller's checkout slugs. Agent paths (propose_file_edit, notebooks, conflict reports)
  pass none: project folders stay read-only there. Checked before the write (a Discard racing a
  save can leave a stray row that the next reconcile replaces).
- **Diff** compares sha256 and the executable bit; mounts now carry the head tree's bit
  (`mounts.ts` joins `project_tree_entries`), so a checkout has no phantom changes.
- **Update** lists the conflict copies as workspace paths (`projects/<slug>/a.conflict-…md`);
  a path the member deleted and the head changed gets the head's version, no copy.
- **Commit refusals:** `.conflict-` anywhere in a basename (422 naming the file), >500 files,
  file size (min of 50 MiB and the upload limit), archived (409), no checkout (409
  `checkout_required`), legal hold on a delete of `project_files` (409 `forbidden`).
- **Agent commit (CM6):** `commit_project` is in `SERVER_APPROVED_TOOLS`: when the engine
  requires approval, the policy check answers `allow` and marks the call deferred; the frame
  handler asks for an approval over `{project_id, base_seq, message, diff_sha256}` and commits on
  grant only if base and hash still match. A policy rule that allows the call commits at once.
  `isProjectWrite` includes `commit_project` (the server consumes the approval). Repeat while
  pending → `pending_approval`, no new approval. D32 via `noPromptCode` (+ `policy.denied`, and a
  skipped-action row for scheduled runs).
- **Revert** audits only `project.commit_reverted` (not also `project.committed`).
- **Export (GV5, coordinator 2026-11-08):** Kobe's only retention export is member-scoped, so it
  carries every project the member may read (team admins: all): `projects/<slug>/commits.json`
  (newest 1000) + `head/<path>`. Head zip `GET /v1/projects/{id}/download` for readers (they can
  read every file anyway).
- **Settings:** `PUT /v1/team/storage` (`team.projects.manage`) writes `teams.settings`
  `projects.history_keep` / `projects.max_mounted_per_member` and
  `team_storage_quotas.max_objects`; new audit event `project.storage_settings_changed`.
  Chart values `server.uploads.teamMaxObjects` (2 000 000) and `projectHistoryMaxCommits` (1000).
  No chart default for `history_keep` yet (absent = all).
- **Discard** needs only `view`.
- **Losing edit ends the checkout (coordinator 2026-11-08):** made reader, editor row removed from
  a workspace project, or team admin demoted → `endCheckoutsWithoutEditInTx` (audit
  `project.checkout_discarded {reason: access_lost}`, new enum value), then `reconcileUser`.

## Review fixes (coordinator, 2026-11-09)

- "A rule allowed it" is a positive mark on the allowed-call entry (`AllowedArtifactCalls
.ruleAllowed`); a deferred approval, a missing or an evicted entry asks for one (fail closed).
  The pending set is taken in the same synchronous step as its check.
- Commit sources: the member's tree, the workspace's `uploads/` tree, or any project of the
  workspace the member may view (files moved between checkouts keep their object); hash and size
  always verified. After a commit the member's rows are repointed at the project's copy.
- `.conflict-` refused only on added/modified paths. Quota refusals are 507 (commits, project
  uploads; protocol comments still say 413: informative, left for a protocol PR).
- The checkout is re-read under the workspace lock in the write's transaction for save, Files
  upload, move and delete (as the sync push). `max_objects` may only be set at or below the site
  default (400 above). `teamMaxObjectsDefault` threaded to project uploads, imports and
  proposals; notebook saves use the store's default via `saveWorkspaceFile`.
- `/v1/uploads` refuses past the object budget: 507 `quota_exceeded`, message names the object
  budget (no `limit` field: `uploadErrorSchema` is strict, so it would need a protocol change).
- Tests split: `project-commits` (ac-1, refusals, sources), `project-commit-sync` (ac-2, quotas,
  storage), `project-history` (losing edit, export, pruning); shared
  `testing/project-commits-fixture.ts`; units `artifacts/allowed.test.ts`,
  `workspace-sync/checkouts.test.ts`.

## Open for 581 / 582

- **Routes and shapes (581):** as in 581's ledger, plus: `GET /v1/me/checkouts` answers 200
  `{checkouts: []}` when none (not 404). Head zip is `GET /v1/projects/{id}/download` (not
  `/archive`). `GET /v1/team/storage` answers **snake_case**: `used_bytes, used_objects,
quota_bytes, max_objects, default_quota_bytes, default_max_objects, live_bytes, history_bytes,
live_objects, history_objects, history_keep {mode[, n]}, history_max_commits,
max_mounted_per_member, scratchspaces[{user_id, live_bytes, live_files, objects}],
projects[{project_id, slug, name, commits, live_bytes, history_bytes, live_objects,
history_objects}]`; 581's `lib/admin/api/team/storage.ts` reads camelCase and must map. `PUT`
  takes any of `history_keep`, `max_mounted_per_member`, `max_objects` (null = default) and
  answers the view. Quota refusals carry `limit`; Update's `conflict_paths` are workspace paths.
- **582:** remove `propose_project_file` (keep `SERVER_APPROVED_TOOLS`, `isProjectWrite`'s
  `commit_project`); the browser spec can rely on uploads appearing in History as commits.
- A deleted project's objects named by a member's
  moved-out row are kept (and leak once that row goes).

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/project-commits.db.test.ts` "runs the whole cycle…" (checkout → FE4
  save + Files upload → commit 2 tree/diff/`blobs/<sha>`/project_files/counters/audit; bob's
  stale base → 409 `commit_conflict {head_seq: 3}`; Update: untouched `d.md` arrives, `a.md`
  conflict copy, copy refused by name, then nothing to commit; Discard restores the head; Revert
  to 1 = new commit 4 with tree of 1); restricted 404s in the same file.
- ac-2: same file, "the sandbox pushes into a project folder only with a checkout": `read_only`
  without, applied with, pull `checkouts` on the page, other slugs and other members refused,
  relock observed by the next pull after Discard.
- ac-3: `services/server/src/project-commit-agent.db.test.ts` (approval over the canonical input
  with the diff hash, repeat while pending, commit as agent with thread/run, changed working copy
  commits nothing, rule allows without approval, no policy check / no checkout refused, `auto`
  refused with `policy.denied mode_auto_not_allowlisted`, reader refused); run.start access read
  vs write: `project-roles.db.test.ts` (KOBE-578).
- ac-4: `project-commits.db.test.ts` quota (bytes, objects, nothing attributed on refusal),
  storage view + settings (audited), pruning (commits rule keeps head + checkout base, hold keeps
  all, released object queued and deleted by the blob deleter, workspace-named object kept,
  days and hard cap, `project.history_pruned` counts); object budget on push, Files upload and
  save; losing edit ends the checkout; export of readable projects (same file).
- Checks: see the final report of this ticket (unit, db suites, typecheck, lint, format, wording).
