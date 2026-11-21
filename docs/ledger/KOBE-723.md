# KOBE-723: One Dockerfile for the four identical Node service images (review CODE-38)

- **Status:** in review (group 62, branch `group-62-ci-build-images`)
- **Depends on:** none

## Decisions

- The four `services/{server,mcp-proxy,egress-proxy,model-gateway}/Dockerfile` differed only in the
  service name (header comment and the two `--filter=@kobe/<svc>` lines; same base, hardening,
  user, port 8080 and CMD). They are replaced by one `services/Dockerfile` with `ARG SERVICE`
  (one place for the base image digest, apt hardening and `USER 1000:1000`).
- `SERVICE` is checked against the four names inside the build, so a missing or wrong build arg
  fails with a clear message instead of building an empty image. It is declared after `COPY . .`,
  so the four builds share the `pnpm fetch` and source layers in the build cache.
- Named `services/Dockerfile` (not `Dockerfile.node-service`): Dependabot's docker ecosystem and
  the license inventory's Dockerfile scan pick it up without extra patterns.
- Consumers updated: `publish.yml` and `e2e.yml` matrices (`build-args: SERVICE=<svc>`; GHA cache
  scopes stay per image name), `scripts/check-images.sh`, `e2e/load-images.sh`, the `Tiltfile`,
  `.github/dependabot.yml` (`/services` instead of four directories) and `CLAUDE.md`.
- `tools/license-check/inventory.yaml` names no Dockerfile paths (its `deployables` map package
  directories), so it is unchanged; the regenerated inventory is identical.

## Docs

No `docs/guide/` change: members, admins and in-sandbox agents see nothing new. The guide and the
install docs name no Dockerfile paths (only `CLAUDE.md` did; updated).

## For the coordinator

- `~/.kobe-coord/deploy-gate1.sh` (outside the repo) still maps the four services to
  `services/<svc>/Dockerfile`: change it to `-f services/Dockerfile --build-arg SERVICE=<svc>`
  before the next gate1 deploy from a commit with this change.

## Evidence

- ac-1: one file; the old four are deleted (`git show --stat`).
- ac-2: `IMAGE_PREFIX=g62-test- IMAGE_TAG=check scripts/check-images.sh` (the script behind
  `pnpm images:check`) on the remote amd64 Docker host: web and all four services built from the
  new file, each `USER=1000:1000 uid=1000` and ships LICENSE, NOTICE and THIRD_PARTY_LICENSES.md;
  `docker run --rm --entrypoint node <img> -e "require('/app/package.json').name"` printed
  `@kobe/<svc>` for each. Test images removed afterwards. The publish workflow runs only on main,
  so its first run after merge is the remaining check.
