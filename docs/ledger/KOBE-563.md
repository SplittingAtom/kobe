# KOBE-563: executor shard, idle sandbox never hibernates

- **Status:** committed on `kobe-563-executor-shard`, not pushed
- **Kind of fix:** e2e harness (containment and diagnostics). The underlying product hang is the
  open KOBE-415 one, below; it is not fixed here.

## Root cause (ac-1)

Not a slow runner and not the idle sweep. Both failing runs (queue 42415138858 job 128531999883,
queue 42418930017 job 128544250542) ran every section at the normal pace: `==> checks` to the
cold-start trials took 18m54s and 18m23s, against 19m54s in a passing run the same week
(42821211630). The whole 17 minutes went into the KOBE-168 first-token trials (16m47s and 16m38s,
normally about 3 minutes):

```
trial 2: hibernate=ok first_token_ms=4109 tool_run_ms=2366
trial 3: hibernate=ok first_token_ms=3896 tool_run_ms=300032   <- "bash: true" never ended
trial 4: hibernate=ok first_token_ms=2062 tool_run_ms=2410     <- 127 s per trial from here, warm first token
...
FAIL the idle sandbox hibernates: got [{"hibernated":false}]
```

The same thing happened at trial 3 in both runs:

1. The first tool run after the trial-3 wake (`bash: true`, a new thread, so a cold Pi and a cold
   executor) never reached a terminal event: `tool_run_ms=300032` is the 300 s `chat_run` stream
   timeout. Something of it stayed active (most likely the run itself, `running` under the
   agent's lease, since the run sweeper fails a leaseless one): hibernation was still refused
   16 minutes later. That is the "a tool ran, then no terminal
   event" hang KOBE-415 logged twice (memory remember; the KOBE-39 blocked-egress curl, executor
   on) and left open. The job log has no server or sandbox lines for it: `hung_run_report` was
   not called on this path, and the Diagnostics step only dumps agent logs for the gate
   namespaces.
2. `lifecycle.js hibernate` refuses while any run of the user is queued, running or waiting for
   an approval (`lockIfIdle` in `services/server/src/sandbox-lifecycle/store.ts`, even with
   `force`). Every later hibernate answered `{"hibernated":false}`, but the trial printed
   `hibernate=${hib:+ok}`, which is "ok" for any non-empty answer, and carried on.
3. Trials 4 to 8 each waited out `until_ok 120 owner_pod_gone` (the pod never went) and then
   measured an **awake** sandbox (first token about 2 s, not about 4 to 5 s). The p95 check passed on
   warm numbers: 300 s + 5 × 127 s is the 998 s the brief saw.
4. `executor_sync_checks`: "the idle sandbox hibernates" got the same refusal; the pod kept the
   PVC, so `kubectl delete pvc --wait` timed out after 120 s with the uid unchanged ("the
   workspace volume is destroyed").
5. KOBE-244: `owner_lifecycle hibernate >/dev/null` was also refused, so the sandbox never woke
   under the 10 s TTL. Pi kept its 900 s tokens, no token expired during the run, and the
   mcp-proxy never answered 404 (`got [0]`).

The 600-odd checks in 44 minutes came from those waits (4 × 2 min plus the 5 min stream
timeout, then 4 min in the sync section), not from a slower machine. Of the 82 executor shards
from 2026-11-08 17:28Z to 2026-11-10 14:32Z (70 passed, 10 cancelled, one failure elsewhere), none
had a trial tool run hit the timeout: the hang is rare and not tied to runner speed.

## Fix (ac-2)

`e2e/executor/trials.sh`, `e2e/run.sh` (KOBE-244 section):

- `owner_hibernate`: wait for the CLI's actual `"hibernated":true` (bounded `until_ok`: 30 s, one
  attempt on a healthy install, so the normal duration does not change). If it is still refused, it prints why
  (`owner_busy_report`: the owner's active runs and in-flight commands), stops those runs
  (`POST /v1/runs/:id/cancel`) and tries again for up to 60 s. Used by every trial, the sync
  check and the KOBE-244 setup (which now fails openly instead of silently).
- A trial counts toward the first-token p95 only if it really started hibernated (hibernate
  answered true and the pod went); otherwise "every cold-start trial started hibernated …"
  fails. No more warm numbers passed off as cold starts.
- The first tool run after a wake waits 120 s (normally about 3 s; was 300 s). If it does not
  complete, `owner_hung_run` prints `hung_run_report` (events, status, server warnings) plus
  the owner's agent log for the last 10 minutes and stops the run. A new check, "every first
  tool run after a wake completed", fails for that shard. The hang is a real product
  bug, so it should not pass silently, but it no longer drags the sync and token-rotation
  checks down or pushes the job toward its timeout (worst case about 2 min plus 30 s instead of 17 min).

## What CI should show (ac-3, coordinator)

- Normal executor shard: same duration, `trial N: hibernate=ok … tool_run=run.completed` on all
  eight trials, the new "every first tool run after a wake completed" and "the owner's sandbox
  is hibernated before the TTL change" checks ok.
- If the hang recurs: one FAIL "every first tool run after a wake completed (1 of 8 …)", a
  `trial N first tool run: run … did not end` block with the run's events, status, server lines
  and `agent:` lines, and **no** knock-on failures (sync, PVC, mcp-proxy 404). Those `agent:` and
  event lines are what the KOBE-415 hang needs next: where after the tool call the run stopped
  (tool result never back from the executor, model call never answered, or the run end never
  sent). File that as its own product ticket with the block attached.
