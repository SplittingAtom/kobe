# KOBE-147: 54a Files contract: browser API, share_file tool and wire frames

- **Status:** in review
- **Branch / worktree:** `kobe-147-files-contract` in `../Kobe-wt147`
- **Depends on:** KOBE-141 (PR #122, uploads contract; reused, see below). Blocks KOBE-54 b-e (browser API, agent `share_file`, server share, web).

## Plan

`packages/protocol` only, additive, tests first. New `files.ts` (one `export *` in the index), frames in
`sandbox-wire/frames.ts`, `file.share` member in `kobeToolsRequestSchema`.

## Decisions (dependants must follow)

- **Capability** `files` (`CAPABILITY_FILES`). The agent registers `share_file` and sends `file.share` only if
  it announced it; the server refuses the frame otherwise. Documented in `sandbox-wire/connection.ts`.
- **Reuse of #122:** the shared file's record is `sharedFileSchema` = `uploadResponseSchema` + `sha256`
  (`file_id, name, mime_type, size_bytes, scan, created_at, sha256`). File names use `uploadFileNameSchema`.
  Branch contains #122's commits (merged in); drop the overlap with `git merge origin/main` once it lands.
- **Browser API (REST, shapes only; paths mounted by 54b):** list `workspaceListQuerySchema` /
  `workspaceListResponseSchema` (rows `workspaceFileEntrySchema`: `name, path, type file|dir, size_bytes`
  (null for dirs), `mtime, source synced|live, owner sandbox|server, area workspace|uploads|projects`,
  optional `sha256, mime_type`); download by `path` (attachment + nosniff, never inline); upload to a
  folder (multipart, text field `path`, one file part, 201 entry); delete by `path` (204). Errors
  `workspaceFileErrorSchema` (`WORKSPACE_FILE_ERROR_CODES`). `uploads/` and `projects/` are read-only (`read_only`).
- **`share_file` input** `shareFileInputSchema` (strict): `path` (absolute `/workspace/...` or relative, no
  `..`/control chars, <= 1024), optional `name` (`uploadFileNameSchema`), optional `description` (<= 500).
  canonicalJson-safe (strings only).
- **kobe-tools** (fd 4): request `{id, op:"file.share", tool_call_id, tool:"share_file", input}`; response
  flat `{id, ok:true, ...sharedFileSchema}` or the existing `{id, ok:false, error}`.
- **Frames:** `file.share` (sandbox -> server) = `{request_id, run_id, thread_id, tool_call_id, tool, input,
workspace:{path, rev, sha256, size}}`; `file.share_result` (server -> sandbox) ok = same fields as above,
  or `{ok:false, error}` with open code (known: `FILE_SHARE_ERROR_CODES`). Both are small frames: no entry in
  `SANDBOX_FRAME_MAX_BYTES_BY_TYPE` (unchanged); max shared file `FILE_SHARE_MAX_BYTES` = 100 MiB (upload default).
- **`file.shared` event** extended with optional `description`; every other field unchanged (`size`, not `size_bytes`).
- **Push-then-share sequence (for 54c agent, 54d server):**
  1. policy check; 2. kobe-tools `file.share` on fd 4; 3. agent normalizes the path (strip `/workspace/`), refuses
     `.kobe/`, outside the workspace, non-regular files, then pushes the path via workspace sync (blob + commit; a
     no-op commit is fine) and keeps the applied entry; rejected/conflict -> tool error `not_synced`;
  2. agent sends `file.share` with `workspace` = that entry; 5. server checks capability, lease, allowed-input
     hash for `tool_call_id`, live row has the same `rev` and `sha256` (else `not_synced`), size, quota; copies the
     blob to a `files` row (kind `shared`), emits `file.shared`, answers `file.share_result`; idempotent on
     `(team_id, tool_call_id)`; 6. the answer is the tool result. Later workspace edits do not alter the share.

## Open questions (for Chris or the coordinator)

- Route paths (`/v1/threads/{id}/workspace/...` in doc comments) are a suggestion; 54b decides. Live listing/download
  of unsynced files needs a server -> sandbox command, not defined here.

## Evidence

- ac-1: `packages/protocol/src/files.test.ts` (schemas, `file.shared` old and new shape).
- ac-2: frames are small (test "states sizes"), capability in `connection.ts` header and `files.ts`.
- ac-3: Decisions above and `files.ts` header.
