# KOBE-22: agent-sandbox provider: namespaces, NetworkPolicy, quotas, warm pool

- **Status:** in review (PR #20)
- **Branch / worktree:** `kobe-22-sandbox-provider` in `../Kobe-wt22`
- **Depends on:** KOBE-6, KOBE-21, KOBE-14, KOBE-9 (merged); contracts PR #13 (merged)

## Acceptance criteria (derived from spec D4, D11–D14, D28, §5.1–5.3, principles 2 and 7; KOBE-9 binding requirements; Hadron unreachable)

1. **ac-1 Namespace per team.** The server creates `kobe-team-<slug>` on demand, labelled with the
   team id; it never reuses a namespace labelled for another team. Pod Security `restricted`.
2. **ac-2 Default-deny network.** A NetworkPolicy selecting every pod in the team namespace allows
   **no ingress** and egress only to the Kobe server, model gateway (Bifrost), MCP proxy and
   egress proxy. No direct internet, no DNS. Nothing else may widen it.
3. **ac-3 Quota.** A ResourceQuota per team namespace (D12 default 20 vCPU / 40 GiB) and container
   defaults; sizing per sandbox 0.5/1 GiB request, 2/4 GiB limit, 10 GiB `/workspace` PVC,
   2 GiB `/tmp` emptyDir; all Helm values.
4. **ac-4 One sandbox per (user, team)** via agent-sandbox v1beta1 (SandboxTemplate, SandboxClaim,
   Sandbox), idempotent across server replicas; a stable sandbox id (session token `sub`).
5. **ac-5 Warm pool.** A `SandboxWarmPool` of pre-started gVisor pods that claims adopt.
6. **ac-6 Isolation (KOBE-9 binding).** `require()` immediately before each creation, the
   `VerifiedIsolation` passed into the spec builders (never a string); the created pod read back
   and deleted on RuntimeClass/handler mismatch; `isolation_runtime_missing` (503) via
   `toResponseBody()`; a ValidatingAdmissionPolicy pins the handler in `kobe-team-*`.
7. **ac-7 Secrets never enter sandboxes.** No Secret volumes/env, no Kubernetes API token in
   sandbox pods (enforced by admission). The only credential is Kobe's own: audience-bound
   session tokens (contract: one token per audience, algorithm pinned, `none` rejected).
8. **ac-8 Least-privilege RBAC.** The server manages only `kobe-team-*` namespaces; namespaced
   permissions only inside them; no Secret reads, no pod create/exec.
9. **ac-9 Tests.** Unit tests with a fake Kubernetes client; chart render tests for every new
   template; e2e on k3d + gVisor + agent-sandbox proves the team namespace, NetworkPolicy, a
   Sandbox under gVisor, and that a sandbox cannot receive inbound traffic.

## Design

- `services/server/src/sandbox/`: `manifests.ts` (pure builders), `provider.ts`
  (`ensureTeam`, `ensureSandbox`, `identifyBootstrapToken`), `kube.ts` (narrow client + real
  adapter), `session-token.ts`, `config.ts` (zod, `KOBE_SANDBOX_CONFIG` + `KOBE_SESSION_KEY_*`),
  `runtime.ts`. Fake cluster + agent-sandbox controller simulation in `src/testing/fake-kube.ts`.
- Route `POST /v1/sandbox/session` (`routes/sandbox.ts`, one line in `app.ts`): a sandbox trades
  its projected bootstrap token for its session tokens. Operator CLI `dist/cli/sandbox.js ensure`
  (used by e2e).
- Team namespace contents (applied with server-side apply, NetworkPolicy first): Namespace,
  RoleBinding (server → manager ClusterRole), NetworkPolicy, ResourceQuota, LimitRange,
  ServiceAccount `kobe-sandbox` (no token automount), copied pull Secrets, SandboxTemplate
  (`networkPolicyManagement: Unmanaged`), SandboxWarmPool. Re-applied every 5 minutes per process.
- Chart: `sandbox` values, `_sandbox.tpl`, `sandbox-rbac.yaml`, `sandbox-admission.yaml`
  (4 ValidatingAdmissionPolicies), `sandbox-session-keys.yaml`; Bifrost NetworkPolicy admits
  team namespaces on its port.

## Decisions

- **Warm pool per team namespace, `sandbox.warmPool.replicasPerTeam` default 1 (spec D12 says
  "2 per cluster").** agent-sandbox v1.0.4 forbids cross-namespace adoption
  (`ErrCrossNamespaceAdoption`) and D11 puts sandboxes in per-team namespaces, so a cluster-wide
  pool cannot serve claims. 1 per team keeps idle cost proportional (each counts against the team
  quota); 0 disables. Warm pods only help **first** sandboxes (fresh PVC): a hibernated sandbox has
  its own PVC and is resumed as a cold pod start (KOBE-25), so the warm pool does not affect the
  hibernated → first-token target.
- **Sandbox id = SandboxClaim UID**; claim name `u-<userId>` makes the (user, team) sandbox unique
  per namespace; a second replica's create gets 409 and uses the winner. No `sandboxes` table in
  this ticket (no migration): Kubernetes is the record of what exists; the §5.4 `sandboxes` row
  (state, `last_active_at`, `retain_until`) belongs with hibernation/offboarding (KOBE-25/28).
- **Bootstrap identity without distributing secrets.** Sandbox pods get a projected
  ServiceAccount token with audience `kobe.sandbox-bootstrap` (rotated by the kubelet, invalid once
  the pod is gone, rejected by the Kubernetes API). The server verifies it with a TokenReview, maps
  pod → claim (pod `claim-uid` label must equal the claim's UID, pod's controlling Sandbox must be
  the claim's), takes the team from the namespace label, re-checks isolation, and issues the four
  session tokens. This works for warm-pool pods, which are started before anyone owns them
  (they get `409 sandbox_unassigned` until claimed). No token Secrets in etcd.
- **Session tokens (settles the contract's SPECULATIVE part): compact JWS, HS256 only**, header
  exactly `{"alg":"HS256","typ":"JWT"}` (none/other alg/kid/jku/x5u/jwk/crit rejected), **one HMAC
  key per audience** (a verifier holds only its own key, so it cannot mint tokens another service
  accepts), TTL 15 min, re-traded with the bootstrap token. Keys: chart-generated Secret
  `<release>-sandbox-session-keys` (kept), server env only.
- **No DNS in sandboxes.** `dnsPolicy: None` (nameserver 127.0.0.1) and `hostAliases` mapping
  `{server,model-gateway,mcp-proxy,egress-proxy}.kobe.internal` to the Services' ClusterIPs, so
  DNS cannot tunnel data past the egress proxy. `HTTP(S)_PROXY` point at the egress proxy.
- **RBAC + admission.** RBAC can't scope cluster-wide verbs by name, so: a cluster role with
  namespaces get/create/patch, RoleBindings create/patch, `bind` only on the manager ClusterRole
  (resourceNames), TokenReview create; a manager ClusterRole bound **per team namespace** by the
  server; a release-namespace Role for the four Services and pull Secrets (by name).
  ValidatingAdmissionPolicies (failurePolicy Fail): (1) server's namespace/RoleBinding writes only
  in labelled `kobe-team-*` namespaces with PSA `restricted`, binding only the manager role to
  itself; (2) every pod created in `kobe-team-*` uses the configured RuntimeClass whose live
  handler matches `^(runsc|kata(-[a-z0-9]+)*)$` (RuntimeClass as param, missing ⇒ deny), no
  Secret volumes/env, no API token, no host namespaces/hostPath, projected tokens only for the
  bootstrap audience; (3) Sandbox/SandboxTemplate specs likewise, templates `Unmanaged`;
  (4) only the server creates/changes NetworkPolicies there (deletes unmatched so namespace
  deletion works; the server has no delete).
- **Sandbox endpoints are cluster-internal**: requests carrying `X-Forwarded-For`/`-Host`,
  `X-Real-Ip` or `Forwarded` (added by the ingress) get 404.
- Hibernated sandboxes (`operatingMode: Suspended`) are reported as `state: "suspended"`; waking
  is KOBE-25's. Team namespace creation is lazy (first sandbox), not at team creation.
- Sandbox `$HOME` is an emptyDir (wiped on hibernate like `/tmp`); root filesystem read-only.

## Security review of PR #20 (coordinator) — resolutions

- **HIGH 1 (Bifrost open before it verifies tokens):** `sandbox.modelGatewayAccess` (default
  **false**) gates both the team NetworkPolicy's Bifrost egress rule and Bifrost's ingress rule for
  team namespaces. **KOBE-40/41 must turn it on together with session-token verification in front
  of Bifrost and restrict sandbox access to the inference path/port only** (no management API).
- **MEDIUM 2 (quota):** `teamQuota` now caps `requests/limits.cpu`, `requests/limits.memory`,
  `requests/limits.ephemeral-storage`, `requests.storage`, `persistentvolumeclaims`, `pods`
  (defaults 20/40 vCPU, 40/80 GiB, 40/160 GiB, 500 GiB, 50, 50); sandbox containers and the
  LimitRange carry ephemeral-storage requests/limits (1/4 GiB). Quotas are per team: cluster-wide
  overcommit across teams is still possible and is capacity planning, not isolation.
- **MEDIUM 3 (server API reachable, no rate limit): chose the port split now.** The server serves
  sandbox endpoints on a **separate listener, port 8081** (`createSandboxApp`: `/healthz`,
  `/v1/sandbox/*` only; Service port `sandbox`); the main app no longer mounts them, the ingress
  only targets port `http`, and the team NetworkPolicy allows only 8081 on server pods. **KOBE-24
  must add the WebSocket (`/v1/sandbox/connect`) to `createSandboxApp`, not to the user app.** The
  session exchange has a per-source token bucket (burst 20, 1/s, per process) checked before any
  TokenReview → 429 + `Retry-After`. Forwarded-header refusal kept as defence in depth.
- **MEDIUM 4 (e2e coverage, enforcement):** e2e now probes from a sandbox-like pod: API Service
  (443), API server on the node (6443), kubelet (10250), 169.254.169.254, another team's pod,
  the server's user port, web, Bifrost, DNS, internet — all must be BLOCKED, with controls from
  the release namespace proving the targets are live. **An in-process "is NetworkPolicy
  enforced" check is infeasible**: enforcement is a CNI property not visible through the API, and
  a canary would need pod-create rights in team namespaces, which the server deliberately lacks.
  Mitigation: e2e is the canary (CI and nightly); docs/install.md says to re-run it after CNI
  changes. Option for later: a chart-installed canary CronJob in a dedicated namespace.
- **MEDIUM 5 (delete failures, recreated RuntimeClass):** deletes of a mismatching sandbox retry
  with backoff and also delete the pod directly; a reconciler (server process, at start and every
  60 s) deletes team pods not under the verified class or **created before the current
  RuntimeClass object** (`creationTimestamp` comparison; also applied in `ensureSandbox` and the
  bootstrap exchange), with their claims. If isolation is definitively lost (class 404 or
  non-isolating handler) it deletes every team pod but keeps claims/PVCs; API errors change
  nothing. RBAC: namespaces list, pods list/delete in team namespaces.
- **LOW 6:** malformed user-id annotation → 401 (`SandboxAuthError`).
- **LOW 7:** before provisioning, the server dry-runs creating namespace `kobe-admission-probe`;
  it must be refused by the server-scope policy, else provisioning fails closed (re-checked until it
  passes once per process). Policy 1 now requires the team-id label and makes it immutable.
- **LOW 8:** `replicasPerTeam: 0` is valid: the v1beta1 CRD has `minimum: 0`, and the claim
  controller cold-starts from the pool's template when no warm sandbox exists
  (`getCandidate` → cold path, agent-sandbox v1.0.4 `sandboxclaim_controller.go`). Kept allowed.
- **LOW 9 (threat model notes):** the bootstrap token is readable by agent code by design; it only
  trades for this sandbox's own session tokens and dies with the pod. `hostAliases` are fixed at
  pod creation: a changed Service ClusterIP reaches new pods after the 5-min re-converge and
  `Recreate` warm-pool update, running pods only on restart/wake. NetworkPolicy covers pod
  traffic only; traffic originated by the node itself (kubelet, image pulls) is not sandbox
  traffic and is out of scope.

## Open questions (for Chris or the coordinator)

- **D12 warm pool "2 per cluster" vs per-namespace warm pools** (see Decisions): accept "1 per
  team namespace (configurable)"? Alternatives: a Kobe-managed budget across teams, or 0 by default.
- Image pull: the server copies `global.imagePullSecrets` into team namespaces (write-only RBAC).
  Node-level registry credentials (k3s `registries.yaml`) avoid that; documented both.
- One Kobe install per cluster is assumed (`kobe-team-*` and the Bifrost namespace label are
  cluster-wide).

## For downstream tickets

- **KOBE-23 (sandbox agent):** env in the pod: `KOBE_SERVER_URL=ws://server.kobe.internal:8081`,
  `KOBE_MODEL_GATEWAY_URL`, `KOBE_MCP_PROXY_URL`, `KOBE_EGRESS_PROXY_URL`, `HTTP(S)_PROXY`,
  `NO_PROXY`, `KOBE_BOOTSTRAP_TOKEN_FILE=/var/run/secrets/kobe/bootstrap-token`. Before dialling:
  `POST http://server.kobe.internal:8081/v1/sandbox/session` with `Authorization: Bearer <file
contents>` (re-read the file each time: the kubelet rotates it) → 200 `{sandbox_id, team_id,
user_id, expires_at, tokens:{"kobe.sandbox-wire":…,"kobe.model-gateway":…,"kobe.mcp-proxy":…,
"kobe.egress-proxy":…}}`; 409 `sandbox_unassigned` → retry after `retry_after_ms` (warm-pool pod);
  429 → wait `Retry-After`; 401/503 → back off. Re-trade before `expires_at` (15 min). `hello.sandbox_id` = `sandbox_id`.
  Read-only root FS; writable: `/workspace` (PVC), `/tmp`, `/home/kobe` (emptyDirs). No DNS.
- **KOBE-24 (registry):** verify the wire token with
  `verifySessionToken(token, "kobe.sandbox-wire", keys["kobe.sandbox-wire"])`
  (`services/server/src/sandbox/session-token.ts`; keys from `loadSandboxConfig`). Liveness of
  `sub`: the claim `u-<user_id>` in `kobe-team-<slug>` with that UID. **Binding:** serve the
  WebSocket from `createSandboxApp` (port 8081), never from the user-facing app.
- **KOBE-25 (hibernate/wake):** hibernate = patch Sandbox `spec.operatingMode: Suspended` (RBAC
  granted: sandboxes get/patch; PVC kept). Wake = call `isolation.require()` first, re-apply the
  Sandbox `podTemplate` from the current template (image, RuntimeClass, hostAliases may have
  changed: a resumed Sandbox uses its own stored podTemplate), set `Running`, then verify the pod
  like `ensureSandbox` does. Warm pods don't help wake (PVC is per sandbox).
- **KOBE-28 (offboarding):** PVCs are owned by their Sandbox (deleted with it); to retain
  30 days, remove the ownerReference (needs `persistentvolumeclaims` patch) before deleting the
  claim. Server has no namespace delete.
- **KOBE-38 (egress proxy) / KOBE-40 (Bifrost) / KOBE-58 (MCP proxy):** give each service only its
  own key from the `<release>-sandbox-session-keys` Secret (`egress-proxy`, `model-gateway`,
  `mcp-proxy`) and verify with the same rules (HS256 pinned, exact header, `acceptsAudience`).
  The team NetworkPolicy allows sandboxes → the proxy pods on 8080, and Bifrost only with
  `sandbox.modelGatewayAccess` (which also opens Bifrost's own policy to team namespaces); the
  proxies have no ingress policy yet. Sandboxes have no DNS: the egress proxy resolves names.
- **KOBE-64 (scheduler):** the scheduler process does not build the provider yet and has no
  session keys; it shares the server ServiceAccount (RBAC already covers it).

## Evidence (acceptance criteria → test or command output)

| AC   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 | `provider.test.ts` "creates the team namespace…", "refuses a namespace labelled for another team", "…unlabelled namespace"; e2e "team namespace carries its team id", "…enforces Pod Security 'restricted'"                                                                                                                                                                                                                                                                                  |
| ac-2 | `manifests.test.ts` "denies all ingress…", "allows egress only to…" (no port 53/ipBlock); `provider.test.ts` "applies the default-deny NetworkPolicy before anything that can start a pod", "re-converges…"; chart "also admits sandboxes … to Bifrost's port"; e2e: no ingress, only policy in namespace, server/Bifrost reached, web/DNS/internet blocked, **inbound to a team pod blocked while the same listener elsewhere is reachable**, foreign NetworkPolicy refused                 |
| ac-3 | `provider.test.ts` quota/LimitRange; `manifests.test.ts` sizing; chart config tests; e2e quota check                                                                                                                                                                                                                                                                                                                                                                                         |
| ac-4 | `provider.test.ts` "claims a sandbox whose claim UID is the sandbox id…", "returns the same sandbox…", "two teams in two namespaces", "uses the claim another replica created first (409)", waits/timeouts; e2e "ensuring it again returns the same sandbox"                                                                                                                                                                                                                                 |
| ac-5 | `manifests.test.ts` warm pool + claim without env/volumes (adoption-compatible); `provider.test.ts` template/warm pool; e2e "team warm pool exists", every pod in the namespace uses gVisor                                                                                                                                                                                                                                                                                                  |
| ac-6 | `provider.test.ts` "runs a fresh isolation check before every sandbox creation", "creates nothing and returns isolation_runtime_missing (503)…", "deletes a sandbox whose pod is not under the verified RuntimeClass", "…handler changed after the check", "…template predates a RuntimeClass change"; `manifests.test.ts` `@ts-expect-error` on a string; route 503 test; chart admission tests; e2e admission refusals (no RuntimeClass, runc) and node runtime handler `runsc` via crictl |
| ac-7 | `manifests.test.ts` "mounts no Secrets and no API token…"; `session-token.test.ts` (per-audience, alg none/HS512/kid/jku refused, tampering, expiry, contract schema); `config.test.ts` (distinct keys, no echo); chart "gives the session keys to the server only"; e2e admission refuses Secret volume / API token; bootstrap 409 for an unclaimed pod, 401 forged, 404 via ingress                                                                                                        |
| ac-8 | chart "never grants wildcards, Secret reads, pod creation, exec or escalate", "bind only the manager role…", "manager role is not bound cluster-wide", release Role by name; e2e: server SA cannot create `kobe-e2e-evil`, list team Secrets, or create team pods                                                                                                                                                                                                                            |
| ac-9 | `pnpm build test typecheck lint format:check license:check` green locally (except the known Helm 4 chart lint); CI: see PR                                                                                                                                                                                                                                                                                                                                                                   |
