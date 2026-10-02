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
  outbound only to the Kobe server, Bifrost, the MCP proxy and the egress proxy. Sandboxes get no
  DNS: those four resolve through `/etc/hosts` (`*.kobe.internal` → the Services' ClusterIPs), so
  DNS cannot be used to leak data past the egress proxy;
- a **ResourceQuota** (`sandbox.teamQuota`, default 20 vCPU / 40 GiB requested) and a LimitRange;
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

Private registries: the names in `global.imagePullSecrets` are copied into each team namespace for
the kubelet (pods there cannot mount them). Alternatively configure registry credentials on the
nodes (k3s `registries.yaml`). Kobe assumes one install per cluster (`kobe-team-*` names are
cluster-wide).

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

helm install kobe charts/kobe -n kobe \
  --set global.imagePullSecrets[0].name=ghcr-pull \
  --set ingress.host=kobe.example.com \
  --set ingress.tls.clusterIssuer=letsencrypt \
  --set postgres.external.existingSecret=kobe-db \
  --set s3.endpoint=https://s3.example.com --set s3.bucket=kobe --set s3.existingSecret=kobe-s3
```

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

## Local development cluster

`scripts/dev-cluster.sh` creates a k3d cluster with gVisor and the agent-sandbox controller
(it works against a local or remote Docker engine, e.g. `DOCKER_HOST=ssh://user@host`).
