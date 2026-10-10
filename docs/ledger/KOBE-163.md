# KOBE-163: 57e: Share thread to project, read-only view and fork

- **Status:** in review
- **Branch / worktree:** `kobe-163-share-thread-project` in `../Kobe-wt163`
- **Depends on:** [KOBE-161](KOBE-161.md) (`viewerProjectIds`, `findThread` reader access). No migration.

## Plan

Most of D23 already existed (KOBE-34/44: `PATCH shared_to_project`, `read_only` from `findThread`,
`lockOwnedThread`/`ownedRun`). Gaps closed here: the contract routes `POST /:id/share` and
`POST /:id/fork`, readers on the run event stream, `visibility`/`read_only` on the wire, audit, HTTP tests.

## Decisions

- **Share scope (CE20):** only `private | project` is implemented. The wire carries `visibility`
  (`threadVisibilitySchema`, already in the KOBE-159 contract); `threads/share.ts` is the single mapping
  between it and `threads.shared_to_project`. KOBE-221 adds `team` there plus a column (migration) and
  widens the reader predicate in `readableBy` (`threads/repository.ts`) and `event-stream/visibility.ts`.
  `PATCH shared_to_project` stays (the web client uses it); `POST /share` is a thin wrapper over the same
  `updateThread`, so one audit path (`thread.sharing_changed`, now also `visibility`).
- **Read-only:** every mutating thread/run route already answers `403 read_only` to a reader and 404 to
  everyone else; now covered by one HTTP test across all of them. Approvals and queued messages are
  author-scoped, so a reader sees none. `GET /v1/threads/:id` gains `read_only` (computed for the caller).
- **Run event stream:** `canWatchThread(thread, userId, projectIds)` now admits project members while the
  thread is shared and not in Trash; the reader (`event-stream/read.ts`) returns `project_id` and
  `shared` for the initial check and for periodic revalidation, so unsharing, trashing or removing a member ends an open reader stream at the next revalidation, which is
  every 30 s in production (`STREAM_DEFAULTS.revalidateMs`). There is no push hook across replicas (the only
  NOTIFY channel is per-run event hints), so that window stays; the test uses a 100 ms timer.
- **Fork** (`threads/fork.ts`, `POST /:id/fork {entry_id?, title?}` -> 201 `{thread_id}`): any reader (or the
  author) copies the root-to-`entry_id` path (default leaf) with the same entry ids; the fork is owned by the
  caller, private, in the source's project if they can still create there (else no project), pinned to the
  source's agent at its current published version if they may start it (else project default, else team
  default), model alias kept if the team still enables it, title kept unless given. Workspace files are not
  copied (KOBE-159 note stands). A path containing an offloaded entry (`blob_ref`, > 64 KB) is refused
  `409 entry_offloaded`: blobs live under the source thread's tree and are purged with it.
- **Share needs a usable project:** enabling the share requires `canCreateInProject` for the owner (still a
  member who can use it, project not archived); otherwise 404 `project_not_found`. Unsharing is always allowed.
- **Audit:** `thread.sharing_changed` (adds `visibility`), new `thread.forked` (`threadId`, `sourceThreadId`,
  `projectId`, `entries`; no titles). `docs/audit-log.md` updated; schemas in `packages/db/src/audit/events.ts`.

## Open questions (for Chris or the coordinator)

- Offloaded entries make a fork impossible for now; copying blobs would need a blob copy helper (not needed
  while nothing writes `blob_ref` for entries yet).

## Evidence (acceptance criteria -> test)

All in `services/server/src/thread-sharing.db.test.ts`.

- ac-1: "shares to the project, readable by members only, and unshare hides it again"; "copies the
  conversation into the forker's own private thread and audits it".
- ac-2: "gives an outsider the same 404..."; "answers 403 read_only to a reader on every mutating route";
  "hides a shared thread while it is in Trash".
- ac-3: audit assertions in the share and fork tests.
