# KOBE-24: Server sandbox connection registry and routing

- **Status:** in review (PR #33)
- **Branch / worktree:** `kobe-24-sandbox-registry` in `../Kobe-wt24`
- **Depends on:** KOBE-23 (sandbox agent), KOBE-31 (append path), KOBE-35 (policy engine), KOBE-29
  (schema), KOBE-14 (authz), KOBE-15 (audit) — all merged; KOBE-22 (sandbox provider, PR #20) still
  open: the listener wiring waits for it (see "For KOBE-22").

## Acceptance criteria (derived from spec D11, D13, D14, D15, D16, D29, §5.2, the wire contract; Hadron unreachable)

1. **ac-1 Endpoint.** `/v1/sandbox/connect` WebSocket on the sandbox listener only; upgrade refused
   without Bearer token (audience `kobe.sandbox-wire`, never in the URL), subprotocol, live sandbox,
   active account and team membership; frame cap at the WS layer; `hello`/`hello.ack` with per-run
   `durable_seq`; close codes per contract.
2. **ac-2 Registry across replicas.** Postgres is the record of which replica holds a sandbox's
   socket; LISTEN/NOTIFY carries id-only hints; no Redis. One connection per sandbox (newer wins,
   older closed `replaced`).
3. **ac-3 Routing API.** Any replica sends `run.start/steer/stop`, `pi.command` to a (user, team)
   sandbox and gets its `command.result`; disconnected sandboxes are woken (KOBE-25 seam) and get
   the command on connect; deadlines; never into another user's thread.
4. **ac-4 Durable cursor.** `runs.sandbox_seq` advanced by compare-and-set in the same transaction as
   the appended `run_events`/`thread_entries`; ack after commit; duplicates dropped and acked; gaps
   answered with `resend` on the live socket; resume after reconnect.
5. **ac-5 Leasing.** Every inbound frame's run/thread/command id must be leased to its connection
   (else `unknown_*` + close `lease_violation`, audited); leases end when the run goes terminal (late
   frames → `run_not_active`, late `policy.check` → deny).
6. **ac-6 Translation + mirroring.** Pi events → Kobe events (deltas batched); session entries
   mirrored into `thread_entries` (validated, untrusted); lost volume → `session.restore`.
7. **ac-7 Policy.** `policy.check` → KOBE-35 engine outside `withTeam`, after verifying membership and
   clamping the approval mode; `require_approval` through a pluggable broker (default deny);
   `policy.pending`/`policy.result` per contract.
8. **ac-8 Interrupted runs (D14).** Runs whose sandbox or Pi is gone become `interrupted` (never
   retried), with `run.interrupted`, thread `interrupted`, audit.
9. **ac-9 Heartbeats, timeouts, backpressure, limits, logging/metrics without secrets.**
10. **ac-10 Tests:** two replicas routing to one connection, reconnect + resume with duplicates and
    gaps, lease violations, terminal-run late frames, cross-team isolation, compromised sandbox
    (forged ids, oversized/hostile frames, floods).

## Design

`services/server/src/sandbox-wire/` (exported from `index.ts`; built in `createServerDeps` as
`deps.sandboxWire`):

| Module            | Role                                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway.ts`      | upgrade checks (path, no forwarded headers, per-address attempt limit, subprotocol, token, liveness, membership, socket cap), `ws` `maxPayload` = 4 MiB                                                                   |
| `connection.ts`   | per-connection state machine: hello → register → leases → `hello.ack`; frame rate limit; lease checks; ping/pong, heartbeat timeout, row touch, periodic revalidation                                                     |
| `ingest.ts`       | per-run queue: translate, coalesce deltas (≤ `batchWindowMs`), one transaction per batch (thread lock if needed → CAS on `sandbox_seq` → mirror → append → end run), ack after commit, dup/gap/resend, per-run memory cap |
| `translate.ts`    | Pi → Kobe mapping table (doc comment); every produced event passes its protocol schema or is dropped                                                                                                                      |
| `entries.ts`      | `get_entries` validation and mirroring, `entry.committed`, paged `session.restore` parts                                                                                                                                  |
| `delivery.ts`     | command rows → wire frames on the current connection (fresh `command_id` per connection), session check/restore before a thread's first run, results back to the row                                                      |
| `commands.ts`     | `sandbox_commands` store (enqueue, deliver, complete, expire, orphan reconcile)                                                                                                                                           |
| `router.ts`       | `SandboxRouter` (the routing API), result waiting (hint + poll + deadline)                                                                                                                                                |
| `registry.ts`     | local connections + `sandbox_connections` rows (register ordered by row lock, kick, touch, close)                                                                                                                         |
| `bus.ts`          | one LISTEN connection per process on `kobe_sandbox`; hints `cmd`/`res`/`kick`/`user` carry one uuid                                                                                                                       |
| `policy-check.ts` | `policy.check` → engine; `ApprovalBroker` (default deny), run context source, mode clamp                                                                                                                                  |
| `run-state.ts`    | `endRunInTx` (thread lock → run lock → `canTransition` → status, thread status, terminal event, audit)                                                                                                                    |
| `sweeper.ts`      | lost-sandbox sweep and command expiry, per team, re-checked inside the ending transaction                                                                                                                                 |

DB (`packages/db`): `runs.sandbox_seq integer NOT NULL DEFAULT 0` (conversations area, check ≥ 0,
trigger: never decreases); sandbox-area team tables `sandbox_connections` (PK team, user),
`sandbox_commands` (short-lived, content-bearing, deleted when consumed), `sandbox_run_leases` (FK →
runs/threads, cascade). RLS ENABLE + FORCE + canonical policy (`0017_sandbox_wire_rls.sql`), probe
fixtures. Audit actions `run.interrupted`, `sandbox.lease_violation` (+ categories `run`,
`sandbox`; documented in `docs/audit-log.md`).

## Decisions

- **Batch CAS.** The contract's per-frame `UPDATE … SET sandbox_seq = $s WHERE sandbox_seq = $s-1` is
  applied per batch: `SET sandbox_seq = last WHERE sandbox_seq = first - 1 AND status IN (active)`,
  in the same transaction as everything the batch writes. Same exactly-once guarantee; a batch is
  contiguous by construction. A failed CAS re-reads the cursor: ended run → `run_not_active` + ack;
  else ack (all duplicates) or `resend`.
- **Own batcher instead of `createRunEventBatcher`.** The KOBE-31 batcher cannot tell its `write`
  which wire seqs a batch covers (merging drops any marker), and Pi events that produce no Kobe
  event must still advance the cursor. `ingest.ts` coalesces the same way (adjacent deltas of one
  message part, 16 Ki chars) and keeps ≤ 64 events per `appendRunEventsInTx` call.
- **Lock order.** A batch that mirrors entries or ends the run locks the thread row before the CAS
  (KOBE-29: thread before run), so "starts with the CAS" becomes "the CAS is the first run write".
  The sweep locks the connection row first, then thread, then run.
- **Backpressure without pausing the socket.** Pausing would also block `command.result` frames the
  ingest itself waits for (`get_entries` before a batch commits). Instead each run holds at most
  `runQueueMaxBytes` (16 MiB) of frames; past it frames are dropped and fetched again with `resend`
  once the queue drains (tested: 120 frames through a 2 KB cap, stored exactly once).
- **Entries come from `get_entries`, not the event stream.** Pi emits `entry_appended` only for
  extension entries (verified in the 1.0.0 docs), so persisted entries (with ids) are fetched with
  `get_entries {since: last mirrored}` at `turn_end`, `entry_appended` and `agent_settled`, mirrored
  in the batch's transaction, and streamed as `entry.committed` (payload omitted over 64 KiB).
  Assistant entries are bound to the deltas' `message_id`s in completion order. Before a thread's
  first `run.start` on a connection: `get_entries {since}`; `pi_rejected` (Pi lost our last entry,
  KOBE-23) → `session.restore` from Postgres in ≤ 2 MiB parts, then `run.start`.
- **`message_id` = `m<wire seq of message_start>`** (deterministic, unique per run). After a
  reconnect to another replica mid-message (or a failed batch) the next delta opens a new id.
- **Run end.** `agent_settled` → mirror entries → `completed` + `run.completed` in one transaction.
  `run.start` result error → `failed`; `disposition: "handled"` → `completed` (KOBE-23). Interrupts:
  a reconnect whose `hello` doesn't list an active leased run (`not_resumed`), `pi.exited`
  (`pi_exited`), the sweep after `lostGraceMs` (30 s) without a live connection (`sandbox_gone`).
  All through `endRunInTx` (guarded by `canTransition`, so Stop racing an interrupt is harmless).
- **Late frames** of ended runs are acked (so the agent's outbox can forget them) and answered
  `run_not_active`; a late `policy.check` gets `deny`. Never-leased ids, thread mismatches and
  never-issued command ids close with `lease_violation` and record `sandbox.lease_violation` (at most
  once per sandbox and kind per 5 minutes per replica).
- **Commands survive replica boundaries via Postgres.** A command is a `sandbox_commands` row (frame
  without `command_id`), hinted to the holder with `cmd:<connection_id>`; the holder mints a fresh
  `command_id` per delivery and only delivers on the sandbox's current connection; the result is
  written back and hinted with `res:<command_id>`; the requester reads and deletes the row (content
  does not linger; leftovers expire in the sweep). After a reconnect, commands delivered on the old
  connection are reconciled: `run.start` of a resumed run → ok, otherwise `sandbox_lost` /
  `connection_lost` (callers decide whether to re-issue; ids are per connection).
- **Upgrade auth = HTTP 401 before the WebSocket exists** for bad/missing tokens, dead sandboxes,
  deactivated users and non-members (the agent backs off on any failed dial). `hello.sandbox_id ≠
sub` closes `unauthorized`; Pi outside `1.0.x` closes `unsupported_version`.
- **Principal re-checked while connected**: every `revalidateMs` (60 s) liveness (`sandbox_destroyed`
  when gone) and account + membership (`unauthorized`); deactivation closes connections on every
  replica at once (`UserLifecycle` hook → `user:<id>` hint). Token expiry (15 min) is not enforced
  on an open connection; the revalidation replaces it.
- **Policy.** The approval mode comes from `RunPolicyContextSource` (KOBE-30 adds
  `runs.approval_mode`); default `ask-on-write` (D29), scheduled runs `auto` (D32), clamped up to the
  context's `floor`. Membership and account are checked before every decision. Server-side denials
  with no matching contract code (run not active, not a member, internal) use
  `install_deny_rule`/`install_deny` with a message, as KOBE-35 does. Denials append `policy.denied`.
  At most 16 concurrent checks per connection; a replayed `request_id` is answered once.
- **Pi extension dialogs** (`pi.ui_request`): Kobe v1 has no UI for them; `select/confirm/input/
editor` are cancelled, notifications ignored; deduped by `(thread_id, request.id)` (`UiBroker`
  seam).
- **No pod creation here**, so no `VerifiedIsolation` needed (KOBE-9); waking is KOBE-25's seam.
- **Upgrade and frame limits** see the security review resolution below.
- **Second LISTEN connection per process** (`kobe-sandbox-bus`) next to the event-stream hub's; the
  hub is run-event specific. Same robustness (reconnect, resync, poll while down, ping). Needs a
  direct or session-mode connection, like the hub.
- New dependency for `@kobe/server`: `ws` ^8.22 + `@types/ws` (MIT; already in the lockfile via
  KOBE-23).

## For KOBE-22 (sandbox provider, PR #20) — the remaining wiring

When #20 merges, in `services/server/src/index.ts`, after `sandboxServer` is created:

```ts
deps?.sandboxWire.attach(sandboxServer, {
  verify: (token) => verifySessionToken(token, "kobe.sandbox-wire", keys["kobe.sandbox-wire"]),
  liveness: { isLive: (c) => /* claim u-<user> in the team namespace with UID c.sandboxId */ },
});
```

The WebSocket must stay on the sandbox listener (port 8081), never on `createApp`. Liveness is
called at every upgrade and every 60 s per connection: cache it (e.g. list claims per namespace).

## What other tickets must know

- **KOBE-30 (orchestrator):** use `deps.sandboxWire.router` (`startRun`, `steerRun`, `stopRun`,
  `piCommand`, `isConnected`); results are `{ok, data?} | {ok:false, error:{code,message}}` and never
  reject for sandbox problems. The wire ends runs itself on `agent_settled` (completed), a rejected
  or handled `run.start` (failed / completed) and lost sandboxes (interrupted), each in one
  transaction with the terminal event; then calls `hooks.onRunEnded` (release the thread lock,
  advance the queue). Stop/cancel/budget stays yours (set the terminal status + event; late frames
  are then refused here). **If `startRun` fails with `timeout`/`thread_not_found`, fail the run
  yourself** (no lease exists, so the sweep won't). `steer.applied` is not emitted here. Provide
  `RunPolicyContextSource` (approval mode, floor, agent tools) and add `runs.approval_mode`.
  `RunOrchestrator.markSandboxLost` is not needed for wire-detected losses.
- **KOBE-25 (wake):** implement `SandboxWaker.wake(target)`; it is called when a command finds no live
  connection; the command waits (up to its deadline) and is delivered on `hello`.
- **KOBE-26 (retry):** interrupted runs carry `run.interrupted {reason:"sandbox_lost", retryable:true}`
  and audit `run.interrupted.cause`; the thread is `interrupted`.
- **KOBE-37 (approvals):** implement `ApprovalBroker.request(req, onPending)`; call `onPending` with
  `{approvalId, expiresAt}` to send `policy.pending`; resolve `allow` (with the signed token) or
  `deny`; abort on `req.signal`. Expire the run's pending approvals in `endRunInTx` before the
  terminal event (seam noted there).
- **KOBE-36 (kobe-policy):** the server answers every `policy.check` exactly once per `request_id`.
- **KOBE-46/47:** feed agent `tools.allow/deny` through `RunPolicyContextSource`.
- **KOBE-42 (budgets):** usage is not accumulated here (`run.completed.usage` omitted).

## Open questions (for Chris or the coordinator)

1. Contract gaps (for a contracts PR, not changed here): no policy reason code for "run not
   active"/"not a member"/"internal" (KOBE-35 has the same gap); the per-frame CAS statement could
   be stated per batch; `kobe.event_dropped` is not documented in `pi-events.ts` (KOBE-23 item 6).
2. `run.stop`'s deadline is 10 minutes (the agent answers after the run ended; `after_step` waits for
   the next `turn_end`). OK, or should the orchestrator stop waiting earlier?
3. Thread entries have no per-thread cap; a hostile sandbox can grow its own thread's history (only
   its own team/user). Restore is paged, so memory stays bounded. Cap needed?

## Open risks

- Message id binding to assistant entries is positional (completion order); a resend that starts
  after a `message_start` gives later deltas a new id, so `entry.committed.message_id` may name the
  newer id.
- A thread with more than one 4 MiB frame of new entries at once is not mirrored by that sync
  (`frame_too_large`); later syncs catch up only if Pi's response fits.
- Two LISTEN connections per process; NOTIFY volume per command is two hints.

## Review round (code-reviewer agent, before PR) — resolution

1. HIGH unhandled rejection in the ingest worker → `#start()` catches into `#recover`;
   `fetchNewEntries` inside the try.
2. MEDIUM translator state after a failed batch → translator recreated on recover.
3. MEDIUM sweep aborted by one team → per-team try/catch (`failedTeams`).
4. MEDIUM sweep vs reconnect race → the ending transaction locks the connection row and re-checks
   "gone" (test: "the sweep keeps a run whose sandbox reconnected").
5. MEDIUM replaced connection delivering → delivery requires the current connection row
   (`FOR SHARE`), else closes itself.
6. MEDIUM registration races → insert-first, row-lock-ordered generations; a connection torn down
   while registering unregisters (test: three simultaneous connects → one survives, one open row).
7. MEDIUM resend dedupe could stall a retry → retries bypass the dedupe.
8. MEDIUM memory → paged restore; policy concurrency 16; per-run queue cap tunable.
9. LOW: socket cap counts accepted sockets; ended leases pruned (256); replayed `request_id`
   answered once (test); UI broker exceptions contained.

## Coordinator security review (PR #33, REQUEST CHANGES, no CRITICAL) — resolution

1. **HIGH event-loop saturation.** Per-connection **byte** token bucket (`byteRatePerSec` 4 MiB/s,
   `byteBurst` 8 MiB) next to the frame bucket, both charged on the raw frame **before decoding**.
   Size cap by type read from the raw prefix (`{"v":1,"type":"…"`, the order KOBE-23 writes):
   `pi.event`/`command.result` ≤ 4 MiB, `policy.check` ≤ 1 MiB, anything else (or an unreadable
   type, or anything before `hello.ack`) ≤ 256 KiB. Violations close `protocol_error` and audit
   `sandbox.limit_exceeded`. **Deviation:** `policy.check` gets 1 MiB rather than < 256 KiB because
   it carries a `write` tool's content as executed (KOBE-23 keeps that line at the frame cap); 1 MiB
   still bounds decode cost and is above any single model tool call in practice. Tests: "caps frame
   size by type before decoding", "closes a sandbox that sends more bytes than its budget".
   **Contract note:** large frames must start with `v` and `type` (true for KOBE-23; worth stating
   in `connection.ts`).
2. **MEDIUM logs leaking content.** Server-wide pino `err`/`error` serializer (`log-safety.ts`,
   `LOGGER_OPTIONS` in `logger.ts`): query errors (`DrizzleQueryError`, anything with
   `query`/`params`, and their pg causes) are logged as type + pg code + pg message (+ routine), never
   query, params, `detail`, `where` or the leaking stack; other errors keep type/message/code/stack;
   causes recursively (depth 4). Test: `log-safety.test.ts`.
3. **MEDIUM floor.** `RunPolicyContext.floor` is required and `runContext` is a required option of
   `createSandboxWire`; production uses `createDbRunContextSource()`: install floor in
   `install_settings['policy.approval_mode_floor']`, team floor in
   `teams.settings.approval_mode_floor`, the stricter of both; absent = `auto` (no floor beyond D29),
   unreadable/invalid → the call is denied. (KOBE-35 has deny/ask rules but no mode floor; this
   adds the two keys. An admin UI/API to set them is KOBE-20/35 follow-up.) Test: "applies the
   install and team approval-mode floors and denies when a floor is invalid".
4. **MEDIUM unbounded growth.** Enforced in the cursor transaction: `runMaxEvents` 100 000
   (`runs.last_seq`, room kept for the terminal event), `runMaxBytes` 256 MiB (new column
   `runs.sandbox_bytes`, events + mirrored entries, migration `0018`), `threadMaxEntries` 50 000
   (`threads.last_entry_seq`). At a cap the batch rolls back, the run fails (`run_too_large` /
   `thread_too_large`), Pi is stopped (`run.stop` abort, reason `budget_exhausted` — the closest
   contract reason), audit `sandbox.limit_exceeded`. `policy.denied`: per-run token bucket (burst 20,
   30/min) and the event cap; every call is still denied. All `WireTuning` options. Tests: four
   "storage caps" tests.
5. LOW timed-out internal command ids are retired as answered (test "treats a result after the
   command timed out as late"; red without the fix).
6. LOW connections close `unauthorized` at token `exp` + `tokenExpiryGraceMs` (60 s; test); the
   `user:<id>` hint now means "re-check this user's connections" (`revalidateUser`), called on
   deactivation and on team member removal (`DELETE /v1/team/members/:id`; test).
7. LOW `get_entries` failing at `agent_settled` is retried (3 attempts, backoff); if it still fails
   the thread is flagged for a full sync before its next run, then the run completes (Pi keeps the
   entries; `since` fetches them later). Logged.
8. LOW `staleConnectionMs` 60 s → 180 s (12 touch intervals); closed connections still use the 30 s
   grace; the ending transaction re-checks under the connection row lock.

Also found while testing: a single frame larger than `runQueueMaxBytes` was never accepted (the
run stalled); an empty queue now always takes the next frame (memory ≤ cap + one frame).

**For KOBE-22 wiring (unchanged requirement):** `verify` must be KOBE-22's `verifySessionToken`
(HS256 pinned, exact header, audience key). Sandbox tokens have no Better Auth session; the KOBE-13
"session still exists" check maps to: sandbox `sub` live (`liveness`), account active and team
membership — checked at upgrade, every 60 s, on deactivation/removal hints, and the connection ends
at token expiry.

## Evidence (acceptance criteria → test or command output)

`services/server/src/sandbox-wire.db.test.ts` (32 tests), `sandbox-wire-limits.db.test.ts` (10), `log-safety.test.ts` (3),
`sandbox-wire/translate.test.ts` (9), `packages/db/src/sandbox-wire.db.test.ts` (6); wire suites
stable over 4 repeated runs.

| AC    | Evidence                                                                                                                                                                                                                          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1  | "upgrade authentication" (401 missing/forged/dead/non-member, 400 subprotocol, 404 path/forwarded; close 4001/4002/4006/4005)                                                                                                     |
| ac-2  | "delivers run.start from replica 1 to the sandbox held by replica 0", "closes the older connection with `replaced`", "keeps exactly one connection when the same sandbox connects twice at once"                                  |
| ac-3  | "routes pi.command and steer…", "queues commands for a disconnected sandbox, wakes it…", "times out…", "never routes into another user's thread", "a run.start the sandbox rejects fails the run"                                 |
| ac-4  | "translates, batches, mirrors…" (cursor 8, acks), "drops duplicates (acked) and answers gaps with resend", "resumes after a reconnect to the other replica"; db: "starts at 0 and advances by compare-and-set", "never decreases" |
| ac-5  | "closes with lease_violation for a run of another sandbox (forged run id) and audits it", "random run id, thread mismatch, unknown command id", "late frames for ended runs"                                                      |
| ac-6  | "translates, batches, mirrors entries and completes the run" (coalesced `abc`, `entry.committed` bound to `m2`), "session restore (lost volume)"; `translate.test.ts`                                                             |
| ac-7  | "policy.check": read allowed, unknown tool denied + `policy.denied`, approval denied by default broker, non-member denied, replay answered once                                                                                   |
| ac-8  | "interrupts runs the reconnected sandbox no longer lists" (status, event, thread, audit), "the sweep interrupts…", "pi.exited interrupts…", "the sweep keeps a run whose sandbox reconnected"                                     |
| ac-9  | limits: heartbeat timeout, revalidation `sandbox_destroyed`, backpressure exactly-once; "closes a flooding sandbox", "refuses oversized frames" (1009), deactivation closes on every replica                                      |
| ac-10 | all of the above; "cannot reach another team's runs (cross-team isolation)", "answers hostile frames with malformed_frame and keeps the connection"                                                                               |

Commands: `pnpm build typecheck format:check` green; `lint` green except the pre-existing
`@kobe/chart` Helm 4 failure; `license:check` fails locally on an uninstalled optional vitest peer
variant referenced by `better-auth` (same lockfile entries on `main`; not from this change);
`pnpm test --concurrency=2` green; `@kobe/server test:db` 316/316 (after the security review; wire suites 42/42, stable over 3 more runs), `@kobe/db test:db` 247/247; `db:check` clean; `scripts/check-public-hygiene.sh` ok.
