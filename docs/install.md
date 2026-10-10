# Installing Kobe

Kobe installs with Helm on k3s (single-node k3s is the minimum). There is no `docker compose`.

## Prerequisites

| Requirement                  | Notes                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------- |
| k3s ≥ 1.30 with Helm 3       | Traefik ingress and cert-manager are used when present                                |
| An isolation runtime         | gVisor (RuntimeClass handler `runsc`) or Kata (`kata*`) — see [Isolation](#isolation) |
| agent-sandbox controller     | `scripts/install-agent-sandbox.sh`                                                    |
| Postgres 17                  | External, or bundled via CloudNativePG (`postgres.mode=cnpg`, operator required)      |
| S3-compatible object storage | External only; Kobe does not bundle an S3 server                                      |
| Registry access              | Images are private on `ghcr.io/splittingatom`; set `global.imagePullSecrets`          |

## Isolation

Kobe refuses to run agents without a gVisor or Kata RuntimeClass. The chart checks this at
`helm install`/`helm upgrade` time (the release fails with remediation text) and again with a
pre-install/pre-upgrade hook Job; the server checks it again itself (see below). The check looks at
the RuntimeClass **handler** (`runsc` or `kata*`), not its name. There is no option to disable it.

Install gVisor on every node (as root, one node at a time — restarting k3s keeps pods running):

```bash
sudo scripts/install-gvisor-k3s.sh
```

Then, once per cluster, create the RuntimeClass and install the agent-sandbox controller:

```bash
kubectl apply -f charts/kobe/runtimeclass-gvisor.yaml
scripts/install-agent-sandbox.sh
```

Verify: a pod with `runtimeClassName: gvisor` running `dmesg` prints `Starting gVisor...`.

The check applies to the RuntimeClass sandboxes will actually use (`isolation.runtimeClassName`,
default `gvisor`): it must exist and have an isolating handler. Besides the install-time check and
the pre-install/pre-upgrade/pre-rollback hook, so that `--no-hooks`, `helm template | kubectl
apply`, or deleting the RuntimeClass later cannot run agents without isolation:

- The **server** checks in process at startup, every minute, and live before every piece of
  agent work. Without a verified RuntimeClass it keeps serving sign-in
  and the admin console but **agents are disabled**: chat returns `isolation_runtime_missing`
  (HTTP 503), the server logs the problem and the fix at `error` level, and install admins see
  both at `GET /v1/install/isolation` (`POST /v1/install/isolation/check` re-checks immediately
  after you fix the cluster). `/readyz` does not disclose the result (it is unauthenticated); it is
  not ready only until the first check completes. Errors and timeouts talking to the Kubernetes
  API count as missing.
- The **scheduler** has no UI, so it runs the same check as an initContainer and refuses to start,
  then re-checks in process like the server.

## Sandboxes

Each user gets one sandbox per team (spec D11): an agent-sandbox `Sandbox` under
`isolation.runtimeClassName`, with a persistent `/workspace` volume, in the team's namespace
`kobe-team-<slug>`. The server creates and maintains these namespaces itself; nothing needs to be
created by hand. Every team namespace gets:

- a **default-deny NetworkPolicy** (`kobe-sandbox-isolation`): no inbound connections at all;
  outbound only to the Kobe server's **sandbox port** (8081, a separate listener with no user API),
  the model-gateway shim (models; `sandbox.modelGatewayAccess`, default on), the MCP proxy and the
  egress proxy — never Bifrost itself. Sandboxes get no DNS: Kobe's services
  resolve through `/etc/hosts` (`*.kobe.internal` → the Services' ClusterIPs), so DNS cannot be
  used to leak data past the egress proxy;
- a **ResourceQuota** (`sandbox.teamQuota`: requests and limits for CPU, memory and ephemeral
  storage, pods, PVCs and requested storage) and a LimitRange with per-container defaults;
- a `SandboxTemplate` and a **warm pool** of `sandbox.warmPool.replicasPerTeam` pre-started
  sandboxes (agent-sandbox warm pools are per namespace; each counts against the team's quota);
- Pod Security Admission `baseline` (see below for why not `restricted`).

The chart installs **ValidatingAdmissionPolicies** that hold whatever creates the pod (server,
agent-sandbox controller, an operator): in `kobe-team-*` namespaces every pod must use
`isolation.runtimeClassName` and that RuntimeClass must have a gVisor/Kata handler; pods may not
mount Secrets, read Secrets into env, mount a Kubernetes API token, use host namespaces or
`hostPath`; they must meet Pod Security `restricted` (non-root, seccomp `RuntimeDefault`/
`Localhost`, all capabilities dropped, no privileged containers, `restricted` volume types) with
one exception: sandbox containers add `SETUID` and `SETGID` (nothing else) and allow privilege
escalation, so the image's `kobe-runas` helper can run each Pi process and its tools under a uid
of their own, separate from the agent and from other threads (KOBE-71; the capabilities exist
inside the gVisor/Kata sandbox kernel only). That is why the namespace label says `baseline`; and
only the Kobe server may add or change NetworkPolicies there. The server's own
cluster-wide permissions (namespaces, RoleBindings) are confined to `kobe-team-*` by the same
mechanism. Sandboxes identify themselves to the server with a projected ServiceAccount token
(audience `kobe.sandbox-bootstrap`, which the Kubernetes API itself rejects) and receive
short-lived, audience-bound session tokens in return; no other credential enters a sandbox.

The server refuses to provision sandboxes unless those policies are in effect (it checks with a
server-side dry run at first use), and every minute deletes any team pod that is not running under
the verified RuntimeClass or predates the current RuntimeClass object. NetworkPolicies need a CNI
that enforces them (k3s's built-in kube-router does); this cannot be verified through the API, so
the e2e suite checks enforcement from a sandbox (`e2e/run.sh`) — run it after changing the CNI.

Limit processes per pod with the kubelet (k3s: `--kubelet-arg=pod-max-pids=4096` on every node);
Kubernetes has no per-pod setting for it.

**Rancher-managed clusters:** Rancher's namespace webhook
(`rancher.cattle.io.namespaces.create-non-kubesystem`) refuses namespaces carrying Pod Security
labels unless the caller may `updatepsa` on Rancher projects, so without it the server cannot
create team namespaces: runs fail, and the server's error names the webhook and this setting.
Install with `--set rancher.enabled=true`, which grants the server's ServiceAccount exactly that
verb (a ClusterRole and ClusterRoleBinding named `<release>-<hash>-rancher-updatepsa`). Off by
default; it changes nothing on clusters without Rancher.

Private registries: the names in `global.imagePullSecrets` are copied into each team namespace for
the kubelet (pods there cannot mount them). Alternatively configure registry credentials on the
nodes (k3s `registries.yaml`). Kobe assumes one install per cluster (`kobe-team-*` names are
cluster-wide).

### Workspace storage

Each sandbox's `/workspace` is a PersistentVolumeClaim of `sandbox.workspace.storageClass` (empty:
the cluster default). Hibernating a sandbox stops its pod and keeps the volume; waking it attaches
the volume again, and that attach is on the path to the user's first token (target: p95 ≤ 8 s
from hibernated). Measurements on a 4-node cluster are in
[gates/gate-1.md](gates/gate-1.md#storage-measurements-real-cluster):

| Class                                                                   | Wake (hibernated → Pi ready) | Notes                                                                           |
| ----------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| `local-path` (k3s default)                                              | ≈ 4 s                        | pins each sandbox to one node; single-node clusters                             |
| Longhorn, replicated (3 or 1 replicas, no locality)                     | ≈ 14 s once detached         | volume follows the pod anywhere; too slow for the target                        |
| Longhorn strict-local (`sandbox.workspace.longhornStrictLocal.enabled`) | ≈ 14 s once detached         | one replica on the sandbox's node; no faster: Longhorn's engine start dominates |
| NFS (a Synology NFSv3 share was tried)                                  | —                            | not writable by the sandbox user under gVisor                                   |

**Longhorn strict-local.** `--set sandbox.workspace.longhornStrictLocal.enabled=true` creates a
StorageClass (`<release>-<hash>-workspace-strict-local`: Longhorn, `numberOfReplicas: 1`,
`dataLocality: strict-local`, `WaitForFirstConsumer`) and uses it for new workspaces; leave
`sandbox.workspace.storageClass` empty (setting both is refused). Existing workspaces keep their
class. Trade-off: each workspace has exactly one copy, on one node.

**When a node is lost**, strict-local volumes on it are gone (Longhorn reports them faulted).
The durable copy of a workspace is the S3 workspace sync (KOBE-27: the agent pushes changes to
S3 through the server every 60 s, after each run and on hibernate; a sandbox that starts on an
empty volume restores from S3 before any prompt reaches Pi), so changes from the last minute
before the failure can be lost, and so is anything outside `/workspace` (which hibernation wipes
anyway). Recovery is manual for now: delete the affected sandbox's workspace PVC
(`kubectl -n kobe-team-<slug> delete pvc workspace-u-<user-id>`); the next message wakes the
sandbox on a fresh volume, which restores from S3. S3 sync needs `s3.bucket` and KOBE-27; without
it a lost node loses those workspaces for good. Conversations are never at risk: Postgres is the
record of threads and runs.

### Longhorn sizing for 10 GiB strict-local workspaces

A strict-local volume keeps its single replica on the node where its sandbox starts, so that node
must have room for the whole volume when the pod is scheduled. Longhorn refuses to schedule a
replica when `(already scheduled + this volume) > (disk size - reserved) x over-provisioning%`, or
when free space would fall under `storage-minimal-available-percentage`. The default
over-provisioning is 100%, which counts every thin volume at its full size: ten 10 GiB workspaces
promise 100 GiB although each holds a few hundred MiB. On a kobe-gate1 test cluster this left a
sandbox in `ContainerCreating` for over 30 minutes (`LocalReplicaSchedulingFailure: insufficient
storage` while 419 GB were free).

- Set Longhorn's `storage-over-provisioning-percentage` to at least **200** (Longhorn UI: Settings,
  or `kubectl -n longhorn-system edit settings.longhorn.io storage-over-provisioning-percentage`).
  Workspace volumes are thin, so this is safe as long as real usage is watched.
- Keep `storage-minimal-available-percentage` at 25 or more (the default). It is the guard that
  matters once over-provisioning is raised: Longhorn stops placing replicas on a disk with less
  than that share free, whatever has been promised.
- Rule of thumb for the promise: `users x teams x workspace size` spread across the nodes you
  want sandboxes on, should stay under `disk x (over-provisioning / 100)` per node; size real disks
  for what workspaces actually hold, not for their 10 GiB limit.
- Longhorn must be able to place a replica on every node that can run sandboxes. A node that is
  cordoned in Longhorn (scheduling disabled) or full cannot start strict-local sandboxes.

**When a sandbox does not start.** After a wake the server waits for the sandbox pod to be Ready
(up to 90 s, the wake budget). It keeps waiting while the pod shows progress (image pull,
ContainerCreating, a single `FailedMount`) and fails early only on a definite signal: a replica or
storage that cannot be scheduled (`LocalReplicaSchedulingFailure`, `FailedScheduling` with
insufficient storage or no nodes available), `FailedAttachVolume` repeating (3 times or over a
minute), or `ImagePullBackOff`/`ErrImagePull`. Only events of that wake about that pod and volume
count. The run then fails with `workspace_unavailable` ("Your workspace could not be started because
the cluster could not provide it. Ask your install admin to check the cluster."); members never
see node or volume names.

Install admins find the reason in the install audit log: filter on action `sandbox.wake_stalled`
(`GET /v1/install/audit?action=sandbox.wake_stalled`). `cause` is one of `volume_unschedulable`,
`volume_attach`, `scheduling`, `image_pull`, `unknown`; `detail` is the cluster's own event text
followed by a suggested remedy. The server log has the same line (level error, "sandbox not ready:
failing the wake"). The server never deletes a pod or volume for this: if a workspace that has
never run is stuck on a volume that cannot attach, delete its PVC by hand
(`kubectl -n kobe-team-<slug> delete pvc workspace-u-<user-id>`) after confirming it holds no data;
the next message starts a fresh sandbox. The server needs `list` on events in team namespaces
(included in the chart role).

## Egress

Sandboxes reach the internet only through the **egress proxy** (spec D28), and only over HTTPS:
`HTTPS_PROXY` points at it, the team NetworkPolicy allows nothing else, and the proxy admits only
team namespaces. It is **default deny**: a fresh install reaches nothing. Install admins define the
**ceiling** (Install console → Egress ceiling; presets: package registries, which start in the
ceiling, and git hosts, which start out of it); team admins **enable** domains within it (Team
console → Egress). `*.example.com` matches subdomains, never `example.com` itself. Changes apply
within a second (Postgres `LISTEN/NOTIFY`), without restarts.

For each `CONNECT host:443` the proxy checks the sandbox's egress session token, that its user is
still an active member of the team, the team's allowlist, then resolves the name itself and
refuses it if **any** address is private, loopback, link-local (cloud metadata), CGNAT, multicast
or reserved, or in `egressProxy.deniedCidrs` (add your pod/Service CIDRs if they are not private
ranges; IPv4 entries are also excluded in the proxy's NetworkPolicy). It connects to the address it checked and requires the TLS ClientHello's server name to
equal the CONNECT host. It never decrypts traffic. Plain HTTP and other ports are refused
(`egressProxy.allowedPorts`, default 443), except for domains with injected headers (below).

- **Internal targets** (e.g. a package mirror inside your network) must be allowed explicitly:
  add their addresses to `egressProxy.allowedInternalCidrs` and, because the proxy's own
  NetworkPolicy only lets it reach public addresses, a peer in `egressProxy.networkPolicy.extraEgress`
  (for an in-cluster Service: a `namespaceSelector`/`podSelector` for its pods; NetworkPolicy
  matches pods after Service translation). The domain must still be in the ceiling and enabled.
- **External Postgres:** the proxy reads allowlists and writes its connection log as the app role.
  Set `egressProxy.networkPolicy.databasePeers` (an `ipBlock` or selector for your database) so its
  NetworkPolicy reaches only the database on `databasePort`; when empty it may reach any address on
  that port.
- **Known limit: domain fronting.** The proxy sees only the TLS server name. On shared hosting
  and CDNs (CloudFront, Fastly, Akamai, App Engine, GitHub Pages, …) a client can name an allowed
  front in TLS and ask for another customer's site inside the encrypted request. The consoles flag
  such domains; prefer a provider's own domain. Wildcards directly on a public suffix
  (`*.co.uk`, `*.github.io`) are refused (Public Suffix List). ClientHellos with Encrypted Client
  Hello (ECH/ESNI) are refused, since the real name would be hidden.
- **Revocation** reaches open tunnels: disabling a domain, changing the ceiling, removing a member
  or deactivating a user closes the affected tunnels within a second (and a re-check every 30 s
  catches anything missed). Tunnels also close when the session token that opened them expires
  (15 minutes) and after `egressProxy.limits.maxTunnelSeconds` (3600).
- **Unauthenticated sockets** have their own budget: 5 s to send the request head, at most
  `limits.unauthenticatedPerSource` (16) per source address (one sandbox pod) and
  `limits.unauthenticated` (1024) in total, so one sandbox's connection flood cannot take capacity
  from other teams' tunnels.
- **Limits** (per proxy replica): `egressProxy.limits.connectionsPerSandbox` (64),
  `connections` (4096), `bandwidthBytesPerSecond` per sandbox (20 MiB/s), `idleTimeoutSeconds` (300).
- **Logging:** every connection is counted in the audit log (`egress.connection`, aggregated per
  user, sandbox, host and outcome every `egressProxy.auditFlushSeconds`) and logged individually as
  JSON on the proxy's stdout. Blocked attempts are shown on the user's active run (`egress.blocked`).
- **Proxy credentials for tools:** Pi's environment is built from an allow-list, so the pod's
  `HTTPS_PROXY` (which has no credentials) does not reach the tools Pi runs. Instead
  kobe-sandbox-agent keeps the sandbox's rotating egress token in a private file per Pi process
  (0600), and Pi gets `BASH_ENV=/opt/kobe/egress-env.sh` (root-owned, in the sandbox image):
  every bash tool call sources it and exports
  `HTTPS_PROXY=http://<thread id>:<token>@egress-proxy.kobe.internal:80` (and the lowercase and
  `HTTP_` variants), so curl, pip, npm, git and Python use the proxy with a fresh token, and a
  blocked request shows in the thread that made it. The token is never in a pod spec, Pi's
  environment or an argv, and the script pauses `bash -x` tracing while it handles it. It is in the
  tool shell's environment, though: a tool that prints its environment or proxy URL (`env`,
  `curl -v`) shows it in the tool result. That token is the sandbox's own, valid 15 minutes and only
  for the egress proxy. Processes
  started earlier keep the token they started with (15 minutes).

### Request access

When the proxy blocks a domain that is in the ceiling, the chat shows the notice with **Request
access** (D28: no user self-allow). It notifies the team's admins by email (the requester's name,
the blocked host, the ceiling pattern that would allow it, and the thread id; never a URL or the
conversation) and lists the request in Team console → Egress → Access requests. **Approve** enables
that pattern for the team (still only within the ceiling; if it left the ceiling the approval is
refused and the request stays open) and settles everyone's pending requests for it; **Deny**
settles them too. Requesters are emailed the decision and the chat notice shows it. A member may
have 20 open requests and make 10 per hour. Everything is audited (`egress.request.created`,
`egress.request.decided`, `egress.domain.enabled`). Domains outside the ceiling offer no request:
only an install admin can add them.

### Header injection

Team admins can configure up to 8 **injected headers** per enabled domain (Team console → Egress,
e.g. `Authorization` for a private package index). Values are sealed in Postgres with a dedicated
secret (`<release>-egress-headers`, key `secret`, generated and kept; or
`egressProxy.headerSecret` naming your own), held only by the server and the egress proxy. To
rotate it, move the old value to `secret-previous`, set a new `secret` and restart: the server
re-seals stored values at start-up, after which `secret-previous` can go. They are
**write-only**: the API and console list header names (to team admins only), never values; the audit log records names
only (`egress.header.set`, `egress.header.cleared`); disabling the domain deletes them.

Headers can't be added to an opaque HTTPS tunnel, and Kobe does not intercept TLS (there is no
Kobe CA). So for a domain with injected headers the sandbox uses **plain `http://` URLs**, and the
proxy upgrades them:

1. The tool sends `GET http://pkgs.example.com/simple/` to the proxy (its `HTTP_PROXY`), with the
   egress token. The proxy checks the token, membership and allowlist exactly as for CONNECT.
2. It requires injected headers for the matched pattern: plain HTTP to any other domain is still
   refused. It removes `Proxy-*`, hop-by-hop headers and any client header named like an injected
   one, sets `Host`, and adds the team's headers.
3. It resolves the name once, refuses internal addresses, connects to the checked address on 443
   and does TLS itself, with SNI = the domain and the certificate verified against it (system CAs).
4. It relays the response. A redirect to the same domain's `https://` URL is rewritten to `http://`
   (so the next request comes back and gets the headers); a redirect to another host is passed
   through and checked as its own request (headers are only ever sent to their own domain). A
   response header that echoes an injected value is dropped.

Headers need an **exact** domain: a wildcard (`*.example.com`) is refused, since the sandbox could
send them to any subdomain whose certificate it controls. Only GET, HEAD, POST, PUT, PATCH, DELETE
and OPTIONS are relayed (TRACE would reflect the headers). Limits: `egressProxy.upgrade.maxRequestBytes` (100 MiB), `maxResponseBytes` (2 GiB),
`timeoutSeconds` (600), plus the per-sandbox connection and bandwidth limits. A `CONNECT` to a
domain with injected headers is refused with a message pointing at `http://`. Pointing tools at
`http://` (the least surprising option: the URL says what happens, and nothing in the sandbox is
rewritten behind the user's back):

```bash
pip install --index-url http://pkgs.example.com/simple/ --trusted-host pkgs.example.com mypkg
npm install --registry http://npm.example.com/ mypkg
git -c url."http://git.example.com/".insteadOf="https://git.example.com/" clone https://git.example.com/org/repo.git
curl http://api.example.com/v1/items
```

**Limitation: absolute `https://` links in responses.** The proxy never rewrites bodies. A registry
that answers with absolute `https://<same domain>/…` URLs (some PEP 503 simple indexes link
files that way, npm metadata's `dist.tarball`, git LFS batch responses) makes the tool open a
CONNECT to that domain for the next step, which is refused (`headers_required`). Workarounds: use
an index that emits relative links (pip's simple index from most servers, e.g. devpi, pypiserver,
Artifactory's "relative" mode) so the files are fetched over `http://` too; for npm point the
registry's tarball base URL at `http://` (or set its "relative tarball URL" option); for git LFS
set `lfs.url` to the `http://` endpoint. If the files are served from another host (a CDN), enable
that host without injected headers and they are fetched over HTTPS normally.

pip needs `--trusted-host` (or `PIP_TRUSTED_HOST`) for an `http://` index; the hop from the proxy to
the domain is still verified HTTPS. Put these in the agent's instructions or the project's config
(`pip.conf`, `.npmrc`, `git config`) for the domains your team configured. Trust boundary: the
upstream sees the headers and its responses reach the sandbox, so configure headers only for
domains you trust with that credential; a body that echoes the credential is not filtered.

## Models

Sandboxes reach models only through **Bifrost** (Apache-2.0, `bifrost.image`, pinned by digest) and
only via Kobe's **model-gateway shim** (spec D30): no provider key ever enters a sandbox.

- **Configuration lives in Kobe.** Install admins add **providers** (OpenAI, Anthropic, Gemini,
  Ollama, or any OpenAI-compatible endpoint such as vLLM) with their API keys, and publish the
  **model catalog** (aliases such as `fast`, `smart`, `local`); team admins enable a subset and a
  default (install console **Models and providers**, team console **Models**). Keys are stored
  sealed (AES-256-GCM) in Postgres, are write-only in the API, and are never logged or audited
  (only "key set/changed").
- **Which model a run uses.** The agent's pinned model if it has one, else the model the person
  chose for the conversation (the chat's model picker), else the team's default. A pinned or chosen
  model the team doesn't enable fails the run with a clear error; it never falls back silently.
- **Aliases are names, not models.** A conversation (or agent) keeps the alias it chose, so an
  alias removed from the catalog and **added again** with another provider or model is used again
  by every conversation that chose it, on the new target, once a team enables it. Re-pointing an
  alias (Edit) changes its model everywhere at once in the same way.
- **Model listing.** The catalog editor suggests model ids from Bifrost's list for the provider;
  "Ask the provider" has Bifrost call the provider's list-models API with the stored key (audited
  `models.provider.models_refreshed`, 6 per minute per provider). The server itself never calls a
  provider.
- **Kobe pushes it to Bifrost.** The server reconciles Bifrost through Bifrost's admin API: on every
  change (Postgres `LISTEN/NOTIFY`, within seconds) and every 30 s. One server replica leads (a
  Postgres advisory lock); `GET /v1/install/models` reports `gateway.in_sync` and the last error.
  Bifrost holds one customer (the install), one team per Kobe team and one virtual key per member
  of each team, allowed exactly the team's enabled models. Kobe owns this Bifrost: anything else
  configured in it (by hand, through its UI) is removed by the next sync.
- **Provider endpoints.** OpenAI, Anthropic and Gemini providers always use their vendor's
  endpoint; other providers' keys go only over `https://`; changing a keyed provider's endpoint
  requires entering the key again (a stored key is never sent somewhere new), and the audit log
  records the endpoint host. `bifrost.allowUnsafeProviderEndpoints` (Helm only, never the admin
  API) lifts the first two rules for test installs (the e2e suite's fake provider).
- **Sandboxes call the shim** (`model-gateway.kobe.internal`) with their short-lived
  `kobe.model-gateway` session token as the API key (`Authorization: Bearer`, `x-api-key`,
  `x-goog-api-key` or `?key=`). The shim verifies it, checks that the user is still an active member
  and the sandbox not destroyed, hibernated or replaced (cached `modelGateway.cacheTtlSeconds`, 5 s:
  revocation takes at most that long), and forwards **inference paths only** (`/v1/chat/completions`,
  `/v1/responses`, `/v1/models`, `/anthropic/v1/messages[/count_tokens]`,
  `/genai/v1beta/models/<provider>/<model>:generateContent|streamGenerateContent|countTokens`) to
  Bifrost with the member's virtual key. Models are named `<gateway provider>/<model>` (the catalog
  API returns `gateway_model`); the shim refuses a model the team has not enabled itself, so a
  disable holds even while a push to Bifrost is failing. Limits per replica
  (`modelGateway.limits`): bodies up to 8 MiB, request bytes in memory 128 MiB in total and
  32 MiB per sandbox, 16 concurrent calls and 60 requests (then 10/s) per sandbox; beyond them 429. The shim's memory limit must cover `inflightBytes` + 256 Mi (checked at render time). Two
  replicas by default.
- **Network:** Bifrost admits only the shim and the server; its own egress is DNS and public
  addresses on `bifrost.networkPolicy.allowedPorts` (443). The shim admits only team namespaces and
  reaches only DNS, Bifrost and Postgres.
- **Local models** (Ollama, vLLM on your network or in the cluster): set `allow_private_network` on
  the provider and add a peer for that host to `bifrost.networkPolicy.extraEgress`, e.g.
  `[{to: [{ipBlock: {cidr: 10.20.30.40/32}}], ports: [{protocol: TCP, port: 11434}]}]`.
- **One Bifrost replica, persistent.** Bifrost keeps virtual keys (and, with budgets, spend
  counters) in its own SQLite store on `bifrost.persistence` (1 Gi PVC; `Recreate` updates). Without
  persistence a restart loses them; the sync rebuilds everything within seconds (new virtual keys)
  but budget counters start over.
- **Server → Bifrost is plain HTTP inside the cluster** (Bifrost's admin password and provider
  keys cross the pod network unencrypted); NetworkPolicies limit who can connect, not who can
  observe node traffic. Use a CNI with encryption (e.g. WireGuard) if that matters to you.
- **Secrets:** `bifrost.keysSecret` (or a generated, kept `<release>-model-keys`) holds Bifrost's
  admin password and encryption key, and Kobe's two sealing secrets (`provider-keys`: server only;
  `virtual-keys`: server and shim). Losing `provider-keys` means re-entering provider keys.
  **Rotating** `provider-keys` or `virtual-keys`: copy the old value to `provider-keys-previous` /
  `virtual-keys-previous`, put a new one in place, restart the server and shim; the sync re-seals
  stored values with the new secret within a minute; then remove the `-previous` key.
- **Bifrost logs no prompts** (`enable_logging: false`). Usage is recorded by Kobe's shim
  (`run_usage`, KOBE-43): one row per model call with input, output and cache tokens taken from the
  provider's own usage report in the response (the final stream event or the JSON body), the model,
  latency, and the team, user and sandbox of the session token (plus the run, its thread and agent
  when Pi names an active run). A response without a usage report (a stream cut short, a request
  that did not ask for usage) is charged an estimate: request size / 4 input tokens and generated
  text / 4 output tokens, and at least the output the request allowed
  (`max_tokens` and kin, 8,192 when unset, capped at 65,536); a 5xx counts the same, a 4xx is
  free. Background Responses (`background: true`, billed later) are refused. Per-call tool fees
  (hosted web search, image generation) are not in usage reports and not counted. The ledger is
  append-only. Rows are written right after each call.
- **Budgets and rate limits** (KOBE-42, D30): budgets in **dollars** (at catalog prices) and in
  **tokens** (input + output + cache reads + cache writes, every model; this is what caps models
  without prices such as Ollama Cloud's), each monthly with an optional daily cap, for the install
  (`PUT /v1/install/budget`, install admins; also the per-user request rate, default 60/min), each
  team, a team's **default member budget** (every member without one of their own) and single
  members (`/v1/team/budgets`, team admins; a team may only lower the rate). Periods are calendar
  months and days in **UTC**. At 80 % team admins (and the member, for their own budget; install
  admins for the install's) get an email (at most one per budget and threshold per period; an 80 %
  warning is skipped once 100 % is reached; at most 20 budget emails per person per day) and
  members see a banner in the chat; at 100 % the model-gateway shim refuses new model calls (402
  `budget_exhausted`), new runs are refused (429 `budget_exhausted`), and running ones finish
  their current step and end `budget_stopped`, pending approvals expire; audited
  `models.budget.reached`. Calls in flight are never cut; each shim replica reserves what an
  admitted call may cost until its usage row lands (a member's reservations hold at most a quarter
  of what is left of a shared budget), so on one replica a budget is exceeded by at most the last admitted call plus estimation
  error. Replicas do not share reservations: with several, simultaneous calls can overshoot by up
  to about the budget that was left, per replica (Postgres-backed reservations are a follow-up). Enforcement is at the identities the session token proves, never the advisory run
  id. The per-user request rate is enforced by each shim replica (so up to replicas × the rate in
  total) and, install-wide, by Bifrost on each member's virtual key (pushed by the gateway sync).
  Bifrost's own dollar budgets are not used (it prices calls with its own list). Budget data is
  guarded in Postgres: spend counters change only through the ledger, alerts only for a budget
  really crossed in the current period, alert emails only with their alert.
- **Prices are optional, per catalog model**: `input_usd_per_mtok`, `output_usd_per_mtok` and
  optionally `cache_read_usd_per_mtok` / `cache_write_usd_per_mtok` (dollars per million tokens;
  cache prices default to the input price) on `POST/PATCH /v1/install/models/catalog`. Providers
  such as Ollama publish no prices: without input and output prices calls are counted in tokens
  with no cost. A call is priced when it is recorded (later price changes do not rewrite history).
  Dashboards: team console **Usage** (`GET /v1/team/usage`, team admins) and install console
  **Usage and spend** (`GET /v1/install/usage`, `install.usage.read`), both with `from`/`to` (at
  most 400 days) and `bucket` (`hour`/`day`); per run and per thread for whoever can read them
  (`GET /v1/runs/{id}/usage`, `GET /v1/threads/{id}/usage`).

## MCP connectors

Sandboxes reach remote MCP servers only through the **MCP proxy** (spec D27): Streamable HTTP
servers only (no stdio), registered by install admins, enabled per team with an exposure
(read-only, all, custom). The proxy holds no database credentials and no connector credentials of
its own. For every request it checks the sandbox's `kobe.mcp-proxy` session token, then asks the
server on its **internal port 8082** (reachable only from the proxy's pods, and keyed with the
chart-generated `<release>-mcp-proxy-internal` Secret, or `mcpProxy.internalKeySecret` for offline
renders). The server lists only the team's exposed, pinned tools, and decides every `tools/call`
with the same policy engine as the sandbox (D29): a call that needs approval runs only with a
valid signed approval for exactly that run, tool and input, used once. Every allowed call is
written to the audit log (`mcp.tool_call`) before the proxy forwards it.

The proxy connects to MCP servers **directly**, not through the egress proxy: the egress proxy
enforces the teams' sandbox allowlists, while connectors are governed by the install registry, and
the MCP proxy is not a sandbox. Its own NetworkPolicy allows DNS, the server's internal port, and
public addresses on `mcpProxy.allowedPorts` (default 443). It resolves each connector's host itself
and refuses private, loopback, link-local (cloud metadata) and reserved addresses unless listed in
`mcpProxy.allowedInternalCidrs` (an on-premises MCP server; add a matching
`mcpProxy.networkPolicy.extraEgress` peer for in-cluster targets). Connector URLs must be HTTPS
(`mcpProxy.allowInsecureHttp` exists for development and CI only); redirects are not followed.
Limits per proxy replica: `mcpProxy.limits.callsPerSandbox` (8 concurrent), `requestBurst` /
`requestsPerSecond` (60, then 10/s), `maxRequestBytes` (1 MiB), `maxResponseBytes` (4 MiB),
`upstreamTimeoutSeconds` (55).

## Install

Create the Secrets the chart references, then install:

```bash
kubectl create namespace kobe
kubectl -n kobe create secret docker-registry ghcr-pull \
  --docker-server=ghcr.io --docker-username=<user> --docker-password=<read:packages token>

# External Postgres: an app-role URL (non-owner, NOSUPERUSER NOBYPASSRLS) and an owner URL.
kubectl -n kobe create secret generic kobe-db \
  --from-literal=app-url='postgres://kobe_app:...@db:5432/kobe' \
  --from-literal=migrate-url='postgres://kobe_owner:...@db:5432/kobe'

kubectl -n kobe create secret generic kobe-s3 \
  --from-literal=access-key-id=... --from-literal=secret-access-key=...

# SMTP credentials, if your relay needs AUTH (omit smtp.existingSecret otherwise).
kubectl -n kobe create secret generic kobe-smtp \
  --from-literal=username=... --from-literal=password=...

helm install kobe charts/kobe -n kobe \
  --set global.imagePullSecrets[0].name=ghcr-pull \
  --set ingress.host=kobe.example.com \
  --set ingress.tls.clusterIssuer=letsencrypt \
  --set postgres.external.existingSecret=kobe-db \
  --set s3.endpoint=https://s3.example.com --set s3.bucket=kobe --set s3.existingSecret=kobe-s3 \
  --set smtp.host=smtp.example.com --set smtp.from='Kobe <kobe@example.com>' \
  --set smtp.existingSecret=kobe-smtp
```

### Object storage (S3)

Kobe keeps a durable copy of every sandbox's `/workspace` in the bucket (`sandbox.workspaceSync`,
on by default once `s3.bucket` is set), so a lost or rebuilt volume loses no files. Only the
server holds the S3 credentials: sandboxes send and fetch files through the server's sandbox port
and get no network path to the object store. Objects live under
`teams/<team-id>/users/<user-id>/workspace/<sha256>` (plus `…/shared/<id>` for shared files).
Give the credentials read, write and delete on the bucket (collection deletes unreferenced
content). Without `s3.bucket`, workspace sync stays off and the server logs a warning.

`s3.prefix` (default empty) puts every object under a key prefix, for a bucket shared with other
applications. It must be relative and end in `/` (for example `kobe/`; letters, digits and
`! _ . * ' ( ) / -` only); the chart rejects anything else. It is applied on the server and the
scheduler (`KOBE_S3_PREFIX`). Changing it on an existing install hides the objects written under
the old prefix, so move them first or keep the old value. `kobe backup` and `kobe restore` read
`KOBE_S3_PREFIX` too; set it to the same value.

### Sandbox tool executor

By default Pi's built-in tools (`bash`, `read`, `write`, `edit`, `ls`, `grep`, `find`) run inside
Pi's own process tree and uid. With `--set sandbox.toolExecutor.enabled=true` each thread's tools
run in an executor process under a second uid, the partner of the thread's Pi uid (KOBE-167;
design in `docs/design/paired-tool-uid.md`), so a prompt-injected tool cannot read Pi's memory, the
model-gateway tokens or write Pi's config directory. The executor needs the partner groups the
chart already gives the sandbox agent; an agent that is asked for it without them refuses to
start. It applies to sandboxes started after the change (running ones keep the old setting until
they restart). One extra Node process runs per thread that uses a tool.

The k3d e2e (`executor` shard, KOBE-168) runs the whole suite with the flag on under gVisor and
proves that a tool cannot signal or ptrace Pi, read `model.json` or the agent's tokens, write Pi's
`agent/` directory or private HOME/TMPDIR, or plant code a Pi loads; that a thread's tool cannot
reach another thread's Pi (which also closes KOBE-228: with the flag on a Pi's HOME is private);
and that the workspace and KOBE-27 sync still work for both uids. To turn it on:

```bash
helm upgrade kobe charts/kobe -n <namespace> -f <your values> --reset-values --set sandbox.toolExecutor.enabled=true
```

Running sandboxes keep the old setting until they restart (hibernate and wake them, or wait for
idle hibernation). To turn it off set it back to `false`; the same applies. What it costs: one Node
process per thread that runs a tool, started on that thread's first tool call (resident memory
and the cold-start effect are measured in `docs/ledger/KOBE-168.md`); no extra pod, no
extra network hop. With the flag off, threads in one sandbox share Pi's HOME (KOBE-228).

### Email (SMTP)

SMTP is required: Kobe is invite-only and sends invitations and password-reset links by email.
`smtp.security` is `starttls` (default, port 587, the upgrade is required), `tls` (implicit TLS,
port 465) or `none` (unencrypted; only for an in-cluster relay, and refused together with
credentials). Certificates are always verified. Credentials come only from `smtp.existingSecret`
(keys `username`, `password`), never from values. The server sends mail lazily, so a wrong SMTP
setting shows up as `"emailSent": false` on new invitations and as errors in the server log, not
as a failed start.

With bundled Postgres instead, install the [CloudNativePG operator](https://cloudnative-pg.io)
first and set `postgres.mode=cnpg`; the chart creates the Cluster, the `kobe_owner` database owner
and a separate `kobe_app` login role. The chart generates and keeps the `kobe_app` password; with
GitOps tools that render offline (Argo CD, `helm template`), pre-create a `kubernetes.io/basic-auth`
Secret (`username: kobe_app`) and set `postgres.cnpg.existingAppSecret`, or every render would
rotate it. The generated Secret is kept on `helm uninstall`; delete it when reinstalling from
scratch.

Every value is validated by `charts/kobe/values.schema.json`; unknown keys are rejected.

### Migrations

Install and upgrade with `--wait`. Schema migrations run as the database owner in a Job — the
only pod that holds owner credentials — before upgrades (`pre-upgrade` hook) and, for external
Postgres, before the first install (`pre-install` hook). With bundled CloudNativePG the first
install migrates in an ordinary Job once the Cluster accepts connections. Server and scheduler
pods wait in a `wait-for-migrations` initContainer (running as the app role) until their build's
migrations are applied, so they never start against an older schema; a failed migration keeps
them from becoming ready and fails `helm install --wait`.

The migration runner refuses a superuser or `BYPASSRLS` owner, and an app role that is
superuser, `BYPASSRLS`, owns tables, or is a member of another role.

Migrations are written expand/contract: the previous release keeps serving while an upgrade's
migration runs, and `helm rollback` runs older code against the newer schema (no down
migrations). A migration that waits more than 10 s for a lock fails the Job instead of stalling
live traffic. Rolling a bundled-CloudNativePG release back to its first revision re-runs that
revision's initial migration Job, which resets app-role grants to that build's matrix; the next
upgrade restores them.

### Upgrade notes

Migrations report what an upgrade changed in the migration Job's log (`"msg":"migration notice"`,
from `RAISE NOTICE`). The hook Job is deleted once it succeeds, so follow it during the upgrade
(`kubectl logs -f job/<release>-migrate`) or read it from your log aggregation afterwards.

- **One approval floor (migration `0024_approval_floor_unify`).** The minimum approval mode is
  install-wide only (spec D6), stored as `install_settings['policy.approval_floor']`. The older key
  `policy.approval_mode_floor` is folded into it (the stricter value wins), and team floors
  (`teams.settings.approval_mode_floor`) are removed. Each team whose floor was stricter than
  `auto` is named in a notice (`kobe: dropped team approval floor <mode> of team <id>`): such a
  team is looser after the upgrade. Restore its strictness with team ask rules (an `ask` rule on
  `*` asks for every tool, like `ask-all`).
- **Approval key (KOBE-37).** Tool-call approvals are signed with `KOBE_APPROVAL_KEY`, which the
  chart generates as `approval-hmac` in the sandbox session-keys Secret. If you pre-create that
  Secret (`sandbox.sessionKeysSecret`), add an `approval-hmac` key (at least 32 random characters).
  Without it the server starts, logs `KOBE_APPROVAL_KEY is not set`, and denies every tool call
  that needs approval. See [approvals](approvals.md).

- **Model gateway (KOBE-40).** Sandboxes now reach models through the new `model-gateway` shim
  (image `kobe-model-gateway`), and `sandbox.modelGatewayAccess` defaults to `true`. Bifrost moves
  to v2.2.5 (pinned by digest), gets a 1 Gi PVC by default (`bifrost.persistence.enabled`), a
  `Recreate` strategy, a config file and its admin password; only the shim and the server may reach
  it. Existing Bifrost state is replaced by Kobe's on the first sync. Sandboxes pick up the shim's
  address when their pods are next created (hibernate/wake or restart).

- **Retention indexes (KOBE-18, migration `*_retention_rls`).** Two indexes are added with a
  plain `CREATE INDEX` (migrations run in one transaction), which blocks writes to `threads` and
  `thread_entries` while it scans them. On a large install, build them first, outside the upgrade,
  then upgrade (the migration skips existing indexes):

  ```sql
  CREATE INDEX CONCURRENTLY IF NOT EXISTS threads_retention_idx
    ON threads (team_id, last_activity_at) WHERE deleted_at IS NULL;
  CREATE INDEX CONCURRENTLY IF NOT EXISTS thread_entries_blob_ref_idx
    ON thread_entries (team_id, blob_ref) WHERE blob_ref IS NOT NULL;
  ```

  A `CONCURRENTLY` build that fails or is cancelled leaves an **INVALID** index behind, and
  `IF NOT EXISTS` would then skip it, leaving the upgrade without a usable index. Before upgrading,
  check and drop any such leftover (then build it again, or let the migration build it):

  ```sql
  SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
   WHERE NOT i.indisvalid
     AND c.relname IN ('threads_retention_idx', 'thread_entries_blob_ref_idx');
  DROP INDEX CONCURRENTLY IF EXISTS threads_retention_idx;        -- only if listed above
  DROP INDEX CONCURRENTLY IF EXISTS thread_entries_blob_ref_idx;  -- only if listed above
  ```

- **Retention job (KOBE-18).** One server replica at a time runs the nightly retention pass under
  a session-level advisory lock, so the server needs a direct (or session-mode pooled) Postgres
  connection; transaction-mode poolers break session locks. `KOBE_RETENTION_HOUR_UTC` (0-23,
  default 3) sets the hour.

## Backup and restore

`kobe backup` / `kobe restore` cover Postgres and an S3 object manifest; see
[backup-restore.md](backup-restore.md). Keep copies of the Secrets you create above (and the
generated `<release>-auth` and `<release>-envelope-key` Secrets) in your secret store: backups never
contain them. Losing the envelope key makes every stored credential unreadable.

## Local development cluster

`scripts/dev-cluster.sh` creates a k3d cluster with gVisor and the agent-sandbox controller
(it works against a local or remote Docker engine, e.g. `DOCKER_HOST=ssh://user@host`).
