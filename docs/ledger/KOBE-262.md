# KOBE-262 (+ KOBE-263, KOBE-247): three flaky tests

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review
- **Branch / worktree:** `kobe-262-flaky-tests` in `../Kobe-wt262`
- **Scope:** test-only; no product change.

## Root causes

- **KOBE-262** (`services/sandbox-agent/src/identities.real.test.ts`): `twoThreads()` started a
  run on each thread and returned once thread 2's Pi had logged its launch, not once the runs had
  ended. The next `run.start` on thread 2 (command `c4` in all three CI failures) could arrive
  while `say:b` was still active: `pi_rejected` "thread has an active run". The same pattern sat in
  the KOBE-228 and MCP (KOBE-244) tests. No product race: the agent clears the thread's run in the
  same synchronous step that forwards Pi's `agent_settled` (`threads/thread.ts`, `#onEvent` ->
  `endRun()`), so that event is the run-end signal. Fix: a `settled(runId)` helper waits for it;
  `twoThreads()` and the two other tests wait for both first runs before the next command.
- **KOBE-263** (`services/server/src/memory-agent.db.test.ts`): `refusals()` slept 300 ms for the
  `sandbox.memory_refused` audit rows, which are written off the frame path. Now a plain query,
  asserted with `expect.poll(..., { timeout: 5000, interval: 50 })`.
- **Sibling of KOBE-263** (`services/server/src/artifacts.db.test.ts`): the same fixed 300 ms wait
  for `sandbox.artifact_refused` rows failed ("missing audit row") in a local `test:db` under load;
  fixed the same way. The one `[]` check stays a plain query: nothing was refused there.
- **KOBE-247** (`services/server/src/retention.db.test.ts`): two ticks started together are not
  concurrent: the first can finish its whole pass and unlock before the second tries, so both
  "ran". Now the first tick is held (gated pool client) right after `pg_try_advisory_lock`
  succeeds; the second tick must return "busy", then the first is released and returns "ran".

## Evidence

- identities.real.test.ts, real `kobe-runas` in a Debian container on the amd64 build host (same
  steps as `scripts/test-identities.sh`): 30/30. With the fake Pi's `say:` run held 1.5 s before
  settling: the old test fails both CI cases with `pi_rejected` (1/1), the new one passes 5/5.
  Under 12 busy loops on 8 CPUs: new 19/20, old 19/20; each miss a 5 s timeout in another test,
  no `pi_rejected`.
- memory-agent + retention db files: 50/50 (an earlier aborted batch had one failure whose log
  was not kept).
- artifacts db file: 19/20 at load average ~20; the miss was a 30 s timeout in its first test, not
  the audit wait.
- Seen in `pnpm verify` at load ~20, unrelated and passing on rerun: `tools/project-broker.test.ts`
  (expected ['push','send'], got []), web suite timeouts, model-gateway `two-replicas-site`,
  `runs-resolver` FakeSandbox.until. cli `test:db` needs `pg_dump` (not on this Mac).
