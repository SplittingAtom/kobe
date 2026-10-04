# KOBE-1: Gate 1 — Spine verification

- **Status:** #52 merged; follow-up `kobe-1-storage-rancher` in review; gate **not closed** — first token blocked (KOBE-40/41) and
  the real cluster misses 8 s on Longhorn. Evidence: [docs/gates/gate-1.md](../gates/gate-1.md).
- **Branch / worktree:** `kobe-1-gate1` in `../Kobe-wt1`
- **Depends on:** KOBE-5, 6, 7, 8, 9, 12, 13, 14, 21, 22, 23, 24, 25, 26, 29, 30, 31, 32, 34 (all
  merged)

## Plan

1. A repeatable gate suite against an installed Kobe (`e2e/gate1.sh` + in-pod harness
   `e2e/gate1/client.mjs`, scripted sandbox `e2e/gate1/agent.mjs`), run in CI after `e2e/run.sh`
   and against a throwaway install on the real cluster.
2. Measure cold start on the real cluster per storage class; report, don't decide.
3. Evidence document; small fixes only.

## Decisions

- **Real path where it exists, scripted only where a model is required.** Concurrency and the
  cold start go through real sandboxes, the real agent and real Pi (ending in Pi's `pi_rejected`);
  streamed answers, the refresh and the kill use a scripted agent holding the users' real sandbox
  identities (KOBE-26's approach). Checks accept `run.completed` / `text.delta`, so they keep
  working once KOBE-40/41 give Pi a model.
- **Cold-start proxy = first sandbox-produced event after `POST /messages`** (new, `cold` step),
  alongside KOBE-25's Pi-ready harness. Neither is labelled first token.
- **Fixtures through the API**, except install invitations, issued with the server's own
  `issueInvite` inside an Owner audit context (the HTTP route only mails the token). Each simulated
  user has its own X-Forwarded-For address (trusted from the pod network) so per-IP auth limits
  behave as behind the ingress; cold-start trials rotate addresses (3 sign-ins / 10 s / IP).
- **The suite refuses non-k3d contexts** unless `KOBE_GATE1_CONTEXT` names one: it signs sandbox
  wire tokens with the install's keys.
- **Real cluster images built from `d70c933`, not pulled from ghcr**: the packages are private and
  no `read:packages` credential was available (see open questions).

## Open questions (for Chris or the coordinator)

1. **Sandbox storage on the real cluster** — Longhorn puts 5–12 s of volume attach on every wake
   (Pi ready p95 14.9 s once detached). Options in gate-1.md; needs a decision.
2. **ghcr pull access** — make the `kobe-*` packages public or provide a `read:packages` token.
3. **Rancher `updatepsa`** — chart option or docs only? Docs added; the real install has a
   ClusterRole/Binding `kobe-gate1-rancher-updatepsa`.
4. NFS class not writable under gVisor — worth investigating, or rule NFS out?

## Real-cluster install (left running)

- Namespaces: `kobe-gate1` (release `kobe`), `kobe-gate1-deps` (Postgres 17 on a Longhorn PVC,
  Mailpit), team namespaces `kobe-team-gate1-a`, `kobe-team-gate1-b` (created by the server).
- Cluster-scoped: the chart's ClusterRoles/Bindings and ValidatingAdmissionPolicies (names
  `kobe-<hash>-*`), ClusterRole/Binding `kobe-gate1-rancher-updatepsa`.
- Owner `owner@gate1.test` (password in the operator's local notes, not in the repo); users
  `gate1-{a1..a5,b1..b5,c1,c2,c3}@gate1.test`.
- `c2`'s workspace is an NFS volume (reclaim `Retain`: its directory stays on the share after
  teardown).
- Teardown: `helm -n kobe-gate1 uninstall kobe`, then delete the team namespaces (their finalizers
  release claims and PVCs), `kobe-gate1`, `kobe-gate1-deps`; remove the retained NFS PV
  afterwards. (The Rancher grant and the strict-local StorageClass are chart objects now and go
  with the uninstall; the hand-made `kobe-gate1-rancher-updatepsa` objects were deleted.)

## Evidence (acceptance criteria → test or command output)

See [docs/gates/gate-1.md](../gates/gate-1.md). Summary:

| Criterion                                  | k3d (e2e run 37142696913)                          | Real cluster                                              |
| ------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------- |
| 2 teams × 5 users concurrently             | ok (to the model)                                  | ok (to the model)                                         |
| Cross-team probe 0 rows                    | CI probe 143 tests (ci 37131282050) + live probe 0 | live probe 0                                              |
| Refresh mid-run gapless                    | ok ×10                                             | ok ×10                                                    |
| Kill → interrupted + Retry, history intact | ok (31.1 s)                                        | ok (28.0 s)                                               |
| Hibernated → first token p95 ≤ 8 s         | blocked (KOBE-40/41); proxy p95 5.0 s              | blocked; proxy p95 17.2 s, Pi ready p95 14.9 s (Longhorn) |

## Follow-up (branch `kobe-1-storage-rancher`, decisions by Chris)

1. **Storage: Longhorn strict-local.** Chart option `sandbox.workspace.longhornStrictLocal.enabled`
   (off by default) creates a cluster-scoped StorageClass `<release>-<hash>-workspace-strict-local`
   (Longhorn, 1 replica, `strict-local`, `WaitForFirstConsumer`) and points workspaces at it;
   setting `storageClass` too is refused. Chosen over "document a class and set storageClass"
   because the chart owns the name and the parameters that matter. Recovery from a lost node is
   KOBE-27's S3 restore (PR #50, not merged yet), documented in install.md (delete the PVC, the
   next wake restores). **Measured: no faster than 3-replica Longhorn** (Pi ready spaced p95 14.0 s;
   first sandbox answer back-to-back p95 18.0 s, spaced 15.2 s). Breakdown in gate-1.md: ≈ 8 s is
   Longhorn's engine start + replica health check, ≈ 3 s CSI publish + mount, ≈ 3 s the sandbox.
   Not switched to another option (as instructed).
2. **Rancher: `rancher.enabled`** (off by default) → ClusterRole/Binding granting `updatepsa` on
   `projects.management.cattle.io` to the server SA; chart tests; the provider turns the webhook's
   refusal into a `SandboxProvisioningError` naming the webhook and the flag (unit test + verified
   on the real cluster). The gate install uses the flag; hand-made objects deleted.
3. **Images:** ghcr packages still private at the time of the measurements (anonymous token
   refused); the gate install runs `local-c94c126bec61` (this branch built on the build host and
   imported into each node). `publish.yml`/install.md pull-secret wording unchanged until the
   packages are public.

Open: a provisioning refusal takes the router's full 90 s wake-retry budget before the run fails
(it is not a definitive `SandboxWakeError`); a follow-up could make it definitive.
