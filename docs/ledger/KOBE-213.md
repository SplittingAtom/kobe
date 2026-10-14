# KOBE-213: B9 Compaction: route, sandbox-agent mapping to Pi compact, Compact now dialog

- **Status:** in review (migration PR #275, feature PR pending)
- **Branch / worktree:** `kobe-213-compact-now` in `../Kobe-wt213`; migration `kobe-213-migration`
  in `../Kobe-wt213m`
- **Depends on:** KOBE-212 (contract, #274), KOBE-209 (marker), KOBE-211 (gauge). Spec CE15.

## Plan

Migration PR first (#275: `runs.kind`, `thread.compact` command kind), then one feature PR with
server, sandbox-agent and web in separate commits. REVIEW-274 HIGH and MEDIUM points are binding.

## Decisions

- **A compaction is a run, `runs.kind = 'compaction'`** (coordinator decision; migration 0094).
  It is created `running` under the thread lock (`runs/compaction.ts`). It is never queued: a
  thread that isn't idle, or has an active run, gets `thread_busy`. It never retries; an
  interrupted one ends `failed`, so the thread doesn't wait on Retry (`endRunInTx`).
  `kind` is server-only. It's filtered from `listThreadRuns`, pending messages, Retry, the latest
  interrupted run, markers, steering and the gauge's `latest_call`. Usage totals and budgets
  still count compaction spend.
- **Delivery = `run.start`'s** (`delivery.ts`): wake, entry sync or session restore, lease and
  `mintRunToken` in the claim transaction. It's sent only to agents announcing `thread_compact` +
  `run_token` with a run token key; otherwise `compact_unsupported` and the run fails.
  `thread.compact_result` is accepted only for a `thread.compact` command id issued on that
  connection with the same thread. Anything else is a lease violation and still settles its
  command. It has its own 1 MiB size cap in `#sizeOk`.
- **End of a compaction:** the delivering replica fetches `get_entries since` (Pi doesn't announce
  the entry), mirrors it, ends the run (the token is revoked by the run end trigger), then
  records the result. The requester (route) ends the run itself when no answer came (timeout,
  lost connection, wake failure). It requests and sends an `abort` when still leased, then
  audits `thread.compacted` (`outcome`, `focused` flag; never the focus text).
- **HTTP errors:** one fixed message per code (`compactThreadError`). Pi's or the sandbox's text
  is logged server-side (capped), never answered. Mapping: busy/nothing/model codes as is;
  pi_unavailable, timeout, connection_lost, wake errors → `sandbox_unavailable`; else
  `compaction_failed`. Usual `RunError`s: 404 `thread_not_found` (other team, other member's
  private thread), 403 `read_only`, 429 `budget_exhausted`.
- **Stop / budget:** Stop is the usual cancel (abort). It doesn't pause queued messages for a
  compaction. `stopForBudget` ends an active compaction `budget_stopped` at once and aborts it.
  The agent also treats `after_step` as abort while compacting (no `turn_end` ever comes).
- **Model:** the thread's next-run model (agent pin, else the thread's choice, else the team
  default). If an agent doesn't resolve, the thread's choice is used. No model:
  `model_not_configured`, no run created.
- **Token handover (M1):** the agent holds the token in memory (`attachRun`) and answers
  kobe-models' `kobe.run_token` dialog only for the active run. kobe-models now also fetches it
  on `session_before_compact` (compact fires no `input`). It's never written to disk or env, and
  a previous run's token is never reused (`held.runId` must equal the model file's `run_id`).
  `endRun` clears it.
- **Model selection:** Pi reads `this.model` before `session_before_compact`, so the agent
  selects the compaction model first. It checks `get_state`, else sends `set_model`, else restarts
  Pi once with the model in its model file. `set_model` is agent-internal: provider `kobe` only,
  after the KOBE-169 tripwire. The selected model must have the gateway's base URL, so a planted
  kobe model is refused.
- **Web:** "Compact now…" in a new thread actions menu in bar row two (`thread-actions`
  registry command; on one column it's inside the bar's Menu, CE8), and the gauge's red
  `compact-thread` action (now bound). Both open `compact-dialog.tsx` (Radix Dialog, optional
  one-line focus). They're enabled only while idle (`compactBlocker`) and absent for readers. The
  B5 marker shows the summary after the refresh. The B7 gauge hides after the compaction until
  the next call (unchanged).
- **Long request (L6):** the 200 waits for Pi (up to 12 min command timeout). Node's
  `requestTimeout` bounds receiving the request only. The dialog can be closed while it runs.

## Open questions (for Chris or the coordinator)

- An interrupted thread (waiting on Retry) can't be compacted (`thread_busy`). Is that OK, or
  should compaction keep the interrupted state?
- No `budget_exhausted` code in the compact contract: a spent budget answers the usual 429
  `budget_exhausted` (`RunError`) before anything starts. A budget stop mid-compaction answers
  `compaction_failed`.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/thread-compact.db.test.ts` (focus to the sandbox, run token, entry
  mirrored, summary answered, audit, gauge exclusion). `services/sandbox-agent/src/
kobe-models.compact.real-pi.test.ts` (real Pi 1.0.0 + gateway shim: the summary call carries
  the compaction run's id and token, the focus reaches the summary, model switch).
  `apps/web/components/chat/compact-dialog.test.tsx` (dialog → focus → marker shows the summary).
- ac-2: the same DB test (`thread_busy` while a run is active; delivered after the sandbox
  connects: wake). `agent.compact.test.ts` (agent-side busy refusal under the lock).
- ac-3: `e2e/run.sh` "compaction (KOBE-213)" (real sandbox on k3d: a large turn, Compact now
  with focus → 200, entry mirrored, second compaction 409 `nothing_to_compact`, `run_usage` on
  the compaction run).
