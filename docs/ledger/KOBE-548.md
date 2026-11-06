# KOBE-548: Tree: Make it current and carry a summary — run kind branch_summary (CT-7)

- **Status:** steps 1–5 done; review fixes in; ready for PR
- **Branch / worktree:** `kobe-548-branch-summary` in `../Kobe-wt548` (from `kobe-543-tree-server`)
- **Depends on:** KOBE-541 (spike: both answers yes), KOBE-543 (leaf rules, `leafMovedEvents`),
  KOBE-546 (tree menu and bar hooks, for the web step)

## Plan

1. DB: `RUN_KINDS` + `branch_summary`; `SANDBOX_COMMAND_KINDS` + `thread.branch_summary`;
   migration `0190_run_kind_branch_summary` (generated: both CHECKs widened).
2. Protocol: `thread.branch_summary` in the server→sandbox union, `thread.branch_summary_result`
   (`{entry_id, parent_id}` or a wire code) in the sandbox→server union, `branchSummaryResponseSchema`.
3. Sandbox agent: `kobe-branch-summary` command in kobe-models, armed by the agent.
4. Server: run, route, delivery, audit, sweep.
5. Web: marker, dialog, `api.branchSummary` (after merging `kobe-546-tree-panel`).

## Decisions

- **Gate (spike note 1).** The command takes nothing from its prompt. The agent sends a bare
  `/kobe-branch-summary`; the handler asks for the request over Pi's RPC dialog channel
  (`kobe.branch_summary`, answered by the agent from memory and never relayed, like the run
  token). The agent answers only while it has armed one for the active run, once, and cancels
  otherwise, so a member typing the command gets a warning in Pi's log and nothing is written
  (real-Pi test). The outcome comes back on a second dialog (`kobe.branch_summary_result`, JSON in
  the placeholder), taken only after the armed request was handed out. No state file: the dialog
  is in-band, and Pi's uid never holds a nonce a tool could read.
- **Model and token (note 2).** The agent selects the run's model as compaction does
  (`#compactReady`, `set_model`); kobe-models refreshes the run token on `session_before_tree`.
  The sandbox-side run is a `compacting` run (steer, pi.command, context refused meanwhile).
- **Pre-move (note 3).** The handler moves Pi's leaf to `from_leaf_entry_id` without a summary
  first when they differ, then navigates to `to_entry_id` with `summarize: true` and the focus.
- **Placement (note 4).** The result carries the entry's `parentId`; the server makes the entry the
  leaf only if the mirrored row is a `branch_summary` under that parent (else `summary_failed`).
- **Nothing to summarise (note 5).** `session_before_tree` cancels a summary whose entries hold
  no `message`; a navigation that appended no summary is also `nothing_to_summarize`. The server
  refuses `to_entry_id === leaf` (and a thread without a leaf) before creating a run.
- **Wire errors** carry the agent's own short text per code; Pi's text is in the agent's log only.
- **Target check:** `to_entry_id` must be a tree node Pi has (`piSessionEntrySql` and
  `treeEntrySql`): else 404 `entry_not_found` (not in the protocol's code list; fixed message).
- **Cap:** counts the thread's `branch_summary` entries under the thread lock (`LIMIT 20`).
- **Reader** answers `read_only` with the branch-summary contract's message (not RunError's).
  Eval threads: the route's own `refuseEvalThreadWrites` (`skill_eval_thread`); builder test and
  Workbench threads `test_thread`.
