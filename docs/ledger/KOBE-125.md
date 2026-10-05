# KOBE-125: flaky e2e gVisor check sees an unverified server pod

## Root cause

The check "server and scheduler verified the gVisor RuntimeClass in process" (e2e/run.sh) reads each
pod's log for `isolation verified: agents enabled`. Two gaps:

1. Pod selection: it took every Running pod with the component label, so a pod of an old
   ReplicaSet or one already terminating after the rollout could be sampled; those never need to
   verify and may be gone or silent.
2. Server startup gap (services/server/src/isolation/gate.ts): the startup check ran once. One
   transient Kubernetes API failure at boot (reset, 10 s timeout under CI load) published
   `missing`; /readyz treats anything but `checking` as ready, so the pod served and stayed
   unverified until the next re-check, 60 s later, longer than the check's 60 s wait.

Only the first failing run (37179692107, before the 60 s wait) is still in the Actions logs; the
PR #65/#92/#91/#93 failure logs have expired, so (2) is inferred from the code path, not from a log.

3. THE ACTUAL FLAKE, reproduced on this PR's first dispatch run (37303727271, cold-start): the pod's
   log did contain the verified line (printed in the failure tail) yet the check reported
   `unverified`. `isolation_verified` was `kubectl logs | grep -q`; grep -q exits at the first
   match, kubectl dies of SIGPIPE (141) while the log is still being written, and under
   `set -o pipefail` the pipeline fails. Whether that happens depends on log size/timing, so it is
   intermittent and a rerun passes. Items 1-2 are real gaps but were not what failed here.

## Fix

- `isolation_verified` captures the full log, then greps it (no pipe, no SIGPIPE).

- `createIsolationGate` gets `startupAttempts` / `startupRetryDelayMs`; `start()` retries a
  non-verified result and stays `checking` meanwhile, so /readyz is 503 until verified or the
  attempts (5 x 2 s, server/index.ts) are exhausted. A genuinely missing class still ends in
  `missing` (fail closed, keeps serving per D4); `require()` is unchanged. Default is 1 attempt.
- e2e/run.sh judges only live pods of each deployment's newest ReplicaSet (revision annotation,
  ownerReference, no deletionTimestamp), waits up to 90 s per component for the log line, prints
  the isolation log tail on failure, and fails clearly if no current pod exists. The assertion
  (pod's own in-process RuntimeClass handler check logged) is unchanged.

## Evidence

- Unit tests: transient failures then verified (stays `checking`), exhausted attempts -> `missing`.
- `pnpm verify` passes locally.
- Repeated workflow_dispatch runs of the e2e workflow (3 shards each) on the fixed branch: 5 of 6
  passed (37305969485, 37307744042, 37311186383, 37312928615, 37314725567); the sixth
  (37309447809) failed in gate1's "Load the images into k3d" (docker.sock closed pipe), an
  unrelated runner infra error, with no isolation-check failure. The loop was stopped early on the
  coordinator's request, so the 20-run target (ac-2) is NOT met: 5 full consecutive-ish passes
  plus the PR run. Before the SIGPIPE fix, the first dispatch run reproduced the flake.
