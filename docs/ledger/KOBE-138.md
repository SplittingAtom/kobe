# KOBE-138: build service images once per change

- **Status:** in review
- **Branch / worktree:** `kobe-138-ci-build-images-once` in `../Kobe-wt138`

## Change

- ci.yml `images` job removed (it rebuilt five images only to assert non-root).
- e2e.yml: the build matrix job is now `image` (checks "image (web)" etc., unchanged); after each
  build (not sandbox, which keeps `images/sandbox/test-image.sh`) it loads the archive and runs
  `scripts/assert-image-nonroot.sh` (Config.User non-root numeric, `id -u` != 0).
- e2e.yml: new aggregate job `images` (the required check name), `needs: [changes, image]`,
  `!cancelled()` and not draft, passes on docs-only changes; same shape as `k3d`.
- `scripts/check-images.sh` (`pnpm images:check`) still builds locally and uses the same script.

## CI minutes per push

Sum of job durations. Before: main push ci run 37673546054 (db 510 s, checks 208 s, images 163 s,
orbit-loader 36 s = 917 s) plus e2e merge_group run 37671424766 (images 191 s, shards 2126 s,
changes/k3d 6 s = 2323 s) = 3240 s = 54.0 min.

After (PR #114: ci push run 37916845229 + e2e pull_request run 37916851802): 3501 s = 58.4 min. The ci
`images` job (163 s) is gone and the aggregate `images` costs 3 s, but this run was not faster overall:
the image matrix took 61-122 s per image (cold PR cache; 26-47 s in the merge-queue baseline) and `db`
ran 525 s (first attempt failed on an unrelated retention.db.test.ts flake and was rerun). Like for like:
ci -163 s per push; e2e adds `docker load` plus the assertion (a few seconds per image).

## Decisions

- Added `docker load` (a few seconds per image) rather than building again: one build per image.
