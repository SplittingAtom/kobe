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
- Tree nodes (review fix 1): `treeEntrySql` (`sandbox-wire/entries.ts`, beside `piSessionEntrySql`):
  not a skipped-actions note (`ks-`) and not an app card (`ka-`); unsent prompts (`ku-`) stay.
  Junctions count only such children; export never takes a `ks-`/`ka-` entry as a leaf (a card Pi
  appended still links its path). KOBE-545's `projectTree` should apply the same rule.
- Junction scan: index-only over the whole thread on every hover (no cache).
- Leaf on the wire: a mirror (`mirrorEntriesInTx`) reports `leafMovedTo` (the leaf after the mirror
  when it changed); ingest, kept/unsent prompts and compaction append a leaf-only `thread.updated`
  to their run. The append guard treats a `thread.updated` without a title as an ordinary event
  (before the terminal event); a titled one stays the title epilogue. `thread-title.db.test.ts`
  now ignores leaf-only updates when it looks for the title event.
- One leaf-only `thread.updated` per mirroring flush that moves the leaf; it counts against
  `runMaxEvents` like any event.
- Leaf events, route (coordinator decision): there is no thread-level stream; the server sends
  `thread.updated {leaf_entry_id}` only for leaf moves a run makes (send commit, compaction, the
  KOBE-548 summary run). A `POST /leaf` move reaches this browser's other tabs through the web's
  per-team BroadcastChannel (KOBE-544) and other devices and readers on the focus re-read. Stated
  in the route's OpenAPI description.
- Compaction end: `runStillOpen` reads the run `FOR NO KEY UPDATE` (thread, then run), so a racing
  Stop cannot make the leaf event's append fail and roll back the mirror.
- Seam for KOBE-548: the branch-summary run appends `leafMovedEvents(threadId, leafMovedTo)` from its
  end transaction as compaction does (`sandbox-wire/delivery.ts`, guarded by `runStillOpen`).
- Export: one pass over the tree's shape (ids, parents, seq, type, in-tree; pages of 5,000) gives
  the main path and the other leaves; each branch's ids are built one branch at a time and its rows
  read by key (50 per page, ownership join as the entry pages; shape, labels and the name payload
  re-check ownership too). At most 200 branch files per thread; past that `threads.json` says
  `branches_capped: true`. A path whose new part has no message (a ghost marker) adds no file. The Branched-from line
  counts the main transcript's user/assistant messages with text up to the branch point, excerpt
  120 chars; a branch from the hidden root (another first message) says "Branched from the start
  of the main transcript." File name: the label on the branch's first entry, else its first eight
  words, slugged as titles (`slug`, now exported). `threads.json` gains `labels` and `branches`
  only for threads that have them. The single-thread `/export` download is unchanged.

## Open questions (for Chris or the coordinator)

- Eval threads answer `skill_eval_thread` (the repo-wide eval guard) where CT9/CT19 say
  `test_thread`; builder test and Workbench threads answer `test_thread`.

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db` `pnpm test:db` (cross-team probe suite with the new fixture): 100 files,
  1633 tests passed.
- `services/server` `pnpm test:db`: 202 files, 2428 tests; the 5 failures of the first run were
  event-sequence expectations gaining the leaf-only `thread.updated` (`runs`, `run-prompt`,
  `sandbox-wire` db tests, updated; rerun 74/74 passed).
- Review fixes: `conversation-tree.db.test.ts` 14/14 (adds the `ks-` note: branches 0, no branch
  file; Workbench `test_thread`, eval `skill_eval_thread`; 200-file cap); reran thread-compact,
  sandbox-wire, run-prompt, retention, thread-folders, runs, thread-title, thread-fork, memory,
  uploads, artifacts, app-cards db tests: 223/223.
- `pnpm verify` green after the review fixes (one run timed out export-markdown.test.ts under
  load; it passes alone and on the rerun).
- ac-2..ac-6: `services/server/src/conversation-tree.db.test.ts` (labels, branches read, card
  junctions and cap, leaf rules and rate limit, send's commit event, export).
