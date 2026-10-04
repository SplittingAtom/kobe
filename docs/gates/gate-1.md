# Gate 1 — Spine verification (KOBE-1)

Evidence for the Phase 1 gate (umbrella spec, KOBE-1): _two teams × five users chat concurrently;
cross-team probe zero rows; refresh mid-run resumes gapless; killing a sandbox mid-run →
`interrupted` + Retry, history intact; hibernated → first token p95 ≤ 8 s (20 trials)._ Each
criterion must hold on k3d (CI) and on the real k3s cluster.

Verified on 2026-10-03 against `main` at `d70c933` (all Gate 1 dependencies merged) plus this
branch's harness (`e2e/gate1.sh`, `e2e/gate1/`), which changes no product code.

## Verdict

Updated 2026-10-04 with KOBE-40/41 merged (`main` at `296c275`): sandboxes now reach real models
through the model gateway, so first token is measured, not proxied. See
[First token with a real model](#first-token-with-a-real-model-2026-10-04).

| Criterion                                  | k3d (CI, fake upstream model)                              | Real k3s cluster (4 nodes, Longhorn, real cloud model)                                |
| ------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Two teams × five users chat concurrently   | **Proven** (streamed model answers)                        | **Proven** (10 concurrent real-model answers, 19.3 s for all ten)                     |
| Cross-team probe returns zero rows         | **Proven** (CI probe suite; live probe: 0 rows)            | **Proven** (live probe: 0 rows)                                                       |
| Refresh mid-run resumes with no gaps       | **Proven** (10 concurrent users, scripted sandbox side)    | **Proven** (same)                                                                     |
| Kill a sandbox mid-run → interrupted+Retry | **Proven** (the retry is answered by the model)            | **Proven** (the retry is answered by the real model)                                  |
| Hibernated → first token p95 ≤ 8 s (20)    | **Passes**: p50 4.8 s, p95 **5.8 s** (e2e run 37173405729) | **Fails**: p50 15.2 s, p95 **17.5 s** (strict-local Longhorn; miss accepted by Chris) |

Gate 1 holds on k3d. On the real cluster every criterion holds except cold start, where ≈ 14 s
of each wake is Longhorn attaching the workspace volume (storage sections below); the user
accepted that miss for now and storage stays on Longhorn.

### Scope note: what "up to the model" means

No sandbox can reach a model today: `sandbox.modelGatewayAccess` is off until Bifrost verifies
sandbox session tokens (KOBE-40), and Pi has no model or provider configured (KOBE-41). So:

- **Real path** (`chat-real`, cold start, the Retry in the kill test): real API → orchestrator →
  router → wake/create → gVisor sandbox → real `kobe-sandbox-agent` → real Pi 1.0.0 with
  kobe-policy. Pi answers the prompt with its refusal for lack of a key (`run.failed`,
  `pi_rejected`, "No API key found for the selected model"). That proves each prompt reached _that
  user's_ Pi; it is not a chat answer.
- **Streamed answers** (`chat-stream`, the kill itself): a scripted agent takes over each user's
  sandbox identity (live claim + wire token signed with the install's key) from a gVisor pod in
  the team's namespace and speaks the real wire frames, streaming a 40-word answer per run.
  Everything from the wire inwards — routing, translation, delta batching, entry mirroring, the
  event log, SSE, resume — is the real server. Same approach as KOBE-26's e2e.

When KOBE-40/41 land, `e2e/gate1.sh` needs no structural change: the real-path checks already
accept `run.completed`, and the cold-start trial already takes the first `text.delta` as its end
point.

## Environments

|                   | k3d (CI)                                                                                                                                               | Real cluster                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where             | GitHub-hosted runner, `e2e` workflow, k3d + gVisor + agent-sandbox, `dev/values.yaml`                                                                  | k3s 1.34, 4 nodes (8 CPU, 16 GiB each), gVisor (`runsc`), agent-sandbox v1.0.4, Rancher-managed                                                                        |
| Install           | `e2e/run.sh` (release `kobe` in `kobe-dev`), then `e2e/gate1.sh`                                                                                       | Release `kobe` in namespace `kobe-gate1`; throwaway Postgres 17 + Mailpit in `kobe-gate1-deps`; chart defaults (2 server replicas, sandbox 500m/1Gi, warm pool 1/team) |
| Workspace storage | `local-path` (bind mount)                                                                                                                              | `longhorn` (cluster default, 3 replicas, `Immediate`)                                                                                                                  |
| Images            | built from the commit in CI                                                                                                                            | built from `d70c933` on the amd64 build host and imported into every node (tag `local-d70c933068d1`) — see "Images" below                                              |
| Evidence          | e2e run [37142696913](https://github.com/SplittingAtom/kobe/actions/runs/37142696913) (job 111260232144): `Gate 1 suite: all checks passed`, 72 checks | `e2e/gate1.sh` final run: 71 checks ok, 1 FAIL (cold start); separate KOBE-25 harness runs below                                                                       |

**Images.** The ghcr packages are still private: an anonymous pull token is refused
(`UNAUTHORIZED`), and no `read:packages` credential was available to this run (the GitHub CLI
token lacks the scope; no node or build host is logged in to ghcr). Instead of `sha-d70c933068d1`
from ghcr, the same commit was built with the repository's Dockerfiles and imported into each
node's containerd. Before the next real-cluster gate: either make the `kobe-*` packages public
(the repository already is) or provide a `read:packages` pull secret.

## 1. Two teams × five users chat concurrently

`e2e/gate1.sh` creates two teams (`gate1-a`, `gate1-b`) of five users each through the API: the
Owner issues install invitations (the server's own `issueInvite`, audited as the Owner), users
accept at `/api/auth/invitation/accept`, the Owner creates each team with its first user as team
admin, the admin invites the other four and they accept at `/v1/me/invites/{team}/accept`. Every
simulated user signs in with its own client address (X-Forwarded-For from the pod network, which
the server trusts), so per-IP limits apply per user.

**`chat-real`** — all ten send a message at the same instant through the server Service (both
replicas):

| Check                                                                                                          | k3d                                            | Real                                                   |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| 10 runs created at once, each ended by its own Pi (`pi_rejected`)                                              | ok ×10                                         | ok ×10                                                 |
| Each user's events gapless (1..n), no duplicates, identical to the run's log                                   | ok ×10                                         | ok ×10                                                 |
| 180 cross-access attempts (each user × every other user's run stream and thread; teammates and the other team) | all 404                                        | all 404                                                |
| Each user has exactly one live wire connection, from their own sandbox (`other_sandbox_open=0`)                | ok ×10                                         | ok ×10                                                 |
| Ten distinct sandboxes; five per team namespace, Running under `gvisor`                                        | ok                                             | ok                                                     |
| Wall time for all ten (send → terminal event)                                                                  | 35.5 s (10 first sandbox starts on one runner) | 17.9 s (10 suspended Longhorn sandboxes woken at once) |

**`chat-stream`** — the same ten users, scripted sandbox side, 40-word answers at 100 ms per
delta; every user refreshes mid-run (below). All ten `run.completed`, text exact, 180/180
cross-access attempts 404, 5.5 s (k3d) / 5.6 s (real) for all ten.

Lower-level evidence (CI `db` job, every PR): `runs-concurrency.db.test.ts` › "Gate 1: two teams ×
five users chat concurrently" (10 users, 10 sandboxes, alternating replicas) and
`event-stream-scale.db.test.ts` › "two teams × five users stream concurrently".

## 2. Cross-team probe returns zero rows

- **CI probe suite** (`packages/db/src/probe.db.test.ts`, the `db` job on every push): seeds two
  teams in every team table and queries each as the app role with raw SQL. Latest `main`: ci run
  [37131282050](https://github.com/SplittingAtom/kobe/actions/runs/37131282050), job `db`:
  `probe.db.test.ts (143 tests)` passed.
- **Live probe** (`e2e/gate1.sh` step `probe`, both environments): after the chats, inside a
  server pod as the app role, for every one of the 15 team tables (`TEAM_TABLES`): rows visible
  outside `withTeam` = **0**; inside `withTeam(A)` rows with another `team_id` or team B's id =
  **0**, and the same from B. The probe saw real data in 8 tables (`team_members`,
  `sandbox_connections`, `sandbox_run_leases`, `sandboxes`, `threads`, `thread_entries`, `runs`,
  `run_events`).

## 3. Refreshing mid-run resumes with no gaps

In `chat-stream`, each of the ten users drops its event stream after the fifth `text.delta` (the
reload) and reopens it 300 ms later with `Last-Event-ID` = the last seq it saw, as EventSource
does, while the answer keeps streaming. For all ten on both environments: the events received
across both connections are seqs 1..n with no gap and no duplicate, equal (seq and type) to a full
replay of the run's log afterwards, end with `run.completed`, and the concatenated deltas equal the
expected answer exactly (`refreshed_at` = the seq of the drop, recorded per user in the log).

Lower-level: `event-stream.db.test.ts` › "resumes gapless and duplicate-free after disconnects at
random points under concurrent appends (U4, Gate 1)"; web: `conversation.test.tsx` › "Gate 1: a
refresh mid-run resumes from the event log with no gaps or duplicates" (KOBE-32).

## 4. Killing a sandbox mid-run → `interrupted` + Retry, history intact

`e2e/gate1.sh` step `interrupt` (both environments): a scripted agent in a gVisor pod holds user
b5's sandbox identity, streams a long answer and mirrors the first turn (root, prompt, partial
answer = 3 entries); the pod is then deleted (`--grace-period=1`).

| Check                                                                                                                                  | k3d          | Real         |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------ |
| Run ends `run.interrupted` `{reason: sandbox_lost, retryable: true}`                                                                   | after 31.1 s | after 28.0 s |
| Thread `interrupted` (queue held); `GET /threads/{id}/runs` names the run to retry                                                     | ok           | ok           |
| History intact after the kill (same 3 entry ids)                                                                                       | ok           | ok           |
| Retry starts at once (201, not queued), once per run (repeat returns the same run), links `retry_of_run_id`                            | ok           | ok           |
| The retry reaches the user's **real** sandbox, woken from Suspended, thread restored from Postgres, and its Pi answers (`pi_rejected`) | ok           | ok           |
| History intact after the retry                                                                                                         | ok           | ok           |

The ≈ 30 s is the lost-connection grace (30 s) plus the sweep. Lower-level:
`runs.db.test.ts` › "killing the sandbox mid-run interrupts it, blocks the queue, and Retry runs
first with history intact"; `e2e/run.sh` "interrupted runs and Retry (KOBE-26)"; web
`conversation.test.tsx` › "Gate 1: a sandbox killed mid-run …".

## 5. Hibernated → first token, p95 ≤ 8 s over 20 trials

**Not measurable as specified until KOBE-40/41.** Two proxies, both lower bounds of first token:

- **Pi ready** (KOBE-25 harness, `dist/cli/cold-start.js --probe pi`): router → waker → provider →
  pod → agent connected → Pi spawned with kobe-policy ready, answering `get_state`.
- **First sandbox answer** (`e2e/gate1.sh` step `cold`, new here): `POST /v1/threads/{id}/messages`
  through the server Service → `run.start` → wake → agent → Pi, timed to the first event the
  sandbox produced for the run. Today that is Pi's `pi_rejected` (Pi has processed the prompt and
  stopped where it would call the model); with a model it is the first `text.delta`. It includes
  the HTTP request, run creation and the orchestrator; it excludes Bifrost and the model's own time
  to first token. Each trial hibernates through `dist/cli/lifecycle.js hibernate` (same path, lock
  and audit as the server) and starts once the pod is gone.

| Environment           | Probe                | Set                                 | n   | p50    | p95        | max    | Pass ≤ 8 s  |
| --------------------- | -------------------- | ----------------------------------- | --- | ------ | ---------- | ------ | ----------- |
| k3d (run 37142696913) | first sandbox answer | back-to-back                        | 20  | 3.9 s  | **5.0 s**  | 5.3 s  | yes (proxy) |
| k3d (run 37142696913) | Pi ready             | back-to-back                        | 20  | 3.9 s  | 4.2 s      | 4.2 s  | yes (proxy) |
| k3d (run 37142696913) | Pi ready             | spaced 30 s                         | 5   | 3.0 s  | 3.8 s      | 3.8 s  | yes (proxy) |
| Real, `longhorn`      | first sandbox answer | back-to-back (final run)            | 20  | 14.8 s | **17.2 s** | 24.4 s | **no**      |
| Real, `longhorn`      | first sandbox answer | back-to-back (first run)            | 20  | 15.7 s | 22.4 s     | 25.9 s | **no**      |
| Real, `longhorn`      | Pi ready             | back-to-back                        | 20  | 8.6 s  | 9.7 s      | 9.9 s  | **no**      |
| Real, `longhorn`      | Pi ready             | spaced 30 s (volume fully detached) | 10  | 14.0 s | **14.9 s** | 14.9 s | **no**      |

On k3d the margin for Bifrost + the model's first token is ≈ 3 s at p95. On the real cluster the
budget is gone before any model time.

## First token with a real model (2026-10-04)

Gate install upgraded to `main` at `296c275` (images built from that commit on the build host
and imported into each node: the ghcr packages are still private). Models are configured through
the install admin API (`/v1/install/models`): provider kind **`ollama`** (Bifrost's native Ollama
provider) against the vendor's cloud endpoint, catalog aliases `kimi-k2.7-code` and `glm-5.3`,
both enabled for every team with `kimi-k2.7-code` the default. Workspace sync (KOBE-27) runs
against an in-cluster SeaweedFS, so the wake path includes the workspace restore.

**Chat.** A test user asked kimi-k2.7-code to list `/workspace`: the run woke the sandbox, the
model called the `bash` tool (`ls -la /workspace`), the result came back, and the answer streamed
(`reasoning.delta`, `tool.call`, `tool.result`, `text.delta`, `run.completed`). glm-5.3 (a team
whose default was switched to it for the test, then back) did the same with its own tool call.

**`e2e/gate1.sh` against the real model** (`KOBE_GATE1_MODEL=kimi-k2.7-code`): 82 checks ok, 1
FAIL (cold start). Ten users chatting at once all got streamed model answers; the retry after
the kill was answered by the model.

**Cold start** (`cold` step; strict-local Longhorn workspace; first token = the run's first
`text.delta` or `reasoning.delta`, timed from `POST /messages`):

| Set                                              | n   | p50       | p95        | min / max     |
| ------------------------------------------------ | --- | --------- | ---------- | ------------- |
| Hibernated, back-to-back (full suite run)        | 20  | 15.2 s    | **17.5 s** | 4.8 / 17.9 s  |
| Hibernated, back-to-back (separate run)          | 20  | 15.5 s    | 17.8 s     | 7.5 / 17.8 s  |
| Hibernated, spaced 30 s (volume fully detached)  | 10  | 15.7 s    | 16.6 s     | 15.3 / 16.6 s |
| **Awake sandbox** (no wake; `KOBE_GATE1_WARM=1`) | 20  | **1.5 s** | **1.8 s**  | 1.4 / 1.9 s   |

**The model's share.** With the sandbox awake and Pi running, first token takes 1.5 s (p95
1.8 s): the server, the model-gateway shim, Bifrost and the provider's own time to first token
together. So of the ≈ 15.5 s cold figure, ≈ 1.5 s is model-side and ≈ 14 s is the wake — the
Pi-ready figure measured before (strict-local, spaced: p95 14.0 s), dominated by the volume
attach. The workspace restore (KOBE-27) took 30–50 ms per wake here (small workspaces); it grows
with workspace size. On k3d with the fake upstream the same step gives p50 4.8 s, p95 5.8 s.

## Storage measurements (real cluster)

Asked: measure cold start with Longhorn-backed sandbox volumes, compare other existing classes,
report without deciding. Pi-ready milestones (ms after the waking command; pod timestamps have 1 s
resolution):

| Class                                                   | Set          | n   | Pi ready p50 / p95 | Container started p50 / p95 | Connected p50 / p95 | Notes                                                                                                                                                                            |
| ------------------------------------------------------- | ------------ | --- | ------------------ | --------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `longhorn` (3 replicas)                                 | back-to-back | 20  | 8.6 / 9.7 s        | 5.9 / 6.9 s                 | 7.5 / 8.5 s         | woken pod always on the same node; volume may still be attached when the wake arrives                                                                                            |
| `longhorn` (3 replicas)                                 | spaced 30 s  | 10  | **14.0 / 14.9 s**  | **11.7 / 12.3 s**           | 12.9 / 13.8 s       | the realistic case: users come back minutes later, volume detached                                                                                                               |
| `longhorn-ci-scratch` (1 replica, best-effort locality) | back-to-back | 20  | 8.8 / 12.5 s       | 6.1 / 10.2 s                | 7.7 / 11.4 s        | no better than 3 replicas; one trial 21.7 s                                                                                                                                      |
| `nfs-synology` (NFSv3 share)                            | —            | —   | not measurable     | —                           | —                   | volume provisions and mounts, but `/workspace` is not writable by uid 1000 under gVisor (`touch`: "Operation not permitted"); runs fail (`start_failed` / `session_unavailable`) |
| `local-path` (k3d, for reference)                       | back-to-back | 20  | 3.9 / 4.2 s        | 1.0 / 1.1 s                 | 2.5 / 2.8 s         | not installed on the real cluster                                                                                                                                                |

Control: a gVisor pod with the sandbox image and no volume, pinned to one node, goes from created
to running in ≈ 1 s (5/5). So on Longhorn ≈ 5 s (volume still attached) to ≈ 11 s (detached) of
every wake is the volume attach and mount; the rest (agent connect ≈ 1–2 s, Pi spawn with
kobe-policy ≈ 1 s) matches k3d. The "first sandbox answer" trials (14.8–15.7 s p50) sit between the
two Pi-ready sets because the harness waits for the pod to disappear and then a few seconds of
`kubectl exec` and sign-in pass before the wake, so the volume is mid-detach. Ten Suspended
Longhorn sandboxes woken at once all answered within 17.9 s.

### Longhorn strict-local (decided follow-up)

The chart option `sandbox.workspace.longhornStrictLocal.enabled` (one replica,
`dataLocality: strict-local`, `WaitForFirstConsumer`) was enabled on the gate install
(images `local-c94c126bec61`, the follow-up branch) and measured with a fresh user whose workspace
was provisioned on the class (`c5`):

| Probe                                  | Set          | n   | p50    | p95        | max    | Container started p50 / p95 | Pass ≤ 8 s |
| -------------------------------------- | ------------ | --- | ------ | ---------- | ------ | --------------------------- | ---------- |
| Pi ready (KOBE-25 harness)             | back-to-back | 20  | 8.9 s  | 10.3 s     | 10.7 s | 6.0 / 7.4 s                 | no         |
| Pi ready (KOBE-25 harness)             | spaced 30 s  | 10  | 13.8 s | **14.0 s** | 14.0 s | 11.1 / 11.7 s               | no         |
| First sandbox answer (`gate1.sh` cold) | back-to-back | 20  | 15.0 s | **18.0 s** | 24.0 s | —                           | no         |
| First sandbox answer (`gate1.sh` cold) | spaced 30 s  | 10  | 14.8 s | **15.2 s** | 15.2 s | —                           | no         |

**Strict-local does not help**: the numbers match 3-replica Longhorn. Every woken pod landed on the
replica's node (the same node, 30/30), so locality was in effect; the cost is not the network
path to a replica but Longhorn bringing an engine up at all. Breakdown of one spaced wake, sampled
every 0.3 s (pod phase, the CSI VolumeAttachment, the Longhorn volume's state), typical of three:

| From → to                                 | Time      | What happens                                                      |
| ----------------------------------------- | --------- | ----------------------------------------------------------------- |
| Pod created → Longhorn `attaching`        | ≈ 0 s     | attach requested at once                                          |
| `attaching` → `attached`                  | ≈ 3 s     | Longhorn starts the engine and replica processes on the node      |
| `attached` → `healthy`                    | ≈ 4.5–5 s | Longhorn verifies the (single) replica before reporting it usable |
| `healthy` → VolumeAttachment `attached`   | ≈ 1–2 s   | CSI ControllerPublish completes                                   |
| VolumeAttachment → container running      | ≈ 1.5–2 s | NodeStage/NodePublish (ext4 mount), gVisor sandbox start          |
| Container running → agent connected       | ≈ 1–1.5 s | Node boot under gVisor, session trade                             |
| Connected → Pi ready / Pi's prompt answer | ≈ 1 s     | Pi spawn with kobe-policy                                         |

So ≈ 10–11 s of the ≈ 14 s is volume attach on Longhorn (strict-local or not), and ≈ 3 s is the
sandbox itself — the k3d figure. After a hibernation the volume detaches within ≈ 5 s, so every
realistic wake pays the full attach. No other option was tried (as instructed); the remaining
levers are listed under "Blockers" below.

## Blockers for the first-token criterion

1. ~~A model~~ (KOBE-40/41): merged; first token is measured above.
2. **Volume attach on the real cluster** (≈ 10–11 s per wake on Longhorn, strict-local or not).
   Not fixable by a Longhorn class parameter. Candidate levers, none tried (each needs a decision):
   node-local volumes (`local-path`) with the sandbox pinned to its node (the server would have to
   schedule woken pods onto the volume's node; a lost node then needs the S3 restore); keeping the
   volume attached while hibernated (e.g. a tiny holder pod per hibernated sandbox, which keeps the
   attachment but not the memory); a longer idle timeout; or waking a hibernated sandbox when the
   user opens its thread, before the message is sent, which hides most of the wake.
3. **KOBE-27's restore on wake** (merged): measured at 30–50 ms per wake on the gate install's
   small workspaces; it grows with workspace size.

The miss on the real cluster is accepted for now (Chris, 2026-10-04); storage stays on Longhorn.

## Findings and fixes

1. **Rancher webhook blocks team namespaces (real cluster).** Rancher's
   `rancher.cattle.io.namespaces.create-non-kubesystem` webhook refused the server's namespace
   apply (`Unauthorized`): creating a namespace with Pod Security labels needs `updatepsa` on
   `projects.management.cattle.io`. Every first run failed `start_failed`. Now a chart option,
   `rancher.enabled` (off by default), used by the gate install; the server's error names the
   webhook and the option (verified on the real cluster with the option off: a new team's first
   run fails and the server logs "Rancher's namespace webhook … Set the chart value
   rancher.enabled=true"). That run took 83 s to fail: the router retries a failed wake for its
   90 s budget, and a provisioning refusal is not treated as definitive.
2. **Cold start on Longhorn misses 8 s, strict-local included** (storage section).
3. **NFS class unusable for workspaces under gVisor** (storage section). Not investigated further
   (NFS squash vs. the gVisor gofer).
4. **ghcr packages are private** (Images above).
5. **`helm upgrade --reuse-values` keeps the old chart's defaults.** Upgrading the gate install to
   KOBE-40/41 with `--reuse-values` kept `sandbox.modelGatewayAccess: false`, Bifrost `v2.2.4`
   without persistence, and no `modelGateway` values: sandboxes had no route to the model gateway
   and every run failed `model_error`. Upgrade with the user-supplied values instead
   (`helm get values` → `-f`, with `--reset-values`) so new defaults apply.
6. **Existing team namespaces get the model-gateway egress rule only when the server next
   converges the team** (on its next sandbox provisioning or wake): right after enabling
   model access, an already-awake sandbox cannot reach the gateway (`ECONNREFUSED`, run fails
   `model_error`) until then. A server follow-up could re-converge every team when the sandbox
   settings change.

## Reproduce

```bash
# CI: the e2e workflow runs e2e/run.sh, then e2e/gate1.sh (k3d contexts only).
# Any install you own (throwaway: it signs sandbox wire tokens with the install's keys):
KOBE_GATE1_CONTEXT=<context> KOBE_GATE1_NS=<release namespace> KOBE_GATE1_RELEASE=<release> \
  KOBE_GATE1_OWNER_EMAIL=<owner> KOBE_GATE1_OWNER_PASSWORD=<password> e2e/gate1.sh
# Steps: KOBE_GATE1_STEPS="chat-real chat-stream probe interrupt cold"; KOBE_GATE1_TRIALS (20),
# KOBE_GATE1_P95_MS (8000), KOBE_GATE1_COLD_USER (c1), KOBE_GATE1_SPACING_S (0).
# Pi-ready harness (KOBE-25):
kubectl -n <ns> exec deploy/<release>-server -c server -- node dist/cli/cold-start.js \
  --team-id <team> --user-id <user> --probe pi --trials 20 [--spacing-ms 30000] --p95-max-ms 8000
```

The script is re-runnable: users, teams and sandboxes are reused; each run adds threads.
