# KOBE-488: Badges under the thread title for every artifact and file the agent created

- **Status:** in review (committed on the branch; coordinator pushes)
- **Branch / worktree:** `kobe-488-thread-badges` in `../Kobe-wt488`
- **Depends on:** KOBE-130 (badge row), KOBE-484 (open_file, file tabs), KOBE-485 (artifact editor)

## Plan

- Server: `GET /v1/threads/{id}/files` beside `file-edit-proposals` in
  `services/server/src/routes/thread-file-edits.ts`; logic in `src/threads/agent-files.ts`.
- Contract: new additive `packages/protocol/src/thread-files.ts` (`threadFilesResponseSchema`,
  `THREAD_FILES_MAX` 200, `THREAD_FILE_WRITE_TOOLS`); entries are the existing
  `workspaceFileEntrySchema` (built with `fileEntry`).
- Web: `ArtifactList` lists artifacts then files; files come from `use-thread-files.ts` through the
  artifact panel state (`panel.files`).

## Decisions

- **Sources.** Run events (`tool.call` + `tool.result` with `is_error: false` for `write`/`edit`,
  paired by `tool_call_id`) and, because run events are compacted 7 days after a run (D18), the
  thread's mirrored entries too (assistant `toolCall` parts + `toolResult` messages, inline
  payloads only). Both are read with jsonb projections (no file content loaded); union, then
  de-duplicated by first appearance (`created_at`).
- **Accepted proposals.** Acceptance is not recorded server-side (the member commits through the
  save route). A `file.edit_proposed` counts as accepted when the synced file's SHA-256 equals the
  SHA-256 of the proposed content (computed in SQL). A proposal accepted and then edited further by
  the member drops out; acceptable.
- **Existence.** Only paths with a live (non-tombstone) row in the owner's `workspace_files`;
  agent-internal paths excluded; paths normalised with `workspaceToolPath` (outside `/workspace`
  dropped). Batch lookup `currentEntries` added to `workspace-sync/store.ts`.
- **Access.** `withTeam`, `findThread` must answer `access: "owner"`; shared readers, other teams
  and unknown ids get the same 404 (`thread_not_found`). The web treats a failed read as no files,
  so a shared reader sees artifact badges only.
- **Not tracked.** Files made only by `bash`/`run_python` (no reliable record), and a `write` whose
  input was over 64 KB (`kobe_omitted` in the event; an entry over 64 KB is offloaded to S3 and
  not read here).
- **Live.** The sandbox pushes a run's files ~2 s after it ends (or on `open_file`), so on a
  successful live write the web reads the list, and while a written path is still missing it reads
  again after 1.5/3/6/12 s. A failed write/edit triggers nothing.
- **Names.** Row `nav` renamed "Artifacts and files in this conversation"; badges are
  `Open artifact <title>` (layers icon) and `Open file <path>` (file icon), visible text title /
  base name, `title` attribute the full title / path. Existing unit tests and the gate5 u17 spec
  updated to the new names (Playwright's substring match on `title` still works there).

## Open questions (for Chris or the coordinator)

- Accepted proposals refresh the row on the next read (thread open or next live write), not at
  the moment the member saves the proposal.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/thread-files.db.test.ts` (5 tests: order/dedupe/normalise, deleted
  and never-synced, accepted vs pending proposal, compacted run via entries, owner only: shared
  reader 404, other team 404, unknown 404, bad id 400); `src/threads/agent-files.test.ts` (3).
- ac-2, ac-3, ac-4: `apps/web/components/chat/thread-badges.test.tsx` (4 tests: names, icons,
  titles, wrap; artifact opens its viewer, file opens the editor, aria-expanded; shared reader
  artifacts only; live write appears once synced, failed edit no read, gone file drops).
- ac-5: unit tests above; browser spec `e2e/browser/tests/thread-badges.spec.ts` (not run here;
  coordinator runs it on gate1 after deploy).
