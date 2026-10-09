# KOBE-141: 53a Uploads contract (upload API, limits, errors, attachments frame)

- **Status:** in review
- **Branch / worktree:** `kobe-141-uploads-contract` in `../Kobe-wt141`
- **Depends on:** none. Blocks KOBE-143 (53c upload API), KOBE-144 (53d submit), KOBE-145 (53e web). Spec D26.

## Plan

`packages/protocol` only, additive, tests first. New `uploads.ts` (exported from the index).

## Decisions (dependants must follow)

- `POST /v1/uploads`: multipart/form-data, optional text field `thread_id` (`uploadFieldsSchema`), one file
  part; streamed to S3. 201 `uploadResponseSchema`: `{file_id, name, mime_type, size_bytes, scan, created_at}`,
  `scan` is `skipped` (ClamAV off) or `clean`. Infected/unscanned files are errors and are not stored.
- Errors: `uploadErrorSchema` `{code, message, limit_bytes?}`; codes and HTTP status in
  `UPLOAD_ERROR_HTTP_STATUS`: `file_too_large` 413, `message_too_large` 413, `quota_exceeded` 403,
  `scan_rejected` 422, `scan_unavailable` 503 (retryable). `limit_bytes` = the exceeded limit.
- Limits: `UPLOAD_DEFAULT_MAX_FILE_BYTES` 100 MiB, `UPLOAD_DEFAULT_MAX_MESSAGE_BYTES` 500 MiB (Helm may
  configure others), `UPLOAD_MAX_FILES_PER_MESSAGE` 100 (fixed). Any file type; never reject on mime.
- `file_ids` on `submitMessageBodySchema`: now unique, max 100 (was max 100, no uniqueness). Server checks
  ownership (404), summed size (`message_too_large`) and quota at submit.
- File name: single path segment, 1-255, no `/`, `\`, control chars, not `.`/`..` (`uploadFileNameSchema`).
- `run.start.attachments[]` (no longer speculative, max 100): `{path, mime_type, name?, size_bytes?,
native_media?: "image"|"pdf"}`, strict. `path` is the absolute synced path, normally `UPLOAD_ATTACHMENT_ROOT/<thread>/<name>`
  (`/workspace/uploads/...`); schema only rejects `..` (agent root is configurable; the agent refuses paths outside it). `native_media` is a hint that the agent MAY pass the file
  to Pi as an image/document block; absent = list only. Old `{path, mime_type}` frames still decode.
- Frame caps: `run.start` is server -> sandbox, so `SANDBOX_FRAME_MAX_BYTES_BY_TYPE` is unchanged.

## Open questions (for Chris or the coordinator)

- None blocking. Thread-less uploads (no `thread_id`) are allowed by the contract; 53c decides retention of orphans.

## Evidence

- ac-1: `packages/protocol/src/uploads.test.ts` (limits, error codes, bodies, file_ids).
- ac-2: `uploads.test.ts` "run.start attachments"; `SANDBOX_FRAME_MAX_BYTES_BY_TYPE` unchanged.
- ac-3: Decisions above.
