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
  the MCP proxy and the egress proxy — and to Bifrost only with `sandbox.modelGatewayAccess: true`
  (off until Bifrost verifies sandbox session tokens). Sandboxes get no DNS: Kobe's services
  resolve through `/etc/hosts` (`*.kobe.internal` → the Services' ClusterIPs), so DNS cannot be
  used to leak data past the egress proxy;
- a **ResourceQuota** (`sandbox.teamQuota`: requests and limits for CPU, memory and ephemeral
  storage, pods, PVCs and requested storage) and a LimitRange with per-container defaults;
- a `SandboxTemplate` and a **warm pool** of `sandbox.warmPool.replicasPerTeam` pre-started
  sandboxes (agent-sandbox warm pools are per namespace; each counts against the team's quota);
- Pod Security Admission `restricted`.

The chart installs **ValidatingAdmissionPolicies** that hold whatever creates the pod (server,
agent-sandbox controller, an operator): in `kobe-team-*` namespaces every pod must use
`isolation.runtimeClassName` and that RuntimeClass must have a gVisor/Kata handler; pods may not
mount Secrets, read Secrets into env, mount a Kubernetes API token, use host namespaces or
`hostPath`; and only the Kobe server may add or change NetworkPolicies there. The server's own
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

Private registries: the names in `global.imagePullSecrets` are copied into each team namespace for
the kubelet (pods there cannot mount them). Alternatively configure registry credentials on the
nodes (k3s `registries.yaml`). Kobe assumes one install per cluster (`kobe-team-*` names are
cluster-wide).

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
(`egressProxy.allowedPorts`, default 443).

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

## Backup and restore

`kobe backup` / `kobe restore` cover Postgres and an S3 object manifest; see
[backup-restore.md](backup-restore.md). Keep copies of the Secrets you create above (and the
generated `<release>-auth` Secret) in your secret store: backups never contain them.

## Local development cluster

`scripts/dev-cluster.sh` creates a k3d cluster with gVisor and the agent-sandbox controller
(it works against a local or remote Docker engine, e.g. `DOCKER_HOST=ssh://user@host`).
