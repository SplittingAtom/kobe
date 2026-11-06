# KOBE-548: Tree: Make it current and carry a summary — run kind branch_summary (CT-7)

- **Status:** in progress (steps 1–4 done; web pending KOBE-546's hook)
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

## Open questions (for Chris or the coordinator)

- The server does not refuse a target on the leaf's own path (an ancestor): Pi then summarises the
  tail between them. CT11 offers the action only off the leaf's branch; the web enforces that.

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
- Unit: `kobe-models/branch-summary.test.ts`, `agent.branch-summary.test.ts`,
  `protocol/.../branch-summary-frames.test.ts`, `packages/db/src/run-kind.db.test.ts`.
