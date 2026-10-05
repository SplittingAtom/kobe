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

## Fix

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
- CI runs: see below.