- **Agent without the capability:** the run fails `branch_summary_unsupported` → `summary_failed`
  (as compaction's `compact_unsupported` → `compaction_failed`).
- Shared with compaction: `CompactionHost`, `compactionModel` (exported), the sweep's deadline
  (`StaleCompaction.kind` picks the audit action), a lost connection fails the run
  (`branch_summary_interrupted`), the gauge's latest call skips `branch_summary` runs' calls.
  `startsRun`/`isSummaryCommand` (sandbox-wire/types.ts) replace the `thread.compact` literals.
- `runStillOpen` moved from delivery.ts to run-state.ts (used by `branch-summary-end.ts` too).
- **Review fixes (security review of steps 1–4):**
  - M1: the end mirror stores Pi's entries with `moveLeaf: false` (`mirrorEntriesInTx` option);
    the leaf moves only when the summary checks out, so a failed run never moves it.
  - M2 (decision: follow Pi): Stop or the sweep racing a late success still mirrors and moves the
    leaf (Pi's session is on the summary) and the member gets 200; the run stays cancelled or
    failed, no `thread.updated` goes out (the run's stream is closed, there is no thread stream):
    other tabs see the leaf on their focus re-read. The audit says `completed` then.
  - L2: the answer names the reported entry, and only when it is the leaf and a `branch_summary`.
  - L4: the entry must be one this mirror stored, under `to_entry_id` or its parent (Pi's rule for
    a user-message target); the target is read from the stored command frame.
  - L1: after a failure that left Pi elsewhere, the command moves Pi back to the old leaf (writes
    nothing; best effort). Otherwise the next send carries `parent_entry_id` anyway.
  - L3: interrupt and timeout write two audit rows (system, then the requester's), as compaction.
  - L5 (decision): the server accepts a target on the leaf's own path (Pi summarises the tail: a
    "rewind with summary"); the web refuses it (`ON_LEAF_BRANCH`) and never offers it (the menu
    item needs a node off the leaf's branch; the bar shows another branch only).
- **Code review fixes:** the old leaf sent to Pi is the thread's leaf or, when that is a server
  row Pi never had (`ka-` app card, `ku-` unsent prompt), its nearest Pi ancestor (recursive walk,
  `checkTarget`); a summary under the target's parent is accepted only for a user-message target;
  the bar's ▾ needs a head off the leaf's path (`carryOffered`); `carrySummary` keeps
  `thread_busy` in the dialog and never re-reads after a refusal; `lockOwnedThread` reused (the
  route maps its `read_only` to the contract's message); kobe-models shares `withTimeout`
  (`timeout.ts`); the sweep's log names the run kind.
- **Web (step 5):** marker `branch_summary` ("Summary of another branch", folded, Markdown; carried
  below a junction like the other markers, so it shows only on the branch it entered); the tree
  row was already KOBE-546's `SUMMARY_TEXT`. Dialog `branch-summary-dialog.tsx`: `carryText(n)`
  with n = messages on the leaf's branch the target's branch lacks (`messagesDiffer`), CT6's
  files line, one-line focus, Go; errors are the server's fixed messages. Target: the node's
  newest entry (`branchLeafOf`, as Make it current), the head from the bar. The bar's ▾ menu
  ("More ways to make it current" → "and carry a summary") shows for the owner, not on test
  threads. `controller.carrySummary` posts, clears the head, re-reads the thread, announces "This
  branch is now current" and tells other tabs (`onLeafMoved`).

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1 (first half): `services/sandbox-agent/src/kobe-models.branch-summary.real-pi.test.ts` —
  real Pi 1.4: entry under `to_entry_id` (B's answer, branch C left), summary call with the run's
  id and token, next prompt's model context has "summary of a branch" and B, not C as a message;
  a member-typed command writes nothing; `nothing_to_summarize` on the leaf.
- ac-1 (second half) and ac-2: `services/server/src/thread-branch-summary.db.test.ts` (17) — leaf
  moved to the entry, `thread.updated {leaf_entry_id}` before `run.completed`; refusals busy and
  queued, reader, outsider, unknown entry, test/Workbench/eval threads, leaf itself, 21st summary,
  model, capability, sandbox codes without their text, a lying result, Stop, sweep; audit rows.
- ac-3 (budget): same file, "counts against the budget" (429 before anything starts).
- ac-3 (web): `apps/web/components/chat/branch-summary.test.tsx` (menu → dialog → marker, leaf,
  tree summary row, announcement; fixed refusal; not offered to readers, test threads or on the
  leaf's branch; the bar's ▾), `components/chat/markers.test.tsx`, `lib/chat/tree-markers.test.ts`.
- Unit: `kobe-models/branch-summary.test.ts`, `agent.branch-summary.test.ts`,
  `protocol/.../branch-summary-frames.test.ts`, `packages/db/src/run-kind.db.test.ts`.
