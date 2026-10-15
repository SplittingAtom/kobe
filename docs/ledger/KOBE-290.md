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
   Then, if the run's prompt was never bound, Pi's entries (the batch's, else read now, up to three
   reads while Pi has not written it yet) go through `findRunPrompt` (`runs/run-prompt-pi.ts`,
   review M1/M2, re-review N1/N2): the prompt is found by the entry tree, never by array order,
   from the run's own `kobe.branch` marker under `runs.parent_entry_id` (required when the run has
   one; a branch-less run starts at the root), through setup entries, to exactly one user message.
   Every entry on the path must be the only child of its parent and carry exactly Pi's fields
   (real-Pi recording) with values the server predicts:
   - marker: `customType: kobe.branch`, `data: {run_id}` of this run;
   - `model_change`: provider `kobe`, `modelId` the run's gateway model (the `run.started` alias
     looked up in the catalog); `thinking_level_change`: one of Pi's levels. Pi writes these at a
     new session's root and a `model_change` under the marker when the branch's model differs, so
     they are allowed there too (not root-only): their values are fixed;
   - Pi's `system` entry (final re-review), only on a branch-less run's root path and at most
     once: exactly Pi's fields (`message`: role, content `""`, sections, timestamp, toolsAdded),
     Pi's section set (`preamble`, `tools`, `rules`, `docs`, `cwd`, plus `addendum` only when the
     run had an agent prompt), `addendum` exactly `<addendum>\n…\n</addendum>` around the prompt
     `run.start` carried (re-derived from the pinned agent version, `runs/run-prompt-agent.ts`;
     a draft only at the run's revision; unknown: refused), `cwd` exactly `/workspace`, at most
     256 KiB. Pi's own sections can't be checked; the early mirror takes them as they come, so this
     is no looser. Any other `system` entry, or one under a branched run's marker (Pi writes one
     there after a system-prompt change), is still refused: such a run stopped before the early
     mirror commits keeps nothing until the next sync;
   - the prompt: text exactly `runs.input`, or `runs.input` plus the block `promptWithAttachments`
     builds from the run's own attachments (`listRunAttachments`: order, path and type as sent; the
     "shown to you as an image" note only for inline image types, else the fixed by-path note);
     nothing may follow the input of a run without files; one inline image per file the block
     says is shown, of that file's type, base64, at most 5 MiB.
     The chain is mirrored in its own `withTeam` transaction, charged to `runs.sandbox_bytes` under
     `runMaxBytes`; the leaf moves only if no later run started, and `user_entry_id` is set only if
     the entry is not another run's prompt. Otherwise nothing is kept. Answers, tool results and
     anything else of the late batch stay refused.
3. **Pi never had it** (`runs/run-prompt.ts`, hooked into `applyTransition` and `endRunInTx`, the
   two places a run ends): an active run with no `sandbox_run_leases` row was never delivered
   (delivery checks the run under `FOR SHARE` before writing the lease, so the end's row lock makes
   this race-free); a refused `run.start` (`delivery.ts #endRun`) reads Pi's entries first and
   keeps Pi's prompt only through the same `findRunPrompt` check (absent or not this run's: the
   server's copy; another run's prompt is never taken, review M2). Then
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
7. The mirror refuses entries whose id only the server writes (`ks-`, `ku-`) from a sandbox, and
   never takes one as Pi's leaf (review L1).
8. Pi's empty `aborted` answer comes back with the next run's sync as a sibling of that run's
   branch marker. The chat hides such an empty stopped answer when it has no children, is not the
   leaf and has siblings, so the next message shows no "2 branches" (`tree.ts`
   `staleStoppedAnswers`, review L3).
9. After a reload, a started run that was stopped shows a "Stopped" marker row and a failed one
   "Run failed: <the server's message for its code>" (`/v1/threads/{id}/markers` gains
   `cancelled` and `failed`, with `message` for failed; coordinator decision 2026-10-15).

No migration (no schema change).

## Not covered (deliberately)

- `interrupted` (sandbox lost): Pi's volume may still hold the prompt, so nothing is synthesized;
  the run marker and Retry place by `parent_entry_id` as before.
- Queued messages that end without starting (deleted, a promotion failure, a budget stop of the
  queue) stay out of the conversation, as before.
- An unsent prompt carries `runs.input` only (attachments are not re-listed).
- A run continuing from an unsent prompt at the root (a thread's first message) has no Pi branch
  point, so it continues from Pi's leaf.

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
- Review fixes: `run-prompt.db.test.ts` "late batch is checked against the run" (forged answer
  before the prompt, altered text, marker under another parent, over the byte budget, `ku-` id from
  a sandbox, a files block on a run without files, a forged system message on the path, a first
  run kept below Pi's real-shaped system entry, a system entry with another cwd), "Stop, then an immediate resend the agent refuses" (M2), "unsent prompt as a branch
  point" (Regenerate from it, fork at it); unit `runs/run-prompt-pi.test.ts` (injected, extra,
  renamed and reordered file lines, extra, mistyped or oversized images, forged setup entries); the
  real-Pi test asserts Pi's prompt and setup entry fields.
- ac-3: `apps/web/components/chat/run-end.test.tsx` "after a reload…" (Stop, failed start, budget
  stop): the prompt shows once, no "Sent, waiting for the agent", no versions, and its end-state
  row; a `ku-` prompt edits from its parent; the next run shows no second version.
  `markers.test.tsx` and `thread-markers.db.test.ts`: Stopped and Run failed rows.
- k3d e2e (`e2e/run.sh`): KOBE-30 section (Stop while the sandbox is unwoken → reload shows the
  prompt once as the leaf; event list now has `entry.committed`) and "Stop before the first token
  (KOBE-290)" on real Pi with the fake model's new `kobe-slow-start` marker. **Unproven until G1 CI**
  (no k3d outside CI).
