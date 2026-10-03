# KOBE-30: Run orchestrator: lock, queue, steer, stop, retry

- **Status:** in review (PR #40)
- **Branch / worktree:** `kobe-30-run-orchestrator` in `../Kobe-wt30`
- **Depends on:** KOBE-29 (schema), KOBE-24 (wire), KOBE-31 (event stream), KOBE-34 (thread API),
  KOBE-35 (policy), KOBE-15 (audit), KOBE-22 (provider), KOBE-9 (isolation) — all merged. KOBE-46
  (PR #35) not merged when this started: seam left (see below).

## Acceptance criteria (derived from D14–D17, D29, D30, §5.2, §6.1, Gate 1; Hadron unreachable)

1. **ac-1 Messages.** `POST /v1/threads/{id}/messages {content, parent_entry_id?, file_ids?}` →
   `{run_id, queued}`: starts a run at once on an idle thread, else queues it (D17).
2. **ac-2 One active run per thread** across replicas: thread row lock + the KOBE-29 partial unique
   index; queue order with promotion when a run ends (any replica, any cause).
3. **ac-3 Steer** into the active run (`run.steer` → Pi `steer`), `steer.applied` recorded.
4. **ac-4 Stop**: active run → `cancelled` at once (Pi `abort`), queued message → deleted
   (`cancelled`); queued messages remain and the next starts (D17). Edit queued messages.
5. **ac-5 Interrupted + Retry (D14)**: interrupted thread holds its queue; Retry = new run with
   `retry_of_run_id`, ahead of the queue, latest ended run only, interrupted only, once (repeat =
   same run); "Continue without retry" resumes the queue. History intact.
6. **ac-6 Run status API** (`GET /v1/runs/{id}`, `GET /v1/threads/{id}/runs`), OpenAPI.
7. **ac-7 Multi-replica safety**: any replica takes any request; the sandbox may be on another
   replica (router); lost work (crash between commit and next step) is recovered by a sweep.
8. **ac-8 Wire hooks**: `onRunEnded` advances the queue; failed/timed-out starts are failed here.
9. **ac-9 Authorization** (D9, D23, KOBE-13/34): owner only, readers read-only, other users/teams
   404, Trash refused, deactivated/removed users can't start or steer.
10. **ac-10 Seams**: agent resolution (KOBE-46/47), budgets (KOBE-42: gate + `stopForBudget` with
    `after_step`), approval mode at creation (+ floors), isolation (D4), transition listeners
    (KOBE-10/64), model wiring (KOBE-40/41 via `config`).

## Design

`services/server/src/runs/` (built in `createServerDeps` as `deps.runs`):

| Module            | Role                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestrator.ts` | `DbRunOrchestrator implements RunOrchestrator` (+ `onRunEnded`, `sweep`, `useIsolation`, `idle`, `close`)                                     |
| `lifecycle.ts`    | `promoteInTx` (the only place a run becomes `running`), terminal event builders                                                               |
| `store.ts`        | run rows, computed queue rank, thread lock, `applyTransition` (run status + thread status + event in one tx), `bindUserEntry`                 |
| `dispatch.ts`     | sandbox-facing work after commit: `run.start`, durable stops (`runs.stop_mode`), budget stops, recovery of lost starts/stops                  |
| `access.ts`       | owner/visibility checks with the thread lock (KOBE-34 rules)                                                                                  |
| `sweeper.ts`      | finds lost starts, pending stops and stalled queues per team (read-only); the orchestrator acts on each with a re-check under the thread lock |
| `seams.ts`        | `RunAgentResolver` (KOBE-46/47), `RunBudgetGate` (KOBE-42), `IsolationProbe` (D4)                                                             |
| `errors.ts`       | `RunError` (contract `RUN_ERROR_CODES` + server codes) → HTTP status                                                                          |

Routes `routes/runs.ts` (two routers, mounted with one line each in `app.ts`): `POST
/v1/threads/{id}/messages`, `GET /v1/threads/{id}/runs`, `POST /v1/threads/{id}/queue/resume`,
`GET|PATCH /v1/runs/{id}`, `POST /v1/runs/{id}/steer|cancel|retry`. OpenAPI in
`openapi/runs.ts`; `document.test.ts` now checks the run routers too.

**Flow.** One short transaction per user action: `SET LOCAL lock_timeout = '2s'` → thread row
`FOR UPDATE` first (KOBE-34 `findThread` visibility, owner only, not in Trash) → account active +
member (`users FOR SHARE`, KOBE-13) → budget gate → insert the run `queued` → `promoteInTx` (moves
the head of the queue to `running` with `run.started` if nothing is active and the queue may
advance) → `run.queued` for a run that did not start → audit last. After commit the replica sends
`run.start` through `deps.sandboxWire.router` (background task). The wire ends runs it observes
and calls `onRunEnded` → bind the prompt entry → promote the next run.

## Decisions

1. **The thread row lock is the D17 mutex** (spec says "advisory lock"): `SELECT … FOR UPDATE` on
   `threads` in every transaction that creates, enqueues, promotes, stops or retries (KOBE-34
   requirement), backed by `runs_one_active_per_thread`. A row lock serializes the same way across
   replicas, is released with the transaction, and orders correctly with KOBE-24's ingest (which
   also locks the thread row before the run row). Lock timeout → 409 `thread_busy`; background
   promotion retries 4× then leaves it to the sweep.
2. **Queue rank is computed, not stored.** `queue_pos` is a monotonic `max+1` at insert (unique
   among queued runs, KOBE-29); the API's `queue_pos` (1 = next) is the rank by (retries first,
   `queue_pos`). Dequeue/cancel never renumber, so the non-deferrable unique index never conflicts.
3. **Columns added to `runs`** (migration `0019_run_orchestrator`): `approval_mode` (text + check,
   default `ask-on-write`), `input` (the message; ≤ 200 000 chars; kept for queue edits and Retry),
   `parent_entry_id` (branch point: requested, else the leaf when the run started), `user_entry_id`
   (Pi id of the prompt, bound after the wire mirrored it), `retry_of_run_id` (team-scoped self FK,
   partial unique index: one retry per run), `budget_stop_scope` (pending budget stop). The
   contracts README lists `retry_of_run_id` as KOBE-26's; added here because Retry is in this
   ticket's scope — **KOBE-26 must not add it again.**
4. **Approval mode** is fixed at creation: requested (user: `ask-on-write` unless the command says
   otherwise; schedule: `auto`, D32) clamped to the KOBE-24 floor (`install_settings
['policy.approval_mode_floor']` + `teams.settings.approval_mode_floor`, stricter wins). The
   agent resolver may only tighten it at start. `createDbRunContextSource` now returns
   `runs.approval_mode`, and the policy check still clamps to the current floor per call.
5. **Retry = sibling branch.** The retry re-sends the original message with the original's
   `parent_entry_id`, so the interrupted branch stays in `thread_entries` (history intact, Gate 1)
   and the retry becomes its sibling. Pi 1.0 has no "continue without a new user message" over RPC,
   so a literal "continue from the last entry" isn't possible without duplicating the prompt.
   Retry copies trigger and approval mode; it is audited (`run.retried`).
6. **Stop writes Postgres first, then aborts Pi.** The run is `cancelled` with
   `run.interrupted {reason: cancelled, retryable: false}` in one transaction (contract), so the
   user sees it at once and late frames are refused by the wire. `run.stop {abort}` follows; the
   next queued run starts when Pi acknowledges the abort or after `stopGraceMs` (10 s), whichever
   first. **Wire change:** delivery used to drop `run.stop` once the run's lease had ended locally,
   which could leave Pi running after a Stop; it now delivers `run.stop` for any run leased to the
   connection (`DeliveryHost.hasLease`). Stop of a cancelled run is idempotent (200).
7. **Failed starts** (KOBE-24 contract): a `run.start` outcome that is not ok fails the run here if
   no lease exists (timeout before delivery, `thread_not_found`, …); with a lease the wire owns the
   run (reconnect resumes it, its sweep interrupts it) — except `timeout`, where the run is failed
   and Pi told to abort (`reason: user_cancelled`, the closest contract reason). `run.failed`
   carries the server's own message per code; sandbox text is never shown (logged only).
8. **Budget stop (D30 seam).** `stopForBudget`: queued runs → `budget_stopped` at once; active runs
   get `runs.budget_stop_scope` and `run.stop {after_step, budget_exhausted}`. **Wire change:**
   `endRunInTx` ends a run with a pending budget stop as `budget_stopped` (+ `run.budget_stopped`,
   audit) instead of `completed` when Pi settles after the step; if Pi never settles, the
   orchestrator ends it after the stop command returns.
9. **Promotion failures are visible.** A queued run that can't start fails (`run.failed`):
   `account_inactive` (owner deactivated or removed — all their queued runs on the thread),
   `agent_unavailable` (resolver error); the next one is tried.
10. **Recovery sweep** (every replica, jittered 15 s): `running` runs with no lease and no
    pending/delivered `run.start` command for `startDeadlineMs` (150 s, above the wire's 120 s
    start deadline) → re-sent (or `failed (start_lost)` past 15 min, see L3); pending stops →
    re-sent (item 3); threads with queued runs, nothing active and no run
    ended within `stallMs` (30 s) → promote. Re-checked under the thread lock.
11. **Audit:** `run.cancelled` (user; `wasActive`), `run.retried` (user), `run.budget_stopped`
    (system). **Run starts are not audited**: one per message, and every audit write serializes on
    the chain lock (docs/audit-log.md updated).
12. **Attachments:** `file_ids` non-empty → 422 `attachments_unavailable` until uploads exist
    (KOBE-53); ids that can't be checked are not passed to the sandbox.
13. **Isolation (D4):** new runs and retries are refused with 503 `isolation_unavailable` while the
    gate says `missing` (`index.ts` wires `useIsolation`); sandbox creation still enforces it via
    `isolation.require()` (KOBE-25/22 path, not bypassed here).
14. **Limits:** 25 queued messages per thread (409 `queue_full`); `steer.applied.content` capped
    at 50 000 chars (event payload cap 256 KiB).
15. Routes are mounted under `/v1/threads` and `/v1/runs` in a module of their own (answers
    KOBE-34's open question); `requireTeam` is idempotent so the shared prefix costs nothing.
16. `waiting_approval` runs can be steered and stopped (STEERABLE_RUN_STATUSES).

## For other tickets

- **KOBE-46/47 (agents):** implement `RunAgentResolver` (`runs/seams.ts`) and pass it as
  `createServerDeps({ runs: { agents } })`. It runs **inside the run-start transaction under the
  thread lock** (`promoteInTx`), receives the thread pin, the owner, trigger and the run's mode, and
  returns the exact version, a mode that may only be stricter (`effectiveApprovalMode`) and optional
  Pi config (model alias, prompt, skills). An error fails the run (`agent_unavailable`), never a
  fallback. The default `PASS_THROUGH_AGENTS` passes the pin unchanged (no thread can pin until
  #35). Tool gating at call time (`versionAllowsCall`) belongs in `RunPolicyContextSource`
  (KOBE-24), which now reads `runs.approval_mode`. **Floor key mismatch:** KOBE-24 reads
  `policy.approval_mode_floor`, PR #35 `policy.approval_floor` — one must be chosen.
- **KOBE-42 (budgets):** `RunBudgetGate.allowsNewRun` (submit + retry → 429 `budget_exhausted`)
  and `deps.runs.stopForBudget({team_id, user_id?, scope})`.
- **KOBE-40/41 (models):** the model alias goes in the resolver's `config.model`; `run.started.model`
  is not set yet. Usage (`run.completed.usage`, `run_usage`) is not accumulated (KOBE-24 neither).
- **KOBE-25 (wake):** nothing to call: the router wakes through `SandboxWaker`. Emitting
  `sandbox.waking` is left to KOBE-25 (it knows `hibernated` vs `first_start` vs `rebuild`); append
  it to the run with `appendRunEvents` while the run is `running`.
- **KOBE-26 (interrupted UX):** Retry and "Continue without retry" (`POST
/v1/threads/{id}/queue/resume`) are done at the API level; `retry_of_run_id` exists (don't add
  it). `runs.user_entry_id` is bound when the wire ends a run (first user message entry committed
  during it).
- **KOBE-32 (web):** send → `POST /v1/threads/{id}/messages` (`queued` → show as queued), then
  `GET /v1/runs/{id}/events`; queue panel → `GET /v1/threads/{id}/runs` (edit `PATCH
/v1/runs/{id}`, delete `POST …/cancel`); Steer → `POST /v1/runs/{id}/steer`; Stop → `POST
…/cancel` (stream ends with `run.interrupted {reason: cancelled}`); interrupted → Retry `POST
…/retry` or Continue `POST /v1/threads/{id}/queue/resume`. Errors are `{code, message}`.
- **KOBE-64 (schedules):** call `deps.runs.submitMessage(actor, {thread_id, content, trigger:
"schedule"})`; the run is `auto` (clamped to floors). `onTransition` reports transitions (wire
  ends are reported with `from: "running"`).
- **KOBE-37 (approvals):** Stop of a `waiting_approval` run doesn't expire pending approvals (no
  table yet); add that where runs end (here: `applyTransition` callers; wire: `endRunInTx`).

## Open questions (for Chris or the coordinator)

1. Retry semantics (decision 5): sibling branch with the same prompt. OK, or should Retry continue
   the interrupted branch (needs a Pi "continue" path)?
2. After Stop, queued messages start (contracts open question 4, D17 "queued messages remain").
   Implemented as start-next; switching to "Stop pauses the queue" is a one-line change in
   `#stopThenAdvance`.
3. Floor key mismatch with PR #35 (see KOBE-46 above).
4. Queue cap 25 per thread and 409 `queue_full`: fine?
5. Run starts unaudited (decision 11).

## Open risks

- A message sent right after Stop starts at once (no grace), as does a sweep promotion; with
  `stopGraceMs` (10 s), if Pi takes longer to abort, the next `run.start` reaches a Pi still
  aborting; KOBE-23's agent must queue or reject it (a rejection fails that run visibly).
- `user_entry_id` binding assumes the first user-message entry committed during a run is its
  prompt (true unless a steer message is committed before the prompt, which Pi doesn't do).
- The sweep scans every team every ~15 s per replica (two indexed queries per team), like the
  wire's sweep.

## Review round (code-reviewer agent, before CI) — resolution

No CRITICAL/HIGH. MEDIUM fixed: (1) the sweep advances each thread in isolation (one failing
thread no longer stops the others) and a resolver that throws fails its run `agent_unavailable`
instead of poisoning the queue; (2) `stopForBudget` retries busy rows and keeps stopping the other
runs, then reports the failures; (3) `onRunEnded` always advances the queue (listener errors and a
throwing extra hook are isolated). MEDIUM kept as a risk: after Stop, a message sent (or a sweep
promotion) within the abort window starts its run before Pi acknowledged the abort; the grace only
applies to the queue's own advance. See open risks.

## Coordinator review (PR #40, CHANGES REQUESTED, no CRITICAL/HIGH) — resolution

Tests in `runs-review.db.test.ts` (14), written against the reported sequences first.

1. **Retry after a deleted/failed queued message.** `retryCandidates` leaves out runs that ended
   without ever starting (`started_at IS NULL`, queued runs kept for the "already retried" check),
   so a cancelled queued message no longer hides the interrupted run (`not_latest`). **Contracts
   note:** `checkRetry`'s doc says "latest ended run"; it should say "latest run that ran" (for the
   next contracts PR; the contract is unchanged here).
2. **Interrupted run after a reload.** `GET /v1/threads/{id}/runs` (and `…/queue/resume`) now
   answer `{runs, interrupted_run}`: while the thread is `interrupted`, the run it waits on (else
   null). In OpenAPI (`ThreadRuns`). KOBE-26/32: offer Retry for `interrupted_run` after a reload.
3. **Durable stops.** Every transaction that ends or budget-stops a run Pi may still run (Stop of an
   active run, a timed-out leased start, a budget stop) also writes `runs.stop_mode`
   (`abort`/`after_step`) + `stop_requested_at`; the marker is cleared only when the sandbox answered
   the `run.stop` (or isn't connected: its next `hello` doesn't list ended runs and the agent aborts
   them, so it is never woken for a stop). The sweep re-sends pending stops with no `run.stop` in
   flight after `stopResendMs` (60 s; an after_step stop then ends the run `budget_stopped` if Pi
   didn't), and gives up after `stopGiveUpMs` (1 h). Chosen over enqueuing the wire's command row
   in the same transaction: `sandbox_commands` rows are owned by the router's request/response
   cycle (requester waits, takes and deletes the row), so a row without a waiting requester would
   be orphaned by design. Tests: crash between commit and send (abort sent by the sweep, marker
   cleared, late frames still refused); budget stop finished by the sweep; disconnected sandbox not
   woken.
4. **Retry requires `thread.status = interrupted`** (not after Continue), checked after the
   idempotent "already retried" answer; the retry's mode is the original's re-clamped to today's
   floors (test raises the team floor between the interruption and Retry).

- **L1** A repeated Retry returns the existing retry while it is queued, running or completed; if
  the retry failed, was stopped or budget-stopped → 409 "already retried once, and the retry …;
  send the message again"; if it was itself interrupted → 409 pointing at the retry run (retry
  that one). One Retry per run (D14 "manual retry", KOBE-26 unique index) stays.
- **L2** `queued` is true only when the run really waits (a run failed in the same transaction by
  the resolver answers `queued: false`, status `failed`).
- **L3** A `running` run with no lease and no `run.start` in flight (its starter died) is re-sent
  by the sweep while it started less than `restartWindowMs` (15 min) ago — safe because no lease
  means no sandbox ever received it (the lease is written in the delivering transaction); older →
  `failed (start_lost)`. The agent version is resolved again; branch point and mode are the ones
  fixed at start.
- **L4** `run.start` delivery locks the run row `FOR SHARE` before checking it is active and
  recording the lease, so a concurrent Stop is either seen (refused) or finds the lease (its
  `run.stop` follows on the same connection).
- **L5** Not audited, on purpose: `resumeQueue` (the user's own queue, no security effect),
  `steer` (message-level, like sends), failed promotions (system state, visible as `run.failed`
  in the run's events). Audited: Stop, Retry, budget stops, interruptions.
- **L6** `Idempotency-Key` header on `POST /v1/threads/{id}/messages` (1–128 visible ASCII,
  `runs.client_key`, unique per thread, checked under the thread lock): a repeat answers with the
  first run. **D17 team concurrency quota** (parallel runs in different threads count against the
  team's quota) belongs in `promoteInTx` (count the team's active runs before `queued → running`,
  leave the run queued and let the sweep/next end retry) — KOBE-42/44 owns the quota value.
- **L7** Forced interleavings with a second connection holding the thread row: lock timeout → 409
  `thread_busy`; Stop and the wire's settle queued behind the same lock → exactly one terminal
  event; promotion backoff (waiting → timeout → waiting again → promoted); two `onRunEnded` on two
  replicas → one run started. Reader → `read_only` is tested at the access layer
  (`lockOwnedThread` with a project viewer) because projects don't exist yet (KOBE-57 must add the
  HTTP test). Deactivated user steer → `forbidden`, nothing sent.

Refactor: sandbox-facing work moved to `runs/dispatch.ts` (start, durable stops, budget stops,
recovery) and thread access to `runs/access.ts`; `sweeper.ts` only finds work.

## KOBE-46 merged (#35) — run-start pin resolution

`runs/agents.ts` `PINNED_AGENTS` is now the production resolver (wired in `createServerDeps`; tests
may override `runs.agents`): inside the run-start transaction, under the thread lock, it calls
`resolvePinnedAgent(tx, {team, owner}, {agentScope, agentId, agentVersion})` — never a fallback; an
error fails the run `agent_unavailable` — and makes the mode only stricter:
`strictestApprovalMode(run mode, effectiveApprovalMode(version.toolManifest, readApprovalFloor))`.
Unpinned threads still get KOBE-46's install floor. **Both floor keys now apply** (KOBE-24's
`policy.approval_mode_floor` + team floor at creation, KOBE-46's `policy.approval_floor` at start);
which key survives is still the coordinator's call. Left to KOBE-47/41: Pi config from the version
(model alias, prompt, skills, connectors) and per-call `versionAllowsCall` in
`RunPolicyContextSource`. Test: "starts with the thread's exact pinned version and fails visibly
when it is unavailable". Migration regenerated as `0021_run_orchestrator` (`db:rebase`).

## Evidence (acceptance criteria → test or command output)

`services/server/src/runs.db.test.ts` (20 tests), `runs-concurrency.db.test.ts` (5),
`runs/lifecycle.test.ts` (3), `openapi/document.test.ts` (5), `packages/db/src/conversations.db.test.ts`
(+2). All against real Postgres, the real KOBE-24 wire over WebSockets, two replicas; scripted
sandboxes answer like Pi (per-thread sessions, restore, per-run seqs).

| AC     | Evidence                                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1   | "starts a run on the owner's sandbox held by the other replica, then completes it"; "validates bodies strictly"; "branches from parent_entry_id"                                                                                                  |
| ac-2   | "queues behind the active run in order and promotes the next"; "twelve messages at once on two replicas: one runs, eleven queue in distinct positions"; "two replicas promoting the same stalled queue start exactly one run"                     |
| ac-3   | "injects into the active run and records steer.applied; refuses queued and ended runs"                                                                                                                                                            |
| ac-4   | "cancels the active run at once, aborts Pi, refuses its late frames and starts the next"; "edits and deletes queued messages"; "Stop racing the wire and new messages: each run ends exactly once and at most one run is ever active" (6 rounds)  |
| ac-5   | "killing the sandbox mid-run interrupts it, blocks the queue, and Retry runs first with history intact" (restore from Postgres, sibling branch); "refuses Retry … not interrupted or not the latest"; "Continue without retry"                    |
| ac-6   | snapshots parsed with `runSnapshotSchema`; `document.test.ts` (documented = mounted for both routers, §6.1 shapes)                                                                                                                                |
| ac-7   | requests and sandboxes on different replicas throughout; "the sweep fails runs whose start was lost and promotes stalled queues"; "delivers to a sandbox that connects after the message (wake)"                                                  |
| ac-8   | "fails a run whose sandbox never answers run.start, and moves the queue on"; "reports transitions decided here and runs the wire ended"                                                                                                           |
| ac-9   | "hides runs and threads of teammates and other teams…" (404 everywhere, removed member 403, team header); "refuses messages on a thread in Trash"; "Trash racing a message: never leaves a run on a trashed thread" (8 rounds); deactivated owner |
| ac-10  | "stops queued runs at once and the active run after its step" (budget); "fixes the approval mode at creation…" (floor); "refuses new runs while the isolation runtime is missing"                                                                 |
| Gate 1 | "Gate 1: two teams × five users chat concurrently": 10 users, 10 sandboxes, alternating replicas; each refreshes mid-run and resumes with `Last-Event-ID` gapless (seqs = DB = 1..n, `run.started` … `run.completed`); 404 on others' runs        |

e2e (`e2e/run.sh` "runs (KOBE-30)"): through the server in the k3d install, a member sends a message
(starts), a second (queues), reads the run, stops both, reads the event stream (`run.started`,
`run.interrupted`), Retry of a cancelled run → `invalid_transition`.

Commands: `pnpm build typecheck format:check` green; `lint` green except the pre-existing
`@kobe/chart` Helm 4 failure; `license:check` fails locally only on the pre-existing optional
vitest peer entry (same as main, noted in KOBE-24); `pnpm test --concurrency=2` green;
`@kobe/server test:db` 341/341; `@kobe/db test:db` 249/249; `db:check` clean after commit;
`scripts/check-public-hygiene.sh` ok.
