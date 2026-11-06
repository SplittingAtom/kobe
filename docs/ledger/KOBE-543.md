# KOBE-543: Tree: labels table, branches read, junction count, leaf rules, export (server) (CT-2)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in progress (local commits, not pushed)
- **Branch / worktree:** `kobe-543-tree-server` in `../Kobe-wt543` (from `kobe-542-tree-protocol`)
- **Depends on:** KOBE-542 (protocol shapes)

## Plan

1. Migration: `thread_branch_labels` (0188 generated, 0189 RLS), conversations area, probe fixture.
2. `GET /v1/threads/{id}/branches` and `PUT /v1/threads/{id}/labels/{entryId}`
   (`threads/branches.ts`, `routes/threads.ts`); fork copies the copied path's labels.
3. Hover card `branches` / `branches_capped` (`threads/card.ts` `junctionCount`).
4. `setLeaf` refuses queued runs (`PENDING_RUN_STATUSES`); `LEAF_RATE` on `POST /leaf`.
5. `thread.updated {leaf_entry_id}` on a run's leaf moves (`leafMovedEvents`, `sandbox-wire/entries.ts`).
6. Export: `branches/<thread>/<n>-<label-or-first-words>.md` (`retention/export-branches.ts`).

## Decisions

- RLS: the canonical `team_isolation` policy only; no `break_glass_read` (labels are personal
  organisation, not conversation content), as `thread_folders`.
- Labels are read in `entry_id` order (stable; the web places them by id). `created_by` of a fork's
  copied labels is the fork's owner.
- Label route: rate limit is counted after the body validates (as folder create); key
  `thread-label:<user>`; leaf route key `thread-leaf:<user>`. Both answer 429 `rate_limited`.
- Eval threads: the existing `refuseEvalThreadWrites` middleware answers first
  (`skill_eval_thread`, 409); builder test and Workbench threads answer `test_thread`.
- `branches` read lists only runs with a remembered approval (`remembered_rule: true`), distinct by
  `user_entry_id`; runs whose prompt was never committed have no node and are left out.
- Junctions count every parent with more than one child, server entries included (a skipped-actions
  note or app card under an entry with another child counts too).
- Leaf on the wire: a mirror (`mirrorEntriesInTx`) reports `leafMovedTo` (the leaf after the mirror
  when it changed); ingest, kept/unsent prompts and compaction append a leaf-only `thread.updated`
  to their run. The append guard treats a `thread.updated` without a title as an ordinary event
  (before the terminal event); a titled one stays the title epilogue. `thread-title.db.test.ts`
  now ignores leaf-only updates when it looks for the title event.
- Seam for KOBE-548: the branch-summary run appends `leafMovedEvents(threadId, leafMovedTo)` from its
  end transaction as compaction does (`sandbox-wire/delivery.ts`, guarded by `runStillOpen`).
- Export: one pass over the tree's shape (ids, parents, seq, type; pages of 5,000) gives the main
  path and every other leaf's path; each branch file is a paged read from the seq of its branch
  point. A path whose new part has no message (a ghost marker) adds no file. The Branched-from line
  counts the main transcript's user/assistant messages with text up to the branch point, excerpt
  120 chars; a branch from the hidden root (another first message) says "Branched from the start
  of the main transcript." File name: the label on the branch's first entry, else its first eight
  words, slugged as titles (`slug`, now exported). `threads.json` gains `labels` and `branches`
  only for threads that have them. The single-thread `/export` download is unchanged.

## Open questions (for Chris or the coordinator)

- CT13 "the route": there is no thread-level stream today; thread events ride a run's stream, and
  `POST /leaf` is refused while any run is pending, so no stream is open to carry a route move
  (a finished run's stream takes only its announced epilogue). The route answers the summary with
  the new `leaf_entry_id`; other tabs fall back to the focus re-read (CT13's fallback). A live
  route move needs a thread stream (new route + web consumer): a separate ticket?
- Junctions and server-written entries (see Decisions): exclude `ks-`/app-card children?

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db` `pnpm test:db` (cross-team probe suite with the new fixture): 100 files,
  1633 tests passed.
- `services/server` `pnpm test:db`: 202 files, 2428 tests; the 5 failures of the first run were
  event-sequence expectations gaining the leaf-only `thread.updated` (`runs`, `run-prompt`,
  `sandbox-wire` db tests, updated; rerun 74/74 passed).
- ac-2..ac-6: `services/server/src/conversation-tree.db.test.ts` (labels, branches read, card
  junctions and cap, leaf rules and rate limit, send's commit event, export).
