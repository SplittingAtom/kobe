# Self-hosted CI runners on the k3s cluster

GitHub-hosted minutes for this private repo are metered and run out quickly with several agents
pushing in parallel, so CI runs on our own k3s cluster with
[Actions Runner Controller](https://github.com/actions/actions-runner-controller) (Apache-2.0).

Every workflow job uses
`runs-on: ${{ (github.event.pull_request.head.repo.fork && 'ubuntu-latest') || vars.KOBE_RUNNER || 'ubuntu-latest' }}`.
With the repository variable `KOBE_RUNNER=kobe-k3s`, jobs run here; delete the variable to fall
back to GitHub-hosted runners without a code change. **Pull requests from forks always run on
GitHub-hosted runners**, never on this cluster: the repository is public, and these runners are
privileged. The repository also requires approval before workflows from outside contributors run.

## Layout

| Piece                                                           | Where                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------- |
| ARC controller (chart `gha-runner-scale-set-controller` 0.15.0) | namespace `arc-systems`, release `arc`                                  |
| Runner scale set `kobe-k3s` ([values.yaml](values.yaml))        | namespace `kobe-ci-runners`, release `kobe-k3s`                         |
| GitHub App credentials                                          | Secret `kobe-arc-github-app` in `kobe-ci-runners`                       |
| Scratch volumes                                                 | StorageClass `longhorn-ci-scratch` (1 replica, deleted with the runner) |

Runners are ephemeral (one job each), scale 0–6, and run Docker-in-Docker so jobs can build images,
use service containers (the `db` job's Postgres) and create the k3d cluster for e2e. Docker's data
(60 Gi) and the job workspace (20 Gi) live on per-runner Longhorn volumes: the nodes' root disks
have only ~10 GB free and must not fill up.

## Node prerequisites

k3s-in-Docker (e2e) needs more inotify instances than Ubuntu's default 128. Set on every node:

```bash
printf "fs.inotify.max_user_instances=1024\nfs.inotify.max_user_watches=524288\n" \
  | sudo tee /etc/sysctl.d/90-kobe-ci-inotify.conf && sudo sysctl -p /etc/sysctl.d/90-kobe-ci-inotify.conf
```

Node clocks must be NTP-synchronised: GitHub rejects the App's JWTs when a node runs ahead. The
nodes' configured LAN time server does not answer, so a fallback is set on every node in
`/etc/systemd/timesyncd.conf.d/90-fallback.conf` (`NTP=<LAN server> ntp.ubuntu.com`,
`FallbackNTP=0.ubuntu.pool.ntp.org 1.ubuntu.pool.ntp.org`).

## Install

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml   # on a control-plane node, with sudo -E
kubectl apply -f namespace.yaml -f storageclass.yaml
helm upgrade --install arc -n arc-systems --create-namespace --version 0.15.0 \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller
kubectl -n kobe-ci-runners create secret generic kobe-arc-github-app \
  --from-literal=github_app_id=<APP_ID> \
  --from-literal=github_app_installation_id=<INSTALLATION_ID> \
  --from-file=github_app_private_key=<key.pem>
helm upgrade --install kobe-k3s -n kobe-ci-runners --version 0.15.0 -f values.yaml \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set
gh variable set KOBE_RUNNER --body kobe-k3s --repo SplittingAtom/kobe
```

The GitHub App (`kobe-arc-runners`, owned by SplittingAtom) is installed on this repository only,
with repository permission **Administration: read and write** (needed to register repo-level
runners) and nothing else. Rotate its private key by generating a new one in the App settings and
replacing the Secret.

## Security

Runner pods execute repository code with a **privileged** Docker daemon, which is root-equivalent
on the node they land on. That is acceptable only because only the owner and agents working
for them can push branches here; fork pull requests are routed to GitHub-hosted runners by the
`runs-on` expression above. Never remove that guard or use `pull_request_target` with these runners. Runners are ephemeral, so nothing persists between jobs except
the node's image cache.

## Operations

- Watch: `kubectl -n kobe-ci-runners get pods,ephemeralrunners`; controller logs in `arc-systems`.
- Capacity: `maxRunners: 6`, each requesting 2 CPU / 5 Gi and allowed up to 12 CPU / 18 Gi.
- Upgrade: bump `--version` for both charts together (controller first).
