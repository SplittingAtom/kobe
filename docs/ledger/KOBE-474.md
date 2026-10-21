# KOBE-474: Sandbox image: Pillow 12.3.0 → 13.0.0 (CRITICAL CVE-2026-112403)

- **Status:** in review (group branch `group-24-pillow-cve`)
- **Branch / worktree:** `group-24-pillow-cve` in `../Kobe-wt474`

## Decisions

- Lock regenerated the way it was made: `pip-compile --generate-hashes --no-header --unsafe-package debugpy
--upgrade-package pillow` (pip-tools 7.6.2) inside the image's pinned `python:3.12-slim-trixie` base, so
  only pillow changed. The trailing "# WARNING ... debugpy" note pip-compile appends was dropped, as before
  (install uses `--no-deps`).
- Compatibility: matplotlib 3.11.2 requires `pillow>=9`, reportlab 5.0.1 has no upper bound, pandas has no
  pillow dependency.
- Fixable HIGH items, all trivial, also fixed: npm CLI 12.2.0 → 12.2.1 (brace-expansion 5.0.12, undici
  6.29.0; CVE-2026-102276/102278, CVE-2026-19534); Pi lockfile's nested brace-expansion 5.0.9 → 5.0.12
  (same `^5.0.8` range, same deps); `libpcre2-8-0` named in the apt install so it takes the trixie
  security fix (10.46-1~deb13u3, CVE-2026-103111).
- License exceptions for pillow and npm: versions bumped (license unchanged, same packages).

## Evidence

- Image built on the remote Docker host: `test-image.sh` 77 ok, exit 0.
- Trivy 0.70.0 `--severity CRITICAL --ignore-unfixed --exit-code 1`: exit 0; HIGH,CRITICAL fixable: none
  (before: pillow CRITICAL, plus HIGH pcre2, brace-expansion x2, undici).
- Licence report refreshed (`collect-licenses.sh` + `image-report sandbox` + `licenses:update`);
  `license:check` and `format:check` pass.
