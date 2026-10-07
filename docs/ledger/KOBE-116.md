# KOBE-116: e2e: chart upgrade mid-test reaches newly allowed service

- **Status:** in review
- **Branch / worktree:** `kobe-116-upgrade-reaches-new-service` in `../Kobe-wt116`
- **Depends on:** KOBE-115 (reconcile loop), KOBE-126 (reconcile summary asserted in e2e). Part of KOBE-72.

## Plan

In e2e, with the real sandbox awake, `helm upgrade` a values change that alters the team
NetworkPolicy; assert the sandbox gains the newly allowed service after the reconcile, without a
wake or recreate.

## Decisions

1. **Lever: `sandbox.modelGatewayAccess`.** It is the only chart value that drives the team policy's
   allow-list (`sandboxEgressEndpoints` in `manifests.ts`); no new chart value or test service. Target:
   the model-gateway Service (`/healthz` on port 80), which the sandbox cannot reach while it is false.
2. **Two upgrades:** `false` (the sandbox must lose the gateway) then `true` (the newly allowed
   service; the asserted case). The default is `true`, so the section ends in the install's state.
3. **Conditions, not sleeps:** after each upgrade wait (120 s) for a `team namespaces reconciled` line
   with `policyChanged` >= 1 from a server pod that did not exist before the upgrade, then retry the
   probe (90 s) from the real agent container (`curl --noproxy '*'`; the pod's `HTTP_PROXY` is set).
   Blocked is asserted only after the sandbox port answered from the same pod (positive control).
4. **Same pod:** pod name and UID are compared before and after the two upgrades.
5. **Placement:** last section of `e2e/run.sh`, so only the `suite` shard (shortest, ~8.5 min) and
   `all` run it; independent of the MCP section (no leases, own server rolls, own variables).

## Open questions

- None. The server rolls twice (about 1-2 min each in CI); if suite becomes the longest shard, move it
  to its own shard.

## Evidence

- ac-1: `e2e/run.sh` section "chart upgrade reaches an awake sandbox (KOBE-116)"; not runnable
  locally (no k3d), CI e2e (suite shard) runs it.
