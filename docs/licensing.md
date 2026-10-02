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
- **Base images** (`node`, `python` official images) and third-party service images (Bifrost:
  Apache-2.0; CloudNativePG: Apache-2.0; ClamAV, optional and off by default: GPL-2.0, run as a
  separate service).
