# KOBE-597: dependency wave (fold the safe Dependabot bumps)

Branch `kobe-597-deps-wave`. One PR replaces the Dependabot PRs below.

## Applied

GitHub Actions (SHA pins and `# vX.Y.Z` comments kept):

- #457 pnpm/action-setup 6.1.0 -> 6.1.1 (ci, e2e, orbit-eval-image, sandbox-image, skill-scan-image)
- #414 docker/login-action 4.6.0 -> 4.7.0 (publish)
- #410 actions/setup-python 7.0.0 -> 7.1.0 (ci)

npm (lockfile resolved to the newest version in range, so a few land above the PR's version):

- #424 postcss ^8.5.29 -> ^8.5.32
- #423 @kubernetes/client-node ^2.0.0 -> ^2.0.1
- #422 @aws-sdk/lib-storage ^3.1147.0 -> ^3.1157.0, plus @aws-sdk/client-s3 ^3.1147.0 -> ^3.1157.0
  (lib-storage peers on client-s3 at its own version; Dependabot's lock left a peer warning)
- #421 react and react-dom ^19.3.0 -> ^19.3.1 (together)
- #418 typescript-eslint ^8.71.1 -> ^8.72.1
- #413 @better-auth/passkey 1.7.7 -> 1.7.14, with better-auth 1.7.7 -> 1.7.14 in apps/web and
  services/server (passkey 1.7.14 peers on better-auth ^1.7.14; Dependabot's PR left them apart)
- #411 lucide-react ^1.52.0 -> ^1.61.0
- #304 @types/busboy ^1.5.4 -> ^1.5.5
- #303 @types/node ^24.0.0 -> ^24.19.2 (root; e2e/browser stays pinned at 24.19.0)
- #301 radix-ui ^1.7.0 -> ^1.8.1
- #300 turbo ^2.11.7 -> ^2.11.8
- #298 @hono/node-server ^2.1.3 -> ^2.1.5
- #297 @testing-library/user-event ^14.6.7 -> ^14.6.8
- #296 eslint ^10.11.0 -> ^10.13.0
- #294 tldts ^7.4.16 -> ^7.4.18

Sandbox Python (`images/sandbox/requirements.in`, hashed `requirements.txt` regenerated with
`uv pip compile --generate-hashes --python-version 3.12 --unsafe-package debugpy -P pandas -P numpy -P reportlab`;
only these three entries changed, debugpy stays out of the lock, unlike the Dependabot PRs which added it):

- #417 pandas 3.0.6 -> 3.1.0
- #293 numpy 2.5.3 -> 2.5.4
- #412 reportlab 5.0.1 -> 5.1.0
- `images/sandbox/third-party-licenses.json`: versions updated (licences unchanged).

## Dropped

- #420 @opentelemetry/api ^1.10.0: the OpenTelemetry SDK packages (core, resources, sdk-trace-base,
  sdk-trace-node, sdk-logs, sdk-metrics 2.12.0 / 0.223.0) peer on `@opentelemetry/api <1.10.0`, so
  `pnpm peers check` fails. Keep ^1.9.0 until the SDK packages accept 1.10 (retry with the next OTel bump).

## Held (leave the PRs open)

- #458 Pi 1.5.0: the spec pins Pi 1.4.x; never bump without Chris.
- #416 @opentelemetry/exporter-trace-otlp-http 0.300: breaking, 18 checks fail.
- #419 happy-dom 21: major.
- #302 mermaid 12: major.
- #299 pyarrow 26: major.
- #456 bifrost v2.4.0: model gateway; needs a gate1 model check.
- #415 pypdf: goes with KOBE-539.

## Checks

- `pnpm install`, `pnpm peers check`: clean.
- `pnpm licenses:update` (THIRD_PARTY_LICENSES.md changed, NOTICE unchanged), `pnpm license:check`: pass.
- `pnpm build`, `pnpm lint`, `pnpm typecheck`: pass.
- Package tests, run one at a time: @kobe/web 374 files / 3378 tests, @kobe/server 212 files / 2550 tests,
  @kobe/mcp-proxy 139, @kobe/db 801, @kobe/telemetry 32: all pass.
- Sandbox image built on the remote amd64 Docker host; `images/sandbox/test-image.sh` passes (rc 0).
- Not done here: a fresh `collect-licenses.sh` comparison of the image report (the three versions were
  edited by hand in `third-party-licenses.json`; the sandbox-image CI job compares it with a fresh run);
  CI, merge queue and closing the Dependabot PRs belong to the coordinator.
