# KOBE-126: Reconcile loop gets 403: sandbox-manager ClusterRole lacks get/list on team-namespace objects

- **Status:** in review
- **Branch / worktree:** `kobe-126-reconcile-rbac` in `../Kobe-wt126`
- **Depends on:** KOBE-115 (reconcile loop). Upgrade e2e is KOBE-116, not here.

## Plan

Enumerate the reconcile's API calls, make sure RBAC grants exactly those, pin it with a chart test,
assert the reconcile summary in the e2e.

## Decisions

1. **Calls per run** (`team-reconcile.ts`, `convergeTeam` in `sandbox/provider.ts`; `kube.apply` is a
   plain server-side-apply PATCH, `force`, field manager `kobe-server`; no read-before-write):
   - cluster: list Namespaces by label; get Namespace; create (admission dry run) and apply Namespace;
     apply RoleBinding.
   - team namespace: get NetworkPolicy x2 (before/after); apply NetworkPolicy x2, ResourceQuota,
     LimitRange, ServiceAccount, Secret (pull secrets), SandboxTemplate, SandboxWarmPool.
   - release namespace: get Service x4, get pull Secrets (existing Role, by name).
     An apply of a missing object needs `create` as well as `patch`.
2. **RBAC already complete on main:** 876db1a (after the 6e188dc deploy that showed failed=4) added
   `get` on networkpolicies, the only missing verb. Audit found no other gap, so the chart grants
   nothing new; this ticket pins the exact verbs per kind with a chart test so drift either way fails.
3. **e2e:** `dev/values.yaml` sets `server.teamReconcileSeconds: 30`; `e2e/run.sh` waits (120 s) for a
   `team namespaces reconciled` log line with converged > 0 and asserts failed=0.

## Open questions

- ac-1 (real cluster failed=0) is verified by the coordinator after merge.

## Evidence

- ac-2: `charts/kobe/tests/sandbox.test.ts` "grants the team-namespace reconcile exactly its verbs
  per managed kind (KOBE-126)".
- e2e assertion: `e2e/run.sh` (not runnable locally; no k3d); CI e2e runs it.
