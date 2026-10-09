# KOBE-159: 57a Projects contract: API, roles, share-to-project, instructions context

- **Status:** in review
- **Branch / worktree:** `kobe-159-projects-contract` in `../Kobe-wt159`
- **Depends on:** KOBE-153 (memory), KOBE-147 (files), KOBE-141 (uploads). Blocks KOBE-160..164. Spec D23.

## Plan

`packages/protocol` only, additive, tests first. Code: `src/projects.ts`, `src/sandbox-wire/project-frames.ts`.

## Decisions (dependants must follow these names)

- Capability `projects` (`CAPABILITY_PROJECTS`). Tool `propose_project_file` (`PROJECT_TOOLS`).
- Roles: project role `owner|member` (`projectRoleSchema`); `projectPermissions(teamRole, projectRole)` is the
  one rule (builder/admin create; owner or team admin manage + members; member use). `members_mode`
  `team` (default, everyone implicit member) | `selected`. Slug (`[a-z0-9-]`, max 40, unique per team) is the mount folder.
- REST: `/v1/projects` (POST, GET, `:id` GET/PATCH/DELETE), `/members` (GET/POST, `:user_id` PATCH/DELETE),
  `/files` (GET, multipart POST, `:file_id` DELETE). Threads: create takes optional `project_id`;
  `POST /v1/threads/:id/share {visibility: private|project}` (author); `POST /v1/threads/:id/fork
{entry_id?, title?}` -> `{thread_id}` (new private thread in the same project). Thread summaries may gain
  optional `project_id`, `visibility`, `read_only` (`threadProjectFieldsSchema`; KOBE-161/162 add them to the summary).
  Error codes: `PROJECT_ERROR_CODES`. No event-stream change: read-only is enforced by the API (`read_only`).
- Files: S3, synced read-only to `/workspace/projects/<slug>` (`projectMountPath`, area `projects`, origin `server`).
  Caps: 50 MiB per file (`PROJECT_FILE_MAX_BYTES`), 500 per project.
- **run.start context field: `project`** (`runProjectContextSchema`): `{id, slug, name, instructions, truncated?, mount}`.
  Instructions max 8 KiB (`PROJECT_INSTRUCTIONS_MAX_BYTES`, create/update refuse more, so the server never truncates
  except an old over-long row: set `truncated`). Sent only to agents announcing `projects`; appended to the system prompt each turn.
- **Propose-file shapes** (push-then-propose, as `share_file`):
  - input `{path, name?, folder?, reason?}` (`proposeProjectFileInputSchema`); the project is the thread's, never model-chosen.
  - kobe-tools op `project.file_propose` `{id, op, tool_call_id, tool, input}` (`projectToolsRequestSchema`, in
    `kobeToolsRequestSchema`); response flat `projectProposeOkFields` | fail `{ok:false, error:{code,message}}`.
  - frame (sandbox -> server) `project.file_propose` `{request_id, run_id, thread_id, tool_call_id, tool, input,
workspace:{path,rev,sha256,size}}`; answer frame `project.file_propose_result` (open error code, known
    `PROJECT_PROPOSE_ERROR_CODES`). Small frame (no own size entry).
  - success `status: pending_approval | applied`, `proposal_id`, `project_id`, `path`, `file?`. Approval is the normal
    HMAC-signed one; on grant the server copies the blob into the project's files (`source: proposal`).

## Open questions (for Chris or the coordinator)

- Tool name `propose_project_file` kept (brief marked it open).
- Fork copies the entries only, not workspace files; revisit in KOBE-163 if wanted.

## Evidence

- ac-1 `packages/protocol/src/projects.test.ts`. ac-2 "run.start project context" tests. ac-3 section above.
