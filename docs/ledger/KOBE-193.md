# KOBE-193: gate2.sh: fail fast and clearly when the sandbox pod is not Running

- **Status:** in review (PR #)
- **Branch / worktree:** `kobe-193-gate2-fail-fast` in `../Kobe-wt193`
- **Depends on:** none

## Plan

- `e2e/gate2/sandbox.sh` (new, sourced): `sbx_await <secs> <label>` waits for t2's sandbox pod to be
  Running and Ready; otherwise one FAIL with phase, Ready and the containers' waiting reasons, then
  the pod's last events (or the namespace's when there is no pod/claim), and `SBX_DOWN=1`.
- `e2e/gate2.sh`: `sbx_need <label>` before ac-1, replicas, ac-2, ac-3, ac-5 (wake, then
  `sbx_await`); after the first failure later steps print `skip <label>` with no further FAIL; the
  proxy `helm upgrade` is skipped too. `in_sbx` no longer runs `kubectl exec ""`. ac-4 still runs.
- `e2e/gate2/scan.sh`: controls (`scan_control`) gate every negative result (`scan_ok`/`scan_check`):
  any failed control turns them into `INVALID ...` lines and one `FAIL ac-5 INVALID: ...`.
- Self-test `e2e/gate2/sandbox.test.sh` with a fake kubectl; run in CI `checks`.

## Decisions

- Ready is required as well as Running (sandbox pods have no probes, so Ready = containers started).
- Wait bound `KOBE_GATE2_SANDBOX_WAIT` (default 180 s), after wake's own 120 s.
- Pod-spec readability is an ac-5 control: an unreadable spec read as empty used to pass the
  "no Secret volume" checks.
- The CI self-test step is the one change outside `e2e/` and `docs/gates`; without it the test rots.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1: `e2e/gate2/sandbox.test.sh` (24 checks): stuck in ContainerCreating → exactly one
  `FAIL ... pod sbx-abc phase=Pending ready=False (agent:ContainerCreating)` plus its
  FailedAttachVolume/FailedMount events, later steps `skip`; no pod / no claim → one FAIL each;
  ac-5 with failed controls → `INVALID` lines, one `FAIL ac-5 INVALID`, no negative `ok`. Against the
  old `scan.sh` the ac-5 cases fail (7 checks), so the test catches the bug.
- shellcheck 0.11 (`-x -P SCRIPTDIR`): new files clean; no new findings in `gate2.sh`/`scan.sh`.
- CI e2e `gate2` shard green on the PR (happy path unchanged).
