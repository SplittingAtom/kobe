# KOBE-25: Hibernation, wake, cold-start target

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-25-hibernate-wake` in `../Kobe-wt25`
- **Depends on:** KOBE-22 (provider), KOBE-24 (registry/routing), KOBE-23 (agent), KOBE-9 (gate) —
  all merged.

## Acceptance criteria (derived from spec D11–D14, §5.2, §5.4, §8, Gate 1; ledgers KOBE-9/22/23/24; Hadron unreachable)

1. **ac-1 Idle policy (D14).** An awake sandbox hibernates 15 minutes after its last activity
   (Helm default; team setting 5–60). Kept awake by a queued, running or approval-waiting run and
   by a command in flight. Activity = a routed command, a wake, a run's end. Hibernating never
   interrupts a run.
2. **ac-2 Hibernate = agent-sandbox `operatingMode: Suspended`** (v1beta1): pod gone, claim and
   `/workspace` PVC kept, `/tmp` and `$HOME` wiped. The wire connection is closed `hibernating`.
3. **ac-3 Wake path.** Router → `SandboxWaker` (KOBE-24 seam) → provider: `isolation.require()`
   first, pod template re-applied from the current settings with that `VerifiedIsolation`,
   `Running`, the new pod verified (RuntimeClass/handler; deleted on mismatch, KOBE-9). The waiting
   command is delivered on `hello`. Definitive failures (isolation missing, offboarded, not a
   member) fail the command at once.
4. **ac-4 Concurrency.** Two replicas waking one sandbox resume it once; two replicas sweeping
   hibernate it once; wake racing hibernate always ends awake and no command reaches a pod on its
   way out.
5. **ac-5 Audit.** `sandbox.hibernated`, `sandbox.woken` (team scope).
6. **ac-6 Cold-start harness (Gate 1).** 20 trials hibernated → probe, p50/p95 reported, CI-gated;
   extensible to first token once KOBE-40/41 land.
7. **ac-7 Tuning** to hit p95 ≤ 8 s; numbers recorded for CI (k3d) and notes for the real cluster.

## Design

- **Record:** new team table `sandboxes` (spec §5.4: `team_id`, `user_id` PK; `sandbox_id`
  (claim UID), `state` running|hibernated|destroyed, `pvc`, `last_active_at`, `state_changed_at`,
  `retain_until`), ENABLE + FORCE RLS, probe fixture. Kubernetes stays the record of what exists;
  the row is the record of Kobe's decision and of activity.
- **The row lock is the serialization point.** Every activity touch (command enqueue, wake) and
  every hibernate decision takes it:
  - hibernate (`sandbox-lifecycle/store.ts` `lockIfIdle`): `SELECT … FOR UPDATE SKIP LOCKED`,
    re-check idle (`GREATEST(last_active_at, latest run end)`), no queued/active run on the user's
    threads in the team, no pending/delivered command → **Kubernetes suspend inside the
    transaction** → `state = hibernated`, connection row closed, `hib:<connection>` hint (holder
    closes the socket `hibernating`), audit — one commit.
  - enqueue (`sandbox-wire/commands.ts`): `UPDATE sandboxes SET last_active_at = now()` before the
    insert, so a command arriving mid-hibernation waits for the lock, then sees no live connection
    and wakes the sandbox.
  - wake (`beginWake`): row → `running` + fresh activity under the lock, then the provider.
  - registration (`registry.register`): `SELECT state … FOR SHARE`; a hibernated sandbox's
    connection is refused `hibernating` (a pod on its way out never takes commands).
- **Provider** (`sandbox/provider.ts`): `wakeSandbox` (create if missing; resume if suspended:
  `require()` → JSON merge patch replacing `spec.podTemplate.spec` wholesale
  (`merge-patch.ts` nulls removed keys) + `operatingMode: Running`, guarded by the Sandbox's
  `resourceVersion` (409 → re-read) → the existing pod verification loop, which now skips a pod
  still terminating from the hibernation); `hibernateSandbox` (rv-guarded `Suspended`, idempotent,
  no isolation check). `KubeClient.patch` (merge patch) added; fake cluster simulates
  Suspended/Running and slow pod termination.
- **Lifecycle** (`sandbox-lifecycle/`): `createSandboxLifecycle` → `waker` (one wake per sandbox per
  process at a time; member + active account check; `SandboxWakeError` for definitive failures),
  `sweep` (every replica, `sandbox.hibernation.sweepSeconds`, jittered, ≤ 20 per team per sweep),
  `hibernate(target, {force})` for operators/harness. `index.ts` wires it through a deferred waker
  (the wire exists before the provider).
- **Router** fails a waiting command immediately on `SandboxWakeError`
  (`isolation_runtime_missing` / `sandbox_unavailable`); other wake errors are logged and the
  command waits for its deadline (a slow volume attach must not fail a run).
- **Agent bootstrap exchange** (`services/sandbox-agent/src/session/exchange.ts`): KOBE-22 gives
  pods only a projected bootstrap token, but the merged agent (KOBE-23) required
  `KOBE_SANDBOX_ID` + a wire-token file — real pods crash-looped on config. Bootstrap mode
  (`KOBE_BOOTSTRAP_TOKEN_FILE`, set by KOBE-22's pod spec) trades it at
  `POST /v1/sandbox/session` (re-read each attempt; 409/429 honour the server's delay; 2 s
  per-attempt timeout; 200 ms retries for 30 s while the CNI admits the new pod, then jittered
  backoff), learns the sandbox id, and re-trades 2 minutes before expiry. Runs in parallel with
  the `pi --version` probe at startup.
- **Chart:** `sandbox.hibernation.{enabled, idleMinutes (5–60), sweepSeconds}` → `KOBE_SANDBOX_CONFIG`.
- **Harness:** `dist/cli/cold-start.js` (in the server image) joins as a router-only replica,
  forces hibernation, waits until the pod is gone, then times a `pi.command get_state` on a
  harness thread through router → waker → provider → agent → Pi. Reports per-trial milestones
  (pod created, container started, wire connected, Pi ready) and p50/p95; budgets via
  `--p95-max-ms`/`--p50-max-ms`. `dist/cli/lifecycle.js hibernate|wake` for operators and e2e.

## Decisions

- **Idle = no activity, not "no connection".** An awake sandbox is always connected (the agent
  keeps the wire open), so connection presence can't signal idleness. Activity = commands routed
  to it, wakes, run ends; busy = queued/running/waiting_approval runs on the user's threads in
  the team, or commands in flight.
- **`waiting_approval` keeps a sandbox awake with no extra cap**: KOBE-37 ends the run when the
  approval expires (D29: 1 h TTL), which ends the keep-awake (spec: "up to the approval TTL").
- **Team setting key** `teams.settings.sandbox_idle_minutes` (integer 5–60; invalid → install
  default). No admin UI/API here (KOBE-20 follow-up).
- **Hibernation is decided by every replica** (no leader): `SKIP LOCKED` makes concurrent sweeps
  harmless.
- **Kubernetes suspend inside the DB transaction.** If the commit fails after the patch, the row
  stays `running` while the pod is gone; the next command finds no connection and resumes it —
  self-healing, never a stuck sandbox.
- **Offboarded (`destroyed`) rows are never woken** here; KOBE-28 owns re-creating a sandbox for a
  returning member (the PK is `(team_id, user_id)`, see open questions).
- **The warm pool does not help wake** (KOBE-22): a hibernated sandbox owns its PVC, so resume is
  always a cold pod start. Warm pods only serve first sandboxes (D14's 15 s target).

## Open questions (for Chris or the coordinator)

1. **Agent bootstrap exchange was missing** (KOBE-22 ↔ KOBE-23 gap): implemented here because
   cold-start can't be measured without a connecting agent. Please confirm it belongs in this PR
   (it touches `services/sandbox-agent/src/{config,index}.ts`, which KOBE-36 #32 also edits —
   small, mechanical conflict expected).
2. `sandboxes` PK is `(team_id, user_id)` (one live sandbox per user and team, D11). If KOBE-28
   must keep a retained volume's row next to a new sandbox for a returning member, it should move
   retention to its own table or re-key.

## Review round (coordinator, PR #39) — resolution

1. **HIGH Gate 1 honesty.** The harness and e2e measure **hibernated → Pi ready** (`pi.command
get_state`: agent reconnected + Pi spawned and answering), never labelled Gate 1. The gap to
   the Gate definition (hibernated → first token): run creation and `run.start` (KOBE-30), the
   model gateway and token verification (KOBE-40/41), and the model's time to first
   `text.delta`. Pi-ready is a lower bound. The harness takes a probe registry (`PROBES` in
   `cli/cold-start.ts`); `first-token` is one more entry once a model exists. Two trial sets run
   in e2e: 20 back-to-back and 5 spaced (30 s fully down before each wake); numbers below.
2. **MEDIUM data loss.** `ensureSandbox` on a suspended sandbox returns `suspended` _before_ the
   template RuntimeClass check (nothing runs; the claim owns the volume); only a wake replaces the
   template. The harness reads claim/Sandbox/pod directly (no `ensureSandbox`). Test: "never
   deletes a suspended sandbox for a stale template RuntimeClass".
3. **MEDIUM audit.** `sandbox.woken` is emitted by the provider as soon as the resume patch is
   committed (also when the new pod then fails verification and is destroyed — both audited).
   `hibernateSandbox` → `not_found`: no row change to `hibernated`, no audit; the stale sandbox id
   is cleared. `already_suspended` (a hibernation whose commit failed earlier): row updated, no
   second audit.
4. **MEDIUM transient wake failures.** The router retries a failed wake with jittered exponential
   backoff (1 s base, 10 s cap) while the command still waits and the sandbox isn't connected,
   within `wakeRetryBudgetMs` (90 s, never past the command's deadline − 2 s); then the command
   fails `sandbox_unavailable`. Definitive `SandboxWakeError`s still fail at once.

- L1: `lockIfIdle` locks (`FOR UPDATE SKIP LOCKED`) in one statement and runs the idle/busy/
  command checks in a second (fresh READ COMMITTED snapshot).
- L2: a sandbox that connects without a row (created before KOBE-25, or by an operator tool) is
  adopted at registration (`INSERT … ON CONFLICT DO NOTHING`), so the idle policy covers it.
- L3: the agent's fast session-exchange retry is jittered (100–300 ms).
- L4: e2e uses a dedicated cold-start user (own sandbox); the harness deletes its thread;
  `sandbox.hibernated` records `trigger` (`idle` | `operator`) — operator tools run without a
  user identity, so the actor stays `system`.
- Also: a sweep skips a row whose registration holds `FOR SHARE` at that instant (`SKIP LOCKED`);
  it is picked up on the next sweep.

## After merging main (KOBE-30 #40, KOBE-46 #35, CI stability #38)

- Migrations regenerated with `db:rebase`: `0022_sandboxes`, `0023_sandboxes_rls`.
- **`sandbox.waking` (KOBE-30 asked KOBE-25 to emit it).** `SandboxWaker.wake(target, {runId})`:
  the router passes the run of a `run.start` that found no live connection. Right after the wake
  decision (before any Kubernetes call) the lifecycle appends `sandbox.waking {reason}` to that
  run if it is still `running`: `hibernated` (row was hibernated), `first_start` (no row: first
  sandbox through Kobe). A `running` row whose sandbox is only disconnected (pod restart) is not
  announced; `rebuild` (volume lost) stays with the wire's `session.restore` (KOBE-24). Runs that
  join a wake already in flight are announced too. Tests: "tells the run whose start woke a
  hibernated sandbox", "first-ever … first_start; a finished run is told nothing".
- KOBE-30's e2e run-stop check accepts the optional `sandbox.waking` between `run.started` and
  `run.interrupted` (the owner's first run now really starts a sandbox).

## Evidence (acceptance criteria → test or command output)

| AC   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 | `sandbox-lifecycle.db.test.ts`: idle time + team setting, out-of-range setting, queued/running/waiting_approval never hibernated, run end counts as activity, command in flight, command touch; `idle.test.ts`                                                                                                                                                                                                          |
| ac-2 | `provider-lifecycle.test.ts` "suspends the Sandbox: its pod goes, the claim … stays"; db: closes the connection `hibernating`; e2e: Suspended, no pod, PVC Bound, row hibernated, `/tmp` wiped, `/workspace` kept                                                                                                                                                                                                       |
| ac-3 | `provider-lifecycle.test.ts`: require() before the patch, template re-applied (image, Service IP, stale field dropped), mismatch deleted + audited, terminating pod skipped, isolation missing → nothing patched; db: command wakes and is delivered on hello, fail-fast on missing isolation, non-member not woken, transient failures retried, budget → `sandbox_unavailable`; e2e: woken pod under gVisor reconnects |
| ac-4 | provider: concurrent wakes, stale-resourceVersion resume re-reads; db: two replicas sweeping hibernate once, wake racing hibernate (command waits for the lock, then wakes; old pod never gets it), hibernated pod's connection refused                                                                                                                                                                                 |
| ac-5 | provider + db audit assertions (targets validated against `AUDIT_EVENTS`); e2e counts                                                                                                                                                                                                                                                                                                                                   |
| ac-6 | `cold-start.test.ts` (nearest-rank p50/p95, trial ordering); e2e runs `dist/cli/cold-start.js`                                                                                                                                                                                                                                                                                                                          |
| ac-7 | Measurements: see below                                                                                                                                                                                                                                                                                                                                                                                                 |

### Measured (CI k3d, self-hosted DinD runners)

Probe: **hibernated → Pi ready** (not first token). Milestones are ms after the waking command;
pod timestamps have 1 s resolution.

| Run                                           | Set          | n   | p50  | p95  | max  | container started p50/p95 | wire connected p50/p95 |
| --------------------------------------------- | ------------ | --- | ---- | ---- | ---- | ------------------------- | ---------------------- |
| 1 (run 37084876022, attempt 2; before tuning) | back-to-back | 20  | 3993 | 4832 | 5675 | 571 / 1186                | 3186 / 3811            |
| 1                                             | spaced 30 s  | 5   | 4720 | 4878 | 4878 | 276 / 844                 | 3846 / 3944            |

Reading run 1: the Kubernetes side is fast (Sandbox patch → pod created ≈ 0 s; container started
≈ 0.3–1.2 s: gVisor + image present + local-path bind mount). ≈ 2.6 s go from container start to
the wire connection (Node boot under gVisor, `pi --version` — which booted Pi just to print a
version — the session trade, CNI admission of the new pod), then ≈ 0.8 s to spawn Pi for the
thread. p95 is inside the 8 s budget; p50 missed 3 s.

Tuning after run 1: the agent reads Pi's version from its package (no Pi boot at startup).
