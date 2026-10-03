# KOBE-1: Gate 1 — Spine verification

- **Status:** in review (PR pending); gate **not closed** — first token blocked (KOBE-40/41) and
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
  release claims and PVCs), `kobe-gate1`, `kobe-gate1-deps`, and the ClusterRole/Binding
  `kobe-gate1-rancher-updatepsa`; remove the retained NFS PV afterwards.

## Evidence (acceptance criteria → test or command output)

See [docs/gates/gate-1.md](../gates/gate-1.md). Summary:

| Criterion                                  | k3d (e2e run 37142696913)                          | Real cluster                                              |
| ------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------- |
| 2 teams × 5 users concurrently             | ok (to the model)                                  | ok (to the model)                                         |
| Cross-team probe 0 rows                    | CI probe 143 tests (ci 37131282050) + live probe 0 | live probe 0                                              |
| Refresh mid-run gapless                    | ok ×10                                             | ok ×10                                                    |
| Kill → interrupted + Retry, history intact | ok (31.1 s)                                        | ok (28.0 s)                                               |
| Hibernated → first token p95 ≤ 8 s         | blocked (KOBE-40/41); proxy p95 5.0 s              | blocked; proxy p95 17.2 s, Pi ready p95 14.9 s (Longhorn) |
