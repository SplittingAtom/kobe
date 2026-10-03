# Licensing

Kobe is Apache-2.0. Dependencies are limited to MIT/Apache/BSD/MPL-family licenses (spec D3);
anything else needs a documented, version-pinned exception that Chris signs off.

| Scope                                | Checked by                                                                   | Exceptions                                    |
| ------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------- |
| pnpm workspace (prod + dev)          | `pnpm license:check` (CI `checks`)                                           | `tools/license-check/license-exceptions.json` |
| Sandbox image: Python + npm packages | `images/sandbox/collect-licenses.sh` + the same checker (CI `sandbox-image`) | `images/sandbox/license-exceptions.json`      |

Not covered by the automated check, and why that is acceptable:

- **Debian packages in the sandbox image** (`git`, `curl`, `less`, `procps`, `zip`/`unzip`, …) are
  separate, unmodified programs that agents invoke; Kobe does not link against them. Several are
  GPL (git, procps, less); `zip`/`unzip` use the Info-ZIP license.
- **Native libraries inside Python wheels**: numpy and pyarrow wheels bundle runtime libraries such
  as `libgfortran` (GPL with the GCC Runtime Library Exception, which permits redistribution in
  non-GPL programs) and OpenBLAS (BSD-3-Clause).
- **Base images** (`node`, `python` official images) and third-party service images (CloudNativePG:
  Apache-2.0; ClamAV, optional and off by default: GPL-2.0, run as a separate service).
- **Bifrost** (`docker.io/maximhq/bifrost`, pinned by tag and digest in the chart and tracked by
  Dependabot through `images/bifrost/Dockerfile`): Apache-2.0. Checked at v2.2.5
  (`github.com/maximhq/bifrost`, tag `transports/v2.2.5`): the repository has a single `LICENSE`
  (Apache-2.0) at its root and no other license files; the code Kobe relies on — the HTTP transport
  (`transports/bifrost-http`), the admin API handlers, and the governance plugin
  (`plugins/governance`: customers, teams, virtual keys, budgets, rate limits) — is in that tree.
  Bifrost's enterprise features are separate (an enterprise build and license key; in the open
  code they show up as `is_enterprise` flags, user-level governance, clustering, SCIM and UI
  fallbacks), and Kobe uses none of them. Re-check on every Bifrost bump.
