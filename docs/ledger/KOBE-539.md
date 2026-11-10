# KOBE-539: image CVEs fail publish's Trivy gate

Branch `kobe-539-image-cves` (from main 4436e1af). Scope: libbrotli1 CRITICAL plus the sandbox's
fixable HIGHs (coordinator, 2026-11-10); other images get the base-package upgrade.

## Changes

- `images/sandbox/Dockerfile`: runtime stage runs `apt-get upgrade` before the installs (apt 3.0.4,
  zlib1g +deb13u1, libbrotli1 +deb13u1); `NPM_VERSION` 12.2.1 -> 12.2.2 (bundles undici 6.29.1).
- `images/sandbox/requirements.in/.txt`: pypdf 6.19.0 -> 6.21.4 (6.21.2 still left 7 HIGHs fixed in
  6.21.3/6.21.4; no new dependencies, wheel hash only, as the lock had it).
- `images/sandbox/third-party-licenses.json` refreshed from the image (npm 12.2.2's bundled deps,
  pypdf); `license-exceptions.json` npm exception version 12.2.2 (same Artistic-2.0 approval);
  `THIRD_PARTY_LICENSES.md` regenerated. `pnpm license:check` passes.
- web, server, mcp-proxy, egress-proxy, model-gateway runtime stages: `apt-get upgrade`, and npm,
  npx and corepack removed (the apps run with `node` only; the bundled npm carried undici and
  brace-expansion HIGHs). web and egress-proxy were started to confirm node still runs.
- `images/orbit-eval/Dockerfile`: `apt-get upgrade` (not in publish; apt and zlib1g HIGHs).

## Trivy 0.70.0, HIGH+CRITICAL, --ignore-unfixed (before = local builds of 4436e1af)

| image         | before (C/H) | after (C/H) |
| ------------- | ------------ | ----------- |
| sandbox       | 0 / 17       | 0 / 0       |
| server        | 0 / 12       | 0 / 4       |
| web           | 0 / 8        | 0 / 0       |
| mcp-proxy     | 0 / 12       | 0 / 4       |
| egress-proxy  | 0 / 8        | 0 / 0       |
| model-gateway | 0 / 8        | 0 / 0       |
| orbit-eval    | 0 / 7        | 0 / 3       |

The local 4436e1af sandbox build already had libbrotli1 1.1.0-2+deb13u1 (curl pulls it in fresh);
the upgrade line covers it whatever the base carries.

`images/sandbox/test-image.sh kobe-sandbox:wt539`: passes (78 ok, no failures).

## Left open

- server and mcp-proxy: `undici` 8.11.2 (mcp-proxy's direct `^8.11.2` in pnpm-lock), 4 HIGHs fixed
  in 8.12.2. A lockfile bump plus mcp-proxy tests; not a CRITICAL, left for a follow-up.
- orbit-eval: fsspec 2025.9.0 and urllib3 2.7.0 (Orbit's pinned Python lock), 3 HIGHs; not in publish.
- Node base images still ship yarn (/opt/yarn-*); Trivy flags nothing there.
