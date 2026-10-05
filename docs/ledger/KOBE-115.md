# KOBE-115: Reconcile team-namespace objects on server start and on an interval

- **Status:** in review
- **Branch / worktree:** `kobe-115-namespace-reconcile` in `../Kobe-wt115`
- **Depends on:** KOBE-22 (convergence), KOBE-71 (PSA labels), KOBE-93 (eval policy). Part of KOBE-72.

## Plan

After a server upgrade existing team namespaces only got new NetworkPolicies on the next sandbox
setup. Converge all of them at start and every N minutes.

## Decisions

1. **One convergence function.** `convergeTeam` in `sandbox/provider.ts` (namespace + labels incl.
   Pod Security, RoleBinding, both NetworkPolicies, quota, LimitRange, template, warm pool) is
   used by both `ensureTeam` and the new `provider.reconcileTeams()`. No second copy.
2. **Idempotent, never deletes.** Everything is server-side apply by the `kobe-server` field
   manager. Namespaces are listed by label `kobe.../team-namespace=true`, team id from the label,
   slug from the name; unlabelled namespaces and foreign objects inside team namespaces are never
   touched. Namespaces being deleted or with an invalid team are skipped.
3. **Isolation untouched.** `reconcileTeams` calls `isolation.require()` first like every create
   path; without verified isolation the run fails and changes nothing. The RuntimeClass checks
   and `reconcileIsolation` are unchanged.
4. **Multi-replica:** Postgres session advisory lock (`sandbox/reconcile-lock.ts`, dedicated
   connection, same pattern as the retention job). A replica that cannot take it does nothing.
   Losing the connection releases the lock; an overlap is harmless because the pass is idempotent.
5. **Bounded:** 4 namespaces at a time (`TEAM_RECONCILE_CONCURRENCY`); one failing namespace is
   counted and logged (name and error only) and does not stop the rest.
6. **Flagging changed policy:** the two managed NetworkPolicy specs are read before and after
   convergence; changed namespaces are logged as a warning and counted. Awake sandboxes are not
   restarted (their pods keep running; NetworkPolicies apply to live pods immediately, so the
   flag only says "rules changed here"). Restarting is left as an optional follow-up.
7. **Config:** `KOBE_TEAM_RECONCILE_SECONDS` (default 300; `0` = only at start; else 30..86400).
   Chart value `server.teamReconcileSeconds` (default 300, schema min 0), chart test in `charts/kobe/tests/render.test.ts`. No migrations, no Redis.
8. **Log per run:** `team namespaces reconciled` with namespaces, converged, skipped, failed,
   policyChanged (count), durationMs.

## Open questions

- None. Coordinator decided: awake sandboxes are flagged only, never restarted.

## Evidence

- ac-1 (updated within one interval): `sandbox/team-reconcile.test.ts` "adds a missing rule",
  "updates a changed rule"; scheduling in `SandboxRuntime.startTeamReconciler`, called at start.
- ac-2 (idempotent, logged): "is idempotent", log line in `index.ts`.
- Lock: fake-pool unit test and `sandbox/reconcile-lock.db.test.ts` against real Postgres (`test:db`).
- Real e2e: KOBE-116.
