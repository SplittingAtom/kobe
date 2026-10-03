# Development

There is no `docker compose`: development runs on k3s, locally via k3d, with Tilt.

## Dev loop

Prerequisites: Docker (local, or remote via `DOCKER_HOST=ssh://user@host`), k3d, kubectl, Helm 3,
Tilt, Node 24 and pnpm 12.

```bash
scripts/dev-cluster.sh   # k3d cluster "kobe": gVisor, agent-sandbox, local registry on :5005
tilt up                  # builds web/server/mcp-proxy/egress-proxy, deploys the chart + a dev Postgres
```

Tilt rebuilds an image when its sources change and redeploys it; the web app is port-forwarded to
http://localhost:3000. `tilt ci` does the same non-interactively and exits once every workload is
healthy (or fails). `tilt down` removes the deployment; `k3d cluster delete kobe` removes the
cluster.

The dev deployment uses `dev/values.yaml` and `dev/postgres.yaml`: a throwaway Postgres with the
production role split (`kobe_owner` migrates, `kobe_app` is the app login) and placeholder S3
settings.

### Against a real k3s cluster

Tilt refuses any context other than `k3d-*` unless it is named explicitly, and the throwaway dev
Postgres (public credentials) is only deployed to k3d. Bring your own values for a real cluster:

```bash
KOBE_DEV_CONTEXT=<kube-context> KOBE_DEV_REGISTRY=<registry the cluster can pull from> \
  KOBE_DEV_VALUES=<values.yaml> tilt up
```

The dev release lives in namespace `kobe-dev` (or `kobe-dev-<suffix>` via `KOBE_DEV_NAMESPACE`, with `KOBE_DEV_WEB_PORT` for the port-forward; see [parallel-work.md](parallel-work.md)), never `kobe`.

The cluster must already meet the prerequisites in [install.md](install.md#isolation).

### Linux Docker hosts

k3s nodes use many inotify instances. If `scripts/dev-cluster.sh` warns about
`fs.inotify.max_user_instances`, raise it on the Docker host:
`sudo sysctl -w fs.inotify.max_user_instances=512`.

## Tests

```bash
pnpm test                                   # unit + chart render tests (needs helm on PATH)
KOBE_TEST_DATABASE_URL=postgres://... pnpm test:db   # migrations, RLS catalog, cross-team probe,
                                            # backup/restore round trip (needs pg_dump/psql 17.6+ on
                                            # PATH, e.g. brew install libpq; turbo strips
                                            # other env vars, so use PATH, not KOBE_PG_BIN_DIR)
images/sandbox/test-image.sh <image>        # sandbox image acceptance checks
KOBE_IMAGE_TAG=<tag> e2e/run.sh             # k3d end-to-end suite (cluster from dev-cluster.sh)
```

## CI

| Workflow        | When                                | What                                                                                                  |
| --------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ci`            | every push, merge queue             | format, build, typecheck, lint, unit + chart tests, license check, DB/RLS suite, image non-root check |
| `sandbox-image` | sandbox inputs change, nightly      | build, acceptance checks, license audit, Trivy (fails on fixable CRITICAL)                            |
| `e2e`           | PRs to `main`, merge queue, nightly | k3d + gVisor cluster, chart install from fresh images, `e2e/run.sh`                                   |
| `publish`       | push to `main`                      | images (`sha-<short>`; `main` moved last) and the chart (`<version>-main.<run>.<attempt>`) to ghcr    |

CI runs on GitHub-hosted runners (free for public repositories). Deploy `sha-*` image tags or
published chart versions, never `:main` (pods with `IfNotPresent` would keep a stale `:main`).

### Merging

`main` uses GitHub's merge queue: approve-and-queue a green PR with `gh pr merge <n> --merge` (or
the "Merge when ready" button). The queue tests the PR on top of everything queued ahead of it
(`merge_group` runs of `ci` and `e2e`) and merges in order, so a merge no longer forces every other
open PR to re-run. Required checks: `checks`, `db`, `images`, `k3d`.

### Self-hosted runners (fallback)

Self-hosted runners on a k3s cluster (Actions Runner Controller) are documented in
[`ci/runners/README.md`](../ci/runners/README.md). They are idle by default; set the repository
variable `KOBE_RUNNER=kobe-k3s` to route jobs to them.
