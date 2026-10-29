# KOBE-517: Bump Next.js 16.3.8 -> 16.4.3 (web image CRITICALs)

- **Status:** committed on group branch `group-hardening-1` (no PR of its own; supersedes Dependabot PR #172)
- **Depends on:** KOBE-512 (Trivy gate)

## Decisions

- `pnpm up next@16.4.3 --filter @kobe/web`, caret kept (`"next": "^16.4.3"`); `pnpm install --frozen-lockfile` passes.
- The lockfile still holds `next@16.3.8` as the resolved optional peer of `better-auth` in `services/server`
  (not a direct dependency there). Left for KOBE-514, which owns the server image's `next` path.

## Release notes 16.4.0 (2026-10-07) .. 16.4.3 (2026-10-23)

- **16.4.1** security: GHSA-673q-mjm6-r5xr (RCE, `use cache` returning typed arrays, CRITICAL),
  GHSA-2464-fhr4-w9xw (RCE, Image Optimization API with SVG, CRITICAL), GHSA-p3m5-59mp-jv5r (Server Actions DoS, HIGH).
  Kobe uses no `use cache` and sets `images.unoptimized: true`; fixed by the bump regardless.
- **proxy.ts** (CSP nonce): 16.4.0 fixes proxy.ts detection with compound `pageExtensions` (n/a, defaults) and intercepted-route
  params after Proxy rewrites (n/a, no rewrites); 16.4.3 stops loading the app-page runtime in proxy.ts (lighter, no API change).
  Nonce flow unchanged; build lists the proxy.
- **App Router layouts / generateMetadata:** 16.4.0 metadata rework (SelectedMetadata, per-parallel-route resolution,
  stable streaming, static metadata prerendering restored). No API change; layout tests pass.
- **Route handlers:** 16.4.0 excludes metadata files from route handler type validation; no change for Kobe (typecheck green).
- **Standalone output:** 16.4.3 avoids loading standalone React in server bootstrap; NFT symlink fixes (Turbopack).
  Standalone image builds and starts its bundle as before.
- **`images.unoptimized`:** image optimizer fixes (AVIF, disk cache, socket) n/a (unoptimized).
- **`transpilePackages`:** nothing in 16.4.x. `@kobe/protocol` still transpiled (build green).
- No breaking changes listed.

## Evidence

- ac-1: `pnpm --filter @kobe/web typecheck` 0, `lint` 0, `build` 0. `test`: 2780/2785 under a loaded host; the 5
  failures were waitFor timeouts (30 s+) in `scroll`, `steering-panel`, `rail-files` tests; rerun alone 54/54 pass.
  `pnpm license:check` 0 (THIRD_PARTY_LICENSES.md refreshed; NOTICE unchanged).
- ac-2: web image built from `apps/web/Dockerfile` on the remote Docker host, scanned with
  `aquasec/trivy:0.70.0 image --severity CRITICAL --ignore-unfixed --exit-code 1`: exit 0, 0 CRITICAL in every target
  (debian 12.15 + node-pkg, next 16.4.3). Tag removed afterwards.
- ac-3: this section.
