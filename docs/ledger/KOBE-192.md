# KOBE-192: sandbox stuck on an unattachable workspace volume

Status: PR #204, review fixes applied.

## Decisions

- Detection is in the wake path: after `wakeSandbox` the lifecycle calls `provider.awaitReady`.
  It waits up to 90 s (the wire wake budget, as before this ticket), polling events every 5 s.
- Early failure only on definite signals (`sandbox/stall-diagnosis.ts`): Longhorn
  `LocalReplicaSchedulingFailure`, FailedScheduling with insufficient storage or no nodes available,
  FailedAttachVolume with count >= 3 or older than 60 s, ImagePullBackOff/ErrImagePull. Pulling,
  ContainerCreating, a single FailedMount are progress. At the budget the diagnosis is reported
  anyway (`unknown` if nothing matched).
- Events count only if lastTimestamp >= wake start and involvedObject.uid is the current pod or PVC.
- Member error: `SandboxWakeError("workspace_unavailable")` -> `run.failed` with a fixed message;
  no node or volume names.
- Admin surface: audit `sandbox.wake_stalled` (cause, detail + remedy), install scope, in the
  existing install audit view (`?action=`); error log line; `metrics().stalledWakes`.
- RBAC: manager ClusterRole gains `events` list only. Nothing else changed.

## Dropped: the one-time volume retry

The optional retry (delete the unused pod and PVC so the scheduler picks another node) is removed
for data safety. Review found a path to deleting a used PVC: identity is recorded only after a Ready
wake, so a pod that stalled, then connected, is never recorded; after an eviction plus a failed
strict-local attach every guard passed. No pod or PVC deletion and no `sandbox.volume_retried`
remain; the audit detail and docs suggest the manual remedy instead.

## Open

- Pods without a readiness probe are Ready once containers run; the agent dialing out can lag
  behind (the command timeout covers that).
