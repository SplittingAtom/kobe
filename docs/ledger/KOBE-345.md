# KOBE-345: D3: Export: portable skill zip and catalog package

- **Status:** in progress (group branch `group-40-skills-phase-d`, not pushed)
- **Branch / worktree:** `group-40-skills-phase-d` in `../Kobe-wt343`
- **Depends on:** KOBE-342; reuses KOBE-343's package layout and KOBE-344's import

## Decisions

- **No migration.**
- **Formats:** `portable` = the runtime payload (SKILL.md and its files), `portable_evals` = the
  payload plus `evals/`; never `kobe.skill.yaml` or `provenance.json` (the spec's "portable
  SKILL.md zip"). `package` = the full package plus Kobe's `provenance.json` (canonical JSON,
  origin and `modified` included): the mirror's `skills/<name>/` contents. Every zip holds one
  `<name>/` folder, so it unpacks into `.agents/skills/` or a Pi `--skill` dir as is; Kobe's
  upload and import strip that folder.
- **Deterministic bytes:** the canonical zip layout (fixed order, fixed DOS time, stored) via the
  protocol's new `deterministicZip` (the canonical zip without the package-path assertion, since
  an export has a folder and provenance.json). The SHA-256 is sent as `X-Kobe-SHA256`, ready to
  pin on import. A single-version export has no `catalog.json` (it would break the one-folder
  layout); the mirror keeps the catalog index.
- **Who:** team and personal versions: whoever sees the skill (team members; the author for a
  personal one), `GET /v1/skills/:id/versions/:n/export`. A team version only once its team
  review approved it (conservative: pending, flagged-unreviewed or rejected versions don't
  leave). Catalog versions: portable for members of a team that hasn't blocked the skill
  (`/v1/skills/catalog/:skillId/versions/:semver/export`); the full package (and portable) for
  Site catalog managers only (`/v1/site/skills/registry/versions/:id/export`). The spec says
  "any catalog version as its full package" without naming who; the package carries reviewer
  provenance (ids), so it stays with catalog managers (coordinator's instruction).
- **Excluded:** blocklisted versions (runtime or package hash, hash groups); catalog versions not
  Approved/Deprecated or suspended. A catalog package is checked against both recorded hashes
  before it leaves.
- **Caps:** packages are already bounded at upload (5 MiB, 200 files); an export refuses more than
  the uncompressed upload cap.
- **Round trip:** the portable zip imports through D2 (zip URL + its SHA-256) into a draft with
  the same files; a `package` export does not, because the spec has imports refuse an authored
  `provenance.json` (Kobe never trusts one).
- **Audit:** `skill.exported` (team versions in the team view; personal and catalog site-only)
  with the format and the export's SHA-256. No names or emails in any export (provenance holds
  ids only).
- **Web:** Download / Download with evals on the Team and Mine skill lists (latest version).

## Review fixes (Opus review of KOBE-345)

- **Archived / deprecated:** a version of an archived catalog skill is refused (404, as the
  browse hides it). Deprecated versions stay exportable: SK31 keeps them working for existing
  installs (only new installs are blocked), and an export installs nothing.
- **Rate limits:** 30 exports a minute per member across the team, personal and catalog portable
  routes (`skill-export:<user>`); the catalog package 10 a minute per manager
  (`skill-export-package:<user>`).
- **Declared sizes first:** an export reads the stored zip's central directory and refuses any
  entry over the per-file limit, or a declared total over the upload cap, before inflating.

## Open questions (for Chris or the coordinator)

- Pi itself isn't run in tests (ac-1 checks the `<name>/SKILL.md` layout in `.agents/skills`).
- No Site console button for the catalog package yet (API only); per-version (not only latest)
  download menus are a follow-up.

## Evidence

- `services/server/src/skill-export.db.test.ts`: portable/evals contents, determinism, layout,
  scope (outsider 404, package 400), audit; blocklist 422; import round trip; catalog package
  hashes back to the recorded hashes with provenance origin, member portable, team block and
  suspension refused (ac-1..ac-3).
- Web: `apps/web/components/skills/starts.test.tsx` download buttons.
