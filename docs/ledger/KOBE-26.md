# KOBE-26: Interrupted runs and manual retry

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-26-interrupted-runs` in `../Kobe-wt26`
- **Depends on:** KOBE-24 (wire: interruption), KOBE-30 (Retry, Continue, `interrupted_run`) —
  both merged. KOBE-25 (wake, PR #39) still open; nothing here depends on it.

## Acceptance criteria (spec D14, D15, §6.1, Gate 1; ledgers KOBE-23/24/30; Hadron unreachable)

1. **ac-1** A run whose sandbox dies mid-run (pod killed, Pi exits, connection lost past the grace
   period) becomes `interrupted` with `run.interrupted {reason: sandbox_lost, retryable: true}`,
   the thread `interrupted` (queue held), audited — never retried automatically.
2. **ac-2** Manual "Retry from last entry": a new run, once per run, ahead of the queue; the
   interrupted branch stays in history; "Continue without retry" resumes the queue.
3. **ac-3** History survives: entries mirrored before the death stay; entries Pi wrote after the
   last sync are kept when the volume survives; a lost volume is rebuilt from Postgres
   (`session.restore`) before the retry starts.
4. **ac-4** While interrupted, the thread, its entries, the run to retry and the closed event
   stream are readable without waking the sandbox (D14 "reading history never wakes").
5. **ac-5** Gate 1 e2e on k3d: kill the sandbox pod mid-run → interrupted + Retry, history intact.

## Verification of what KOBE-24/30 built (no change needed)

| Spec behaviour                                         | Where                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| interrupted on lost connection / Pi exit / not resumed | `sandbox-wire/sweeper.ts`, `connection.ts` → `endRunInTx` (event, thread, audit) |
| never auto-retried                                     | nothing re-sends an interrupted run; only `POST /v1/runs/{id}/retry`             |
| Retry once, latest run that ran, interrupted only      | `runs/orchestrator.ts` `retry`, `checkRetry`, unique `retry_of_run_id`           |
| queue held / Continue without retry                    | `nextThreadStatus`, `POST /v1/threads/{id}/queue/resume`                         |
| Retry offered after a reload                           | `GET /v1/threads/{id}/runs` → `interrupted_run`                                  |
| volume lost → session rebuilt                          | `sandbox-wire/delivery.ts` `#ensureSession` (`pi_rejected` → `session.restore`)  |
| volume intact → late entries mirrored                  | same, `get_entries {since}` before the thread's first `run.start`                |

## Gaps found and closed

1. **Retry of a thread's first run continued after the interrupted partial answer** instead of
   branching beside the prompt. A run that starts on an empty thread records no branch point
   (`parent_entry_id` null: Pi continues from its leaf); Retry copied the null, so at promotion
   the branch point became the thread's leaf — the interrupted run's last entry — and the retry
   re-sent the prompt after the half answer. Fix (`runs/store.ts` `retryBranchPoint`): Retry
   uses the original's branch point, or else the parent of the original's prompt entry
   (`user_entry_id`, bound on demand). Pi 1.0 writes a settings entry at the root before the first
   prompt (KOBE-23), so that parent exists. Test (red before the fix): "retries a thread's first
   run as a sibling of its prompt".
2. **No Gate 1 e2e.** Added `e2e/run.sh` "interrupted runs and Retry (KOBE-26)" (below).

## e2e design (`e2e/run.sh`)

- No model answers in e2e (KOBE-40/41), so real Pi can't be mid-run. A **scripted agent** holds
  the owner's sandbox identity: the server creates the owner's claim (`dist/cli/sandbox.js
ensure`), a wire token is minted in the server pod with the real keys for that claim's UID, and
  a gVisor pod in the team namespace (server image: Node + `ws`) speaks the real frames: `hello`,
  `get_entries`, `run.start` → root settings entry, prompt, streamed partial answer, `turn_end`,
  no `agent_settled`. The claim's own Sandbox is suspended first (best effort) so no real agent
  takes the identity (relevant once KOBE-25's bootstrap exchange lets real pods connect).
- Steps: connect (positive wait for `ready`) → message → wait until the partial answer is acked
  and mirrored (3 entries) → `kubectl delete pod --grace-period=1` → wait (≤ 240 s) for the run to
  be `interrupted` (logs the latency: connection loss + 30 s grace + sweep) → thread
  `interrupted`, audit cause `sandbox_gone` → API: thread status, `interrupted_run`, event stream
  `run.started,run.interrupted` with `sandbox_lost`/`retryable`, Retry 201 (not queued), repeat
  returns the same run, retry links the original, retry branch point = the root entry, entries
  from before the kill unchanged, the retry can be stopped.
- The agent script was run locally against the real wire (fixture listener) before CI.

## Decisions

- **No notifications for interrupted runs.** D14 asks for the interrupted state and a manual
  Retry in the UI; no notification is specified. The UI hooks are the event
  (`run.interrupted.retryable`), thread status `interrupted` in list/detail, and
  `interrupted_run` (KOBE-32 renders them). Scheduled runs that end interrupted are reported by
  KOBE-64's notifications (D32 "including failures").
- **Root prompts.** `run.start` cannot branch at the root (KOBE-23 contract note). If the prompt
  entry was never mirrored or sits at the root, Retry keeps the old behaviour (continue from the
  leaf); with Pi 1.0's root settings entry this does not happen in practice.
- `retry_of_run_id` already exists (KOBE-30): not added again.

## Open questions (for Chris or the coordinator)

1. D14 "Woken by: an approval answer for a run whose sandbox died": the sweep interrupts
   `waiting_approval` runs after the grace period like any other (Pi's in-flight tool call is gone
   with the pod). KOBE-37 should decide whether an approval answer for such a run wakes the
   sandbox only to show the interrupted state, or whether those runs wait.
2. KOBE-30 open question 1 still stands: Retry re-sends the prompt as a sibling branch (Pi 1.0
   RPC has no "continue from last entry").

## Evidence (acceptance criteria → test or command output)

`services/server/src/runs-interrupted.db.test.ts` (3 tests) plus KOBE-24/30 suites:

| AC   | Evidence                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ac-1 | "interrupts at once on the new pod's hello…" (cause `not_resumed`, event, thread, audit); KOBE-24 "the sweep interrupts…", "pi.exited interrupts…"; e2e (cause `sandbox_gone`) |
| ac-2 | KOBE-30 "killing the sandbox mid-run…", "Continue without retry"; "retries a thread's first run as a sibling of its prompt"; e2e Retry checks                                  |
| ac-3 | "…keeps what Pi wrote after the last sync, and retries" (no restore, tail entry mirrored); KOBE-30 restore test; first-run test restores on a new pod                          |
| ac-4 | "shows the thread interrupted with its entries, the run to retry and the closed stream" (no `sandbox_commands` row added by the reads)                                         |
| ac-5 | `e2e/run.sh` "interrupted runs and Retry (KOBE-26)" (CI `e2e` job)                                                                                                             |
