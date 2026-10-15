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

- `sandbox/scheduling-message.ts` reads the reasons after "0/N nodes are available:" with their node
  counts. A reason is _pending_ when it is a workspace volume not created or bound yet
  (`persistentvolumeclaim "…" not found`, unbound PVCs, no PV to bind, waiting for first consumer).
- No pending reason: definite, as before (Insufficient cpu/memory/gpu, Too many pods, volume node
  affinity conflict, node selector, taints). A storage shortage is reported as `volume_unschedulable`.
- With a pending reason, definite only when blocking reasons cover every node (the volume is not
  the only problem); otherwise keep waiting. A volume still pending after 60 s is definite
  (`volume_unschedulable`), like a repeating FailedAttachVolume, so a PVC agent-sandbox never
  creates does not wait out the whole ready timeout.
- Only the newest FailedScheduling event counts, so an earlier full-cluster event no longer fails a
  wake that is now only waiting on its volume. Longhorn's replica scheduling (non-FailedScheduling
  events) stays definite as before.
- `/code-review` of #282 (first version) found the narrow allow-list regressed real capacity
  failures to the full timeout; this version replaces it.

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-2: `stall-diagnosis.test.ts`: the real event text from the failing run, mixed pending and
  capacity messages, Too many pods, affinity, GPU, taint, storage, the 60 s escalation and newest-event order.
- ac-3: e2e (gate1) on this PR and the next PRs through the merge queue.
