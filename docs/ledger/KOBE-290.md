# KOBE-290: A prompt whose run ends before Pi's first turn ends is lost after reload

- **Status:** committed on `group-1-fixes` (ticket group G1; no PR of its own)
- **Branch / worktree:** `group-1-fixes` in `../Kobe-g1`
- **Depends on:** KOBE-288 (the waiting note follows run state), KOBE-258 (entry sync), KOBE-178 (server-written entries)

## What Pi does after a Stop before its first token (real Pi 1.0.0)

`services/sandbox-agent/src/stop-before-answer.real-pi.test.ts` (faux model step `waitForAbort`):

- Pi writes the prompt when it emits `message_end` (role user), before any model output; the
  session file then holds `model_change, thinking_level_change, system, user`.
- After the abort the prompt stays under the same id, followed by an empty `aborted` assistant
  entry (child of the prompt).
- `get_entries since <entry before the prompt>` (today's cursor) returns the prompt again with the
  same id: the next run's sync used to mirror it then, as a side branch (that run branched from
  the old leaf). `since <prompt>` never returns it; it returns the aborted answer, the next run's
  `kobe.branch` marker (child of the prompt) and its entries. The model of the next run gets both
  prompts (pi-ai drops the empty aborted answer).

## Options considered

- **(a) Mirror at run start.** From `runs.input` the server can't know Pi's id (Pi picks it), so a
  copy would duplicate Pi's entry on re-sync. From the first Pi frame: `message_end` (user) is a
  sync point like `turn_end`; `get_entries` then gives Pi's entry with its id, parent and branch.
  Covers every early end that comes after Pi wrote the prompt and the mirror committed.
- **(b) At the early end.** The end transaction (Stop, start failure, budget stop; often another
  replica) can't ask Pi. Synthesizing from `runs.input` is safe only where Pi certainly lacks the
  prompt; accepting Pi's entry is possible only where Pi's entries are read (the ended run's late
  batch, a refused `run.start`).
- **Read-side display** of `runs.input` (pending messages for ended runs): no Pi id, no branch
  placement, and no way to drop it once Pi's own entry re-syncs. Rejected.

## Decision: (a) plus (b) where Pi's state is known

1. **Sync at the prompt** (`translate.ts`): `message_end` with role user asks for an entry sync.
   Pi's own entries (setup, branch marker, prompt) are mirrored while the run is active.
2. **Late batch of an ended run** (`ingest.ts`): the CAS still refuses the batch and rolls it back.
   Then, if the run's prompt was never bound, Pi's entries (the batch's, or read now) are cut after
   the run's prompt (first user message after its own `kobe.branch` marker, else the first) and
   only that prefix is mirrored, in its own `withTeam` transaction; no run event, no cursor move.
   Safe: it is the member's own input plus the setup entries Pi wrote before it, by Pi's ids
   (idempotent), parents checked as for any mirror; the leaf moves only if no later run started.
   Assistant output and tool results of the late batch are still refused.
3. **Pi never had it** (`runs/run-prompt.ts`, hooked into `applyTransition` and `endRunInTx`, the
   two places a run ends): an active run with no `sandbox_run_leases` row was never delivered
   (delivery checks the run under `FOR SHARE` before writing the lease, so the end's row lock makes
   this race-free); a refused `run.start` (`delivery.ts #endRun`) reads Pi's entries first. Then
   the server writes the prompt Pi-shaped (`type: message`, role user, `runs.input` as text) with
   id `ku-<run hex>` under the run's branch point, moves the leaf to it and appends its
   `entry.committed` before the terminal event. Like the skipped-actions note it is excluded from
   the sync cursor, the restore and `threadHasConversation` (`piSessionEntrySql`), and a run that
   starts at it continues from its parent (`piBranchPoint` in `promoteInTx`): a message sent after
   it becomes its sibling (a second version), since the model never saw it.
4. A leased run whose entries can't be read keeps nothing: Pi's entry arrives with the next sync.
5. `runs.user_entry_id` is bound at every early end (markers and usage place on the prompt).
6. Ended-run late frames that were queued behind the refused batch are now acked too (they were
   dropped without an ack, so the agent kept them).

No migration (no schema change).

## Not covered (deliberately)

- `interrupted` (sandbox lost): Pi's volume may still hold the prompt, so nothing is synthesized;
  the run marker and Retry place by `parent_entry_id` as before.
- Queued messages that end without starting (deleted, a promotion failure, a budget stop of the
  queue) stay out of the conversation, as before.
- An unsent prompt carries `runs.input` only (attachments are not re-listed).
- A run continuing from an unsent prompt at the root (a thread's first message) has no Pi branch
  point, so it continues from Pi's leaf.

## Open questions

- After a reload a stopped or failed run shows no end-state row (only `interrupted` and
  `budget_stopped` have markers, KOBE-209). Add `cancelled`/`failed` run markers?

## Evidence

- ac-1: `services/server/src/run-prompt.db.test.ts`: Stop after Pi wrote it (mirrored at
  `message_end`), Stop before the mirror (late batch: prompt only, no aborted answer, no run
  events), Stop while the sandbox wakes (`ku-` entry, leaf, `entry.committed`), failed (sandbox
  refuses `run.start`), timed out (no sandbox answers), budget_stopped (marker on the prompt). Each
  checks the prompt once in `thread_entries` and over `GET /v1/threads/{id}`.
- ac-2: same file, the next run's sync after each Stop (sequence shaped after the real-Pi
  recording) adds no copy; the restore and every `get_entries since` leave the `ku-` entry out.
  `stop-before-answer.real-pi.test.ts` proves Pi's side. Unit: `translate.test.ts`,
  `runs/run-prompt.test.ts`.
- ac-3: `apps/web/components/chat/run-end.test.tsx` "after a reload…" (Stop, failed start, budget
  stop): the prompt shows once, no "Sent, waiting for the agent", no versions; budget marker on it.
  No web code change was needed.
- k3d e2e (`e2e/run.sh`): KOBE-30 section (Stop while the sandbox is unwoken → reload shows the
  prompt once as the leaf; event list now has `entry.committed`) and "Stop before the first token
  (KOBE-290)" on real Pi with the fake model's new `kobe-slow-start` marker. **Unproven until G1 CI**
  (no k3d outside CI).
