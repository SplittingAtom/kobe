# KOBE-168: 74e T4: paired uid, end-to-end isolation tests and rollout

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in progress (PR #181)
- **Branch / worktree:** `kobe-168-paired-uid-rollout` in `../Kobe-wt168`
- **Depends on:** KOBE-166, KOBE-167, KOBE-196 (merged). Closes KOBE-228. Migrations: none.
- **Chart default stays `sandbox.toolExecutor.enabled: false`.** This ticket makes the executor ready
  and proven; the user decides when to turn it on.

## Plan

A new e2e shard `executor` runs the whole `suite` sections with `sandbox.toolExecutor.enabled=true`
(`KOBE_E2E_TOOL_EXECUTOR=1` adds `--set` to the install), under gVisor on k3d, with real Pi, the real
executor and the fake model's `bash: <command>` tool call. Extra sections live in `e2e/executor/`.

## Decisions

- **Probes run as real tools.** `e2e/executor/probe.sh` is copied into the Owner's sandbox and run by
  a thread's `bash` tool, so it executes as that thread's partner uid. It prints one line of
  `name=count` words (the fake model echoes a tool result as one line, 600 characters at most);
  every `*_ok` is the number of attempts that SUCCEEDED, so 0 means isolated.
- **Non-vacuous.** Thread B holds a long tool call (`sleep 80`) while thread A probes, so A sees its
  own Pi (`own_pi=1`), another thread's Pi (`other_pis>=1`) and the agent, and the zero counts mean
  something. Controls: A reads its own egress token; code planted in the tool's HOME is loaded when the
  tool itself requires it (`plant_control`).
- **KOBE-228.** Planted `~/.node_modules/bufferutil` records the uid that loads it; a later thread's
  fresh Pi must not load it (marker holds only the tool uid). The structural reason is KOBE-196's
  private Pi HOME/TMPDIR (`private_write_ok=0`, `private_dirs>=2`).
- **Workspace.** Tool-created file is `30xx:1000:66x`, the agent and a Pi uid append to it; the dir
  is setgid 1000; Pi's session files are readable by the tool.
- **KOBE-27 sync** with the Owner's own sandbox (last section; destroys its volume): a tool writes
  `kobe168-sync/q3.md`, hibernate pushes it (manifest row), the PVC is deleted, wake restores it, and a
  tool of a new Pi reads it, appends and creates a file in the restored directory.
- **Cold start.** `executor_first_token_trials` (N=8, `KOBE_E2E_FT_TRIALS`): hibernate, wait for the pod
  to go, then a hello through the real wake path (`first_token_ms` from `chat_run`) and a new thread's
  `bash: true` (`terminal_ms`, the first tool call after wake: executor starts cold). It runs in the
  `suite` shard (executor off) and the `executor` shard (on); gated on p95 <= 8000 ms (Gate 1), the
  p50 is reported. The executor is lazy, so a hello costs the same; the tool call pays the spawn.
- **Executor RSS** is read with `ps` while thread B's tool runs; asserted < 256 MiB, reported.
- **`hello` capability:** not added. The pod spec carries the flag and the agent refuses to start
  inconsistently (KOBE-167); nothing in the server needs to negotiate it. Open if the UI wants to show
  "tools isolated" per sandbox.
- **Seccomp inside the executor** (BRIEF description): not in this ticket's scope message; not done.
- **Docs:** `docs/install.md` "Sandbox tool executor" (how to turn it on, cost).

## Open questions (for Chris or the coordinator)

- Turn the flag on by default once `executor` has been green for a while? (User's decision.)
- Seccomp in the executor as defence in depth: separate ticket?

## Evidence (acceptance criteria -> test or command output)

| Criterion                                         | Where                                                       |
| ------------------------------------------------- | ----------------------------------------------------------- |
| ac-1 isolation properties under gVisor, flag on   | `e2e/executor/isolation.sh` (CI shard `executor`)           |
| ac-1 workspace sharing and KOBE-27 sync           | `isolation.sh` (two uids), `trials.sh executor_sync_checks` |
| ac-1 cold start within budget, executor on vs off | `trials.sh executor_first_token_trials`; numbers below      |
| whole suite green with the flag on                | CI shard `executor` (`KOBE_E2E_SHARD=suite` + the flag)     |

### Numbers (CI, k3d, gVisor)

From workflow_dispatch run 38019583969 (N=8 hibernated-to-first-token trials per shard):

| Metric                                  | Executor off (`suite`) | Executor on (`executor`) |
| --------------------------------------- | ---------------------- | ------------------------ |
| first token p50 / p95 (ms)              | 4341 / 5222            | 3972 / 4939              |
| first tool call after wake, terminal_ms | p50 2337, p95 2424     | p50 2110, p95 2173       |
| executor RSS                            | n/a                    | 138748 KiB (Pi 177868)   |

On is not slower (differences are runner noise). Both pass the 8000 ms p95 gate.

## Executor shard failure (run 38019583969)

Test bug, not a product bug. The restored-file check expected `$content writable`, but `cat` prints the
file (written with `printf`, no trailing newline) directly followed by `writable`, so the tool said
`kobe-168 <ts> <n>writable`: the file WAS restored and readable. Fixed the expectation in
`e2e/executor/trials.sh`. Every other executor-shard check passed.

Second executor run (38023321565): `chat (thread model)` failed `model_not_enabled` 2 s after the team enabled
qwen; `suite` on the same commit passed, so it is a propagation race (gateway/Bifrost learn of an enable
within seconds), not a main regression. `e2e/run.sh` now waits for qwen to answer before that run.

Third executor run (38024905989): trial 5 of the cold-start trials took 34426 ms (the other seven ~4.3 s),
so the p95 gate (nearest rank, n=8, i.e. the maximum) failed. The 30 s extra matches a 30 s constant in the
wake path (`POD_WAIT_TIMEOUT_MS` then the wake retry in `sandbox-wire/router.ts`, or the 30 s run stall
sweep), but the job's diagnostics hold no server/agent logs for that window (the chart upgrades later in
the suite rolled the server pods), so the cause is NOT proven. The trial now dumps server, event and agent
logs for any first token above 10 s (`slow_trial_diagnostics`); the gate is unchanged.

Fourth run (38048784387): `model_not_enabled` again, so the earlier wait was not the cause (it probed another
member's gateway principal). The 403 is the model gateway's (log: status 403 at 11:45:25 for the run's
model): its principal cache holds each member's enabled-model set for `KOBE_MODEL_GATEWAY_CACHE_TTL_MS`
(5 s), and only `keys:<team>` hints dropped it, which an enable does not send. Product fix in
`services/model-gateway/src/listener.ts`: the `config` hint (every enablement change) now drops all
principals. The test wait in `e2e/run.sh` was removed. Not an executor bug; users could hit it too.
