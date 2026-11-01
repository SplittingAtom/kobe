# KOBE-532: Threads: Protocol shapes (`packages/protocol`) (TLF-1)

- **Status:** done (PR #436 merged)
- **Branch / worktree:** `kobe-532-thread-protocol` in `../Kobe-wt532`
- **Depends on:** none (spec `docs/specs/thread-lineage-and-folders.md`, arrives through another PR)

## Plan

Additive shapes in `packages/protocol/src/threads.ts`, tests first in `threads.test.ts`:
lineage response and caps (TL1, TL9), `folder_id` on `threadOrganizationSchema` (TF2, TF5),
folder schemas and request bodies (TF1, TF3, TF4), the `folder` list filter (TF5), and the
folder/filing error codes with their HTTP statuses (compact-thread pattern).

## Decisions

- **`more` placement (TL1 "says `more: true` when cut").** A boolean beside each capped list,
  named after it: `siblings_more` next to `siblings` (each ancestor and `self`), `forks_more`
  next to `forks` (top level). Default false, so the server may omit it when nothing was cut.
  Keeps `siblings`/`forks` plain arrays as TL1 draws them.
- **Sibling/fork item shape.** TL1 shows the full item only for `forks`; sibling lists reuse it
  (`lineageRelativeSchema`: `thread_id`, `title` nullable, `deleted_at` nullable, `owner`), so the
  web renders "In Trash" and links the same way in both dropdowns.
- **`self`** has no `deleted_at` (as TL1; the header already says "In Trash");
  `forked_at_entry_id` is nullable (a root has none). Lists capped at 50, ancestors at 20 in the
  schema itself.
- **Folder names:** `.trim()` then 1-80 chars; also refused: control characters, line/paragraph
  separators and bidi controls (one line of plain text, like the compact focus rule). The DB
  CHECK (TF1) stays the authority on trimming.
- **`position`:** integer 0..2^31-1 (Postgres integer, non-negative).
- **`folder` on `listThreadsQuerySchema`:** that schema lives in
  `services/server/src/threads/schemas.ts`, so protocol gains `threadFolderFilterSchema`
  (lowercase uuid | `"none"`). **The server ticket (KOBE-534/TLF-3) wires it** as
  `folder: threadFolderFilterSchema.optional()` on `/v1/threads` and `/pinned`.
- **Error codes:** organize routes keep their codes in the server, so protocol gains
  `THREAD_FOLDER_ERROR_CODES` + `THREAD_FOLDER_ERROR_HTTP_STATUS` (folder_not_found 404,
  folder_name_taken / folder_too_deep / folder_cycle / folder_limit 409, plus thread_in_trash and
  test_thread 409 for filing, matching `FEEDBACK_ERROR_HTTP_STATUS`). No fixed messages (the
  compact messages exist because sandbox text must never be relayed; not the case here).
- `threadOrganizationSchema` consumers in the server only `.pick()` fields, so `folder_id` changes
  no server output until KOBE-534 adds it.

## Open questions (for Chris or the coordinator)

None blocking. TL1's exact field for "more" was unspecified; resolved as above.

## Evidence (acceptance criteria → test or command output)

- **ac-1:** `packages/protocol/src/threads.test.ts`, describes "thread lineage response" and
  "thread folders" (valid, absent-optional, refused and unknown-key shapes for every new schema),
  plus "parses a KOBE-215 summary that predates folders (no folder_id)" and the absent-fields
  case in "thread organization fields". `pnpm --filter @kobe/protocol test`, `pnpm typecheck`,
  `pnpm lint`, `pnpm verify` green (see commit).
