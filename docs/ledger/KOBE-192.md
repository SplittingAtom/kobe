# KOBE-192: sandbox stuck on an unattachable workspace volume

Status: PR open (see branch kobe-192-stuck-workspace-volume).

## Decisions

- Detection is in the wake path: after `wakeSandbox` the lifecycle calls `provider.awaitReady`
  (pod Ready within `podWaitTimeoutMs`, the existing wake timeout, 30 s). Not Ready: events, pod
  and PVC are classified in `sandbox/stall-diagnosis.ts`.
- Member error: `SandboxWakeError("workspace_unavailable")` -> `run.failed` with a fixed message
  (`runs/failure-codes.ts`); no node or volume names.
- Admin surface: audit events `sandbox.wake_stalled` (cause, detail, retried) and
  `sandbox.volume_retried`, install scope, readable in the existing install audit view
  (`?action=`); structured error log line; `metrics().stalledWakes`. No new endpoint.
- Retry: once per Sandbox (annotation `workspace-volume-retried`, set before deleting), only when
  Kobe never recorded the sandbox coming up (`sandboxes.sandbox_id` null), the PVC class contains
  `strict-local`, cause is a volume cause, and no container of the pod ever ran. Deletes pod, then
  PVC. Identity is now recorded only after the pod is Ready.
- RBAC: manager ClusterRole gains `events` get/list (chart test added). Pods, PVC, Sandbox patch
  already existed.

## Open

- Not verified on a cluster: that agent-sandbox v1.0.4 recreates the PVC from its
  volumeClaimTemplate after the PVC and pod are deleted. If it does not, the retry leaves the
  sandbox stalled; the second stall still fails visibly.
- Pods without a readiness probe are Ready once containers run; the agent dialing out can still
  lag behind (the command timeout covers that).
