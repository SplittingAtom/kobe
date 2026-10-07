# KOBE-132: Flaky e2e: MCP proxy calls denied with "No active run of this thread runs in this sandbox"

- **Status:** in review
- **Branch / worktree:** `kobe-132-e2e-mcp-no-active-run` in `../Kobe-wt132`
- **Depends on:** none

## Plan

Find why the fixture run (e2e/run.sh, MCP section) is not active when the proxy asks; fix the cause.

## Decisions

- **Root cause (test race, product is correct).** The MCP section runs `helm upgrade` (mcp-proxy
  values), which rolls `kobe-server`. The e2e sandbox's real agent then redials at an arbitrary
  moment, sometimes just after the section inserted its fixture run + lease. The agent's `hello`
  lists no runs, so `connection.ts` `#hello` interrupts every leased active run of that user
  (D14, cause `not_resumed`). `loadActiveRuns` then finds no run and the server denies with
  "No active run of this thread runs in this sandbox". Not the lease or run state racing.
- **Evidence from the failed run** (PR #103's e2e, run 37378222981, log kept in CI): server log
  `sandbox connected ... "interrupted":1` for the e2e sandbox at 22:02:39.7Z, immediately after
  the helm upgrade finished (22:02:39) and as the fixture was inserted; the denial came at 22:02:40.
- **Fix:** e2e/run.sh waits, after an upgrade that rolled the server (deployment generation
  changed), until the e2e sandbox has an open `sandbox_connections` row newer than the upgrade,
  and only then leases the fixture run. No sleep: the condition is the reconnect itself, bounded
  at 120 s and reported as its own failing check.
- No product change: interrupting runs a sandbox no longer has on hello is D14 behaviour.

## Open questions (for Chris or the coordinator)

- Criterion "e2e (suite) MCP section passes 10 consecutive runs" cannot be proved in one PR; it is
  tracked over later PRs' e2e runs. Count so far: 0 (this PR's run is the first).
  If a denial reappears, check the server log for `sandbox connected ... interrupted` near it.

## Evidence (acceptance criteria → test or command output)

- Root cause identified and fixed: above; contract test
  `services/server/src/mcp-proxy-gate2.db.test.ts` ("denies every call once the sandbox's
  reconnect ended the run"), passes with `@kobe/server test:db`. The reconnect-interrupts-run
  path itself is `runs-interrupted.db.test.ts` ("its hello does not list the run").
- 10 consecutive e2e (suite) runs: pending, tracked over later PRs.
