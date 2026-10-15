# KOBE-277: Wake fails on a transient "persistentvolumeclaim not found"

- **Status:** in review
- **Branch / worktree:** `kobe-277-stall-pvc-race` in `../Kobe-wt277`
- **Depends on:** none

## Cause

`services/server/src/sandbox/stall-diagnosis.ts` treated any FailedScheduling event matching
`nodes are available` as a definite "no capacity" stall. Every FailedScheduling message starts with
"0/N nodes are available:", so the normal race on a first wake, where the pod is scheduled before
agent-sandbox has created the workspace PVC, failed the wake at once with `workspace_unavailable`.
Seen in the e2e gate1 concurrency check on PR #281 (1 of 10 users, twice).

## Decisions

- Definite only for capacity reasons after the prefix: `Insufficient storage|cpu|memory|ephemeral-storage|pods`
  and "no nodes available".
- A PVC that is not found, unbound, or has no volume to bind is never definite, even if the same
  message names another reason; the wake keeps waiting and the normal wake timeout applies.
- Other scheduling reasons (taints, affinity) fall to the existing non-definite `scheduling` cause.

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-2: `stall-diagnosis.test.ts`, the real event texts from the failing run plus unbound/no-volume/taint
  cases (not definite) and Insufficient cpu/memory (definite).
- ac-3: e2e (gate1) on this PR and the next PRs through the merge queue.
