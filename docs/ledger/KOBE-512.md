# KOBE-512 — publish scans every service image with Trivy

- `publish.yml` `images` matrix (web, server, mcp-proxy, egress-proxy, model-gateway, sandbox): a new
  "Build for the scan" step (`build-push-action`, `load: true`, `push: false`, no attestations, gha cache
  read) tags `kobe-<name>:scan`; then the sandbox workflow's two steps, same pinned
  `aquasecurity/trivy-action@ed142fd…` (v0.36.0): report (HIGH,CRITICAL, ignore-unfixed, table, exit 0) and
  gate (CRITICAL, ignore-unfixed, table, exit 1); then the existing push (rebuilds from the builder's layer
  cache, keeps provenance/SBOM). A fixable CRITICAL fails that image's job before anything reaches ghcr;
  `chart`/`promote-main` need `images`, so nothing else publishes either.
- The other Trivy workflows upload no SARIF and use no ignore file, so neither does this; permissions and
  concurrency unchanged. No waivers added; docs/development.md says how to add one (root `.trivyignore`,
  comment per CVE: id, image, reason, expiry; `trivyignores` input).
- Checks: YAML parses (`yaml` package); `actionlint` is not installed here, so not run; prettier clean;
  `scripts/check-public-hygiene.sh` ok. The workflow itself cannot run here.

## Local scan of main's images (local-87398452b50d, Trivy 0.70.0, --ignore-unfixed)

| image         | fixable CRITICAL | HIGH (fixable) |
| ------------- | ---------------- | -------------- |
| web           | 2                | 7              |
| server        | 5                | 68             |
| mcp-proxy     | 0                | 10             |
| egress-proxy  | 0                | 6              |
| model-gateway | 0                | 6              |
| sandbox       | 0                | 10             |

**ac-2 is not met yet: web and server would fail the new gate.** No base-image bump fixes either; both are
npm dependencies:

- web and server: `next` 16.3.8 — GHSA-2464-fhr4-w9xw (RCE, Image Optimization with SVG) and
  GHSA-673q-mjm6-r5xr (RCE, `use cache` typed arrays); fixed in 16.4.1. The server image carries `next`
  only because better-auth's optional peers (`next`, `drizzle-kit`) resolve from the workspace into the
  server's prod deploy.
- server only: esbuild Go binaries pulled by `better-auth` → `drizzle-kit` 0.31.11: esbuild 0.18.20 (via
  `@esbuild-kit/core-utils`, Go 1.20.7: CVE-2024-24790, CVE-2025-68121) and esbuild 0.25.12
  (Go 1.23.12: CVE-2025-68121). Fix: keep better-auth's optional peers out of the server image (or a
  drizzle-kit release without `@esbuild-kit`/old esbuild), not a base image.
- Follow-up (not filed, per instructions): bump `next` to 16.4.1 and drop next/drizzle-kit from the
  server deploy before this lands on main, or main's next publish fails at web and server.
