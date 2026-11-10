# KOBE-591: PC-4 agent proposals for project files and new My files files; Accept commits

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (built on wave 1, PR #510)
- **Branch / worktree:** `kobe-591-project-proposals` in `../Kobe-wt591`
- **Depends on:** KOBE-587 (every member reads every project; explicit rows owner|editor)

## Plan

Spec `docs/specs/projects-in-conversations.md` §6 PE1-PE7, §9; commit model `docs/specs/workspaces.md` CM1, CM5, CM9.

- Protocol: `file.edit_proposed` gains `proposal_id`, `project_id`, `base_commit_seq`; `base_sha256`
  optional (new file); propose answer's `base_sha256` optional; save query's `base_sha256`
  optional (create only); `POST /v1/projects/{id}/commits/from-proposal` request/response and the
  409 bodies `proposal_stale {head_seq}`, `proposal_not_allowed {reason}`.
- Server: `sandbox-wire/file-edit-propose.ts` (project branch + new files), `projects/from-proposal.ts`
  (accept), route in `routes/project-commits.ts`, OpenAPI, save route create-only mode.
- Sandbox agent: tool description, project access line (PE7), new-file answers.

## Decisions

- **No migration.** Idempotency is derived from the commit itself: a `user` commit by the
  accepting member with the proposal's `run_id` and `thread_id` whose tree has the path at the
  proposed content and whose parent had the base (or no file). The lane brief keeps KOBE-587's
  migration as the lane's only one; the audit log is no lookup store (no index, retention).
- **`proposal_id`** is a server-minted UUID in the event payload (not the model's `tool_call_id`,
  which need not be unique across runs). Optional in the schema so older events still list.
- **Commit message** = edited `message` or the proposal's `summary` (the tool's field is `summary`,
  the spec calls it `reason`; the agent-facing input is unchanged).
- **Role at proposal time:** the run owner's role *now* (PE3), not the `run.start` snapshot.
  Readers: `read_only` "You can read <Project name> but not change it." Archived project: refused.
- **Other projects, a conversation outside any project, `projects/<slug>` itself:** `read_only`
  ("Only files of this conversation's project can be proposed; other projects are read-only.").
  Uploads keep `read_only` (the member's own `uploads/` drop stays proposable, as before).
- **Project path rules:** relative path under the slug; a new file is refused when it is a
  `.conflict-` name or clashes with a file/folder of the head tree (`invalid_path`), when the head
  holds `PROJECT_FILES_MAX` files (`project_full`, new code), or exceeds `PROJECT_FILE_MAX_BYTES`.
  Content equal to the head's file is refused (it would be an empty commit).
- **Base for a project file is the head tree**, also when the member has a checkout (the checkout
  then picks the commit up on Update, CM5).
- **Recorded bytes:** the event's `content` (UTF-8, ≤ 128 KiB, `FILE_EDIT_CONTENT_MAX_BYTES`) is the
  only source; stored at `blobs/<sha256>` through `verifyingStream`, key reserved first; reused
  when the project already holds that content. Mime: sniffed, declared `text/plain`.
- **Order of checks at accept:** thread owner (else 404 `thread_not_found`), proposal in thread
  (404 `proposal_not_found`), project visible (404), proposal for this project
  (`not_a_project_proposal` / `moved`), already accepted → same commit (200), thread still in
  the project (`moved`), editor+ now (`no_edit_access`), archived (`archived`), base
  (`proposal_stale {head_seq}`), limits (422/413/507).
- **"Open":** today reject is client-only (no server state), so a rejected proposal is still
  acceptable through the route by the owner; accepted = idempotent; compacted runs = 404.
- **Legal holds:** a proposal commit only updates/inserts `project_files` rows (the hold guard is
  on DELETE), so it never blocks; tested.
- **My files new files:** `PUT /v1/workspace/file?path=` without `base_sha256` creates the file
  (409 `version_conflict` when a live file exists, 409 `already_exists` for a folder or a path
  inside a file). The web's `proposalFromEvent` maps a missing base to `""` until KOBE-592.
- **Audit:** `project.committed` gains `source: "proposal"` and `proposalId` (docs/audit-log.md).

## Open questions (for Chris or the coordinator)

- Should a server-side "rejected" state exist so a rejected proposal cannot be accepted later via
  the API? Not in the spec; KOBE-592 may want it.

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-2: `services/server/src/project-proposals.db.test.ts` (propose describe),
  `file-edit-propose.db.test.ts`; protocol `file-editor.test.ts` (KOBE-591 describe).
- ac-3: `project-proposals.db.test.ts` (Accept describe: permission matrix incl. reader, editor,
  owner, unlisted team admin, other member 404, other workspace 404; stale edit and stale new file;
  new file; full project; idempotency; audit row; recorded bytes and blob key; legal hold;
  reconcile of a mounted member); `workspace-save.db.test.ts`.
- ac-4: sandbox-agent `file-edit-tool.test.ts`, `memory/project-context.test.ts`,
  `tools/file-edit-broker.test.ts`; `services/server/openapi.json` regenerated; protocol
  `project-commits.test.ts`.
- ac-5: per package (no repo-wide verify, by instruction): see the final report.
