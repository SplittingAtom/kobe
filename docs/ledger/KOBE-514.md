# KOBE-514: Slim the server image (no Next.js, swc or test toolchain in kobe-server)

- **Status:** committed on group branch `group-hardening-1` (no PR of its own)
- **Depends on:** KOBE-512 (Trivy gate), KOBE-517 (next 16.4.3 in the web app)

## Sizes (images built from the repo root on the amd64 Docker host, `docker images`)

| Image              | Before (39c958f3) | After  | `pnpm deploy --prod --legacy` output before -> after |
| ------------------ | ----------------- | ------ | ---------------------------------------------------- |
| kobe-server        | 1.2 GB            | 580 MB | 691 MB -> 216 MB                                     |
| kobe-model-gateway | 478 MB            | 409 MB | 130 MB -> 68 MB                                      |
| kobe-egress-proxy  | 478 MB            | 409 MB | 130 MB -> 67 MB                                      |
| kobe-mcp-proxy     | 375 MB            | 375 MB | 39 MB -> 39 MB (no @kobe/db, nothing to remove)      |

The rest of each image is the `node:24-slim` base (~335 MB).

## Dependency paths

- `pnpm --filter @kobe/server why next --prod`: `next@16.3.8 <- better-auth@1.7.7 <- @kobe/server` (and via
  `@better-auth/passkey`). Same for `drizzle-kit` and `vitest` (which brought `vite`, `happy-dom`, rolldown,
  lightningcss and three esbuild binaries). All are **optional peers** of better-auth; pnpm links an optional
  peer whenever the workspace has it anywhere (next in apps/web, vitest at the root, drizzle-kit in packages/db),
  and `pnpm deploy --prod` copies linked peers. `autoInstallPeers: false`, `resolvePeersFromWorkspaceRoot: false`
  and `dedupePeerDependents: false` do not change that (tried). `--legacy` does not deploy workspace
  devDependencies: drizzle-kit came only through the peer.
- next was even the stale 16.3.8 (KOBE-517 bumped only the web app), the source of the server's next CRITICALs.
- model-gateway and egress-proxy had no stray packages; their weight was `@kobe/db`'s `drizzle/` folder
  (64 MB, of which ~60 MB are drizzle-kit `meta/*_snapshot.json` files).

## What changed

- `.pnpmfile.cjs` (`readPackage`): removes `next`, `drizzle-kit` and `vitest` from better-auth's peers. The
  server uses better-auth's core API and Drizzle adapter, the web app its React client (react/react-dom peers
  kept). Lockfile: better-auth resolves without them; next 16.3.8 left the lockfile. Every Dockerfile that runs
  `pnpm fetch` copies `.pnpmfile.cjs` with the lockfile; Tiltfile and the sandbox-image workflow paths list it.
- `packages/db` `files`: `!drizzle/meta/*_snapshot.json`. The migrator and `kobe-db-wait` read only
  `drizzle/*.sql` and `meta/_journal.json`; snapshots are drizzle-kit's generate-time diff base (repo only).
- THIRD_PARTY_LICENSES.md regenerated (10 next 16.3.8 rows gone).

## Evidence

- Deployed server node_modules: 0 entries matching next, @next, vitest, vite, happy-dom, drizzle-kit, esbuild.
- All four images: `User` 1000:1000; `node dist/index.js` loads the whole module graph and stops at config
  validation (no env). In the server image `drizzle-orm/migrator` reads all 183 migrations from the slim
  `@kobe/db`.
- Trivy 0.70.0 `--scanners vuln --severity CRITICAL --ignore-unfixed`: server after 0 (before: exit 1, Go stdlib
  CVE-2024-24790 / CVE-2025-68121 in the esbuild binaries); model-gateway, mcp-proxy, egress-proxy 0. (Without
  `--scanners vuln` Trivy's secret scanner flags the deliberate fake key in
  `builtin-skills/code-review/scripts/sample.py`; the CI gate scans vulns only.)
- `pnpm install --frozen-lockfile` ok; server tests 2420 passed; server db tests (81 files, incl. auth) 1162
  passed; model-gateway 190 passed; web build + 2785 tests passed; typecheck, lint, license:check,
  check-public-hygiene ok.
