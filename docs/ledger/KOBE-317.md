# KOBE-317: A11: Built-ins become Kobe-published Default catalog skills

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch, Skills v1.2 Phase A)
- **Branch / worktree:** `group-skills-a` in `../Kobe-skA`
- **Depends on:** KOBE-310, 312, 314, 315 (same branch)

## Plan

Two migrations (0137 generated, 0138 custom), then the package set, the seed, the resolver and
materialization changes, removal of the image path, the image and e2e checks, and tests.

## Decisions

- **Departure (migrations):** the brief says no migration; the coordinator's "requester NULL plus
  a marker, CHECKed" needs one. Each alone in its own commit, no backfill (new columns have
  constant defaults; every existing row satisfies the new checks; the upgrade test migrates a
  site with catalog rows as the non-superuser owner).
  - **0137 (generated):** `registry_versions.publisher` (`kobe` = `submitted_by IS NULL`, and then
    no reviewer, claim or self-approval, and the runtime zip stored: `registry_versions_kobe_publisher`),
    a composite FK `(skill_id, publisher)` to `registry_skills (id, publisher)` (so nobody submits
    a version of a Kobe skill, and Kobe never publishes a maintainer's), the bytes
    (`runtime_storage_key`, `runtime_size_bytes`, `package_storage_key`, `registry_versions_storage`),
    and `registry_versions_approval` accepts Kobe's own publication instead of a reviewer.
    `registry_skills_kobe_names`: the seven names are publisher `kobe` only (SK24). On
    `registry_skill_tags.added_by`, `skill_default_syncs.requested_by` and
    `team_skill_installs.installed_by`: nullable, plus `by_kobe` with `by_kobe = (x IS NULL)`. No
    fake system user. The UNIQUE was moved above the FK by hand (drizzle-kit order).
  - **0138 (custom):** `registry_versions_immutable` also freezes `publisher` and recorded storage
    keys (a missing key may be set once, for KOBE-333); `registry_versions_review_guard` treats a
    NULL submitter as no self-review (it raised "a second reviewer" before the CHECK could speak).
  - Storage key columns are in `BLOB_REF_COLUMNS` (`site: true`); `team_skill_installs_by_kobe` is
    listed in `site-rename-migration.db.test.ts` (install-the-noun objects).
- **Package set:** `images/sandbox/skills/*` moved to `services/server/builtin-skills/<name>/`
  (files byte for byte) plus a `kobe.skill.yaml` each (`version: 1.0.0`, summary, Apache-2.0).
  The runtime zip leaves the manifest out, so sandboxes get exactly the old directory's files.
  `kobe-packages.ts` reads them through the upload's own checks; `kobe-packages.test.ts` pins
  each version's runtime and package hash (raise the version to change a skill).
- **Departure (seed job):** the brief says a Helm seed job from a chart-bundled set. The set
  ships in the server image and `seedKobeSkills` runs at every server start (like the gallery
  seed, KOBE-87), so install and every upgrade alike; a hook Job would need the same DB and S3
  credentials and code. Idempotent; failures logged, never fatal. Without object storage (no
  `s3.*`, dev only) it is skipped with a warning.
  - Bytes first, content-addressed (`<prefix>skills/catalog/<sha256>`), verified and re-written
    when missing at every start; then one transaction per skill under the exclusive Default-set
    lock: the skill (publisher `kobe`), the version (approved, no person, provenance
    `publisher: "kobe"`, scan stored), audit `skill.kobe.published` (system actor, docs/audit-log.md).
  - Versions only rise: held bytes = unchanged; new bytes under a held semver
    (`version_reused`) or below the newest (`version_not_newer`, an older release starting late)
    are refused and logged; a package scanning Block is never published.
  - **Default once:** a new Kobe skill is tagged Default (`by_kobe`) and an `add` sync queued
    (`requested_by` NULL), so the 314 rules apply (opt-outs, blocks, name conflicts, touched).
    Later starts never re-tag (a Site admin's removal sticks). A new version in the Default's
    major queues another `add` (fills teams only); a new major waits for "Move Default" (SK6).
  - Kobe's jobs send no Team admin notices: the skills were already there as built-ins.
- **No interruption on upgrade:** until the sync reaches a team (or where it skipped a name
  conflict), an agent naming a Kobe skill gets it as its Default install will be (On by default,
  Track within major), unless the team opted out or blocked it (`catalog-facts.ts`
  `pendingKobeDefaults`). A Kobe name always resolves through the catalog, never to a team skill of
  that name (it was reserved before too). Named catalog skills now keep the agent's order.
- **Image path removed:** `run.start.config.builtin_skills`, the `builtin_skills` capability,
  `KOBE_BUILTIN_SKILLS_DIR`, `sandbox-agent/skills/builtin.ts`, `/opt/kobe/skills` and the
  resolver's `builtinSkills` are gone. `KOBE_SKILL_NAMES` / `isKobeSkillName` replace
  `BUILTIN_SKILL_NAMES` (protocol `skill-catalog.ts`; `@kobe/db` mirrors it, a test ties them).
  Delivery keeps one legacy guard: a `run.start` queued before the upgrade that still lists
  `builtin_skills` fails visibly on an agent without the old capability.
  Run records keep `source: "builtin"` for old runs (readers unchanged).
- **Intended changes (spec SK4/SK6):** the seven now load in every non-exclusive run (On by
  default), count against the 64 cap, are blocklistable by hash, and shadow a personal skill of
  the same name (`shadowed`). Installs list `installedBy: null` for Kobe's (protocol, web type).
- **Materialization:** `sizesByHash` and `locateBundle` read catalog versions with stored bytes,
  so the 315 `unavailable` notice no longer applies to Kobe skills (maintainer versions keep it
  until KOBE-333 stores their packages).
- **Image and e2e:** `test-image.sh` checks the image bakes no skills and runs every sample script
  from the package set streamed in as a tar (read-only, `--network none`). `e2e/run.sh` points the
  gallery agent's commands at `/run/kobe-skills/store/sk-<runtime hash>` and checks the seven are
  approved Kobe skills.

## For KOBE-422 (startup seeds, not merged yet)

The seed writes at every start, so `STARTUP_SEEDED_ROWS` needs, at merge: `registry_skills`
(`publisher = 'kobe'`), `registry_versions` (`publisher = 'kobe'`), `registry_skill_tags`
(`by_kobe`), `skill_default_syncs` (`by_kobe`), `team_skill_installs` (`by_kobe`, only once teams
exist), and `audit_log` rows `skill.kobe.published`, `skill.default.synced` and
`skill.default.applied` with the system actor. Objects: `<prefix>skills/catalog/*` in the bucket.

## Open questions (for Chris or the coordinator)

- Gate 1 cold start: a fresh sandbox's first run now fetches up to seven small bundles (~60 KB
  together, serially). Not measurable locally; KOBE-319 (Gate A) should read the k3d cold-start
  trial.
- `e2e/run.sh` changes were syntax-checked only (no local k3d); the gallery runs prove them in CI.

## Follow-ups

- KOBE-333: rescans of catalog versions (Kobe's now have bytes) and maintainer package storage.
- A Kobe skill dropped from a later package set is left as is (no retire step yet).

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/kobe-skills.db.test.ts` "the seed" (seven approved, no person,
  Default, bytes stored, audited, jobs by Kobe; restart unchanged; missing object re-written) and
  "the Default sync installs them" (every team incl. one created later; opt-out and name conflict
  kept; no notices; `installedBy: null`). `packages/db/src/kobe-published-skills.db.test.ts`
  (upgrade with rows as owner, every CHECK, FK, immutability).
- ac-2: same db test: run.start lists Kobe bundles, never `builtin_skills`; the sandbox route
  serves them byte for byte; `services/sandbox-agent/src/agent.skills.test.ts` "former built-in
  skills"; `images/sandbox/Dockerfile` has no skills; `kobe-packages.test.ts`.
- ac-3: same db test "runs after the upgrade" and the pre-sync run; `resolver/parity.test.ts`
  (D5); `gallery/definitions.test.ts`; e2e gallery checks updated (CI).
- Suites: `@kobe/server` test:db 130 files / 1730 tests; `@kobe/db` test:db 57 files (all green
  after the rename-test entry); server, db, protocol, sandbox-agent unit suites; repo typecheck,
  lint and format:check. The new image checks ran green against `kobe-sandbox:local-0d91bac618ab`
  on the Docker host. `@kobe/cli` test:db's backup tests fail locally only for lack of pg_dump.
