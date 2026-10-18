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

## Review fixes (review-317)

- **S1:** the legacy guard read the parsed frame, whose schema strips `builtin_skills`, so it
  never fired. It now reads the stored JSON (`row.frame.config.builtin_skills`) and fails such a
  run visibly on every agent (`skills_unsupported`, "queued before an upgrade… send it again"):
  no frame can carry the field any more, so even an old agent would start without them. Test:
  `kobe-skills.db.test.ts` "a run.start queued before the upgrade".
- **S2 (0137 edited in place, own commit `ae8d95ad`):** `registry_skills_kobe_names` is two-way,
  `(publisher = 'kobe') = (name IN the seven)`: Kobe rows are exactly the seven, and a Kobe skill
  can't be renamed. Residual: the app role (which the seed runs as) can still insert a new Kobe
  version of one of the seven; closing that needs a separate DB role (out of scope).
- **S3:** `startKobeSeed` (`kobe-seed.ts`): the first attempt is awaited at start; while any
  package `failed`, it retries with backoff (30 s doubling to 30 min) until one attempt gets
  through; refusals are final. Stopped at shutdown. Test: `kobe-seed.test.ts`.
- **S4:** no new team or personal skill may take one of the seven names (409 `reserved_name` at
  upload, the only create and rename path: a skill's name is its SKILL.md name). Existing ones
  made before the upgrade keep their name and new versions. Precedence: an agent naming `pdf`
  gets Kobe's, except where the team made its own `pdf` Required (a Team admin's deliberate
  choice): that one loads and the named one is omitted as `shadowed` (`resolve.ts`, for any
  named skill whose name a Required skill of another source holds). The Default sync still skips
  such teams (name conflict), so their own On by default `pdf` keeps loading for unnamed runs.
  Tests: `resolve.test.ts`, `kobe-skills.db.test.ts` "reserved names in teams".
- **S5:** `kobe-packages.test.ts` pins every published version by name and semver, append only
  ("never edit or remove a line"); the shipped version must be the newest line, with that line's
  bytes, so a version's bytes can't change without a visible edit of a published line.
- **N3:** the seed's skill lookup also filters `publisher = 'kobe'`.

## For the KOBE-422 merge (G5 branch, PR #314; can't be done here)

KOBE-422 adds `packages/db/src/startup-seeds.ts` (`STARTUP_SEEDED_ROWS`) and moves start-up work
into `services/server/src/startup/jobs.ts`, with the guard test `startup-seeds.db.test.ts`. The
merge must:

1. Add to `STARTUP_SEEDED_ROWS`:
   - `registry_skills`: `publisher = 'kobe'`;
   - `registry_versions`: `publisher = 'kobe'`;
   - `registry_skill_tags`: `by_kobe`;
   - `skill_default_syncs`: `by_kobe`;
   - `team_skill_installs`: `by_kobe` (none on a fresh site: no teams; an RLS table, so the
     restore check reads it under `withTeam` if it reads it at all);
   - `audit_log`: `actor_kind = 'system' AND actor_id IS NULL AND team_id IS NULL AND action =
'skill.kobe.published'`, and the sync events limited to Kobe skills: `actor_kind = 'system'
AND action IN ('skill.default.synced', 'skill.default.sync_failed', 'skill.default.applied')
AND target ->> 'skillId' IN (SELECT id::text FROM public.registry_skills WHERE publisher =
'kobe')` (Site admins' Default jobs write the same system-actor events for their skills;
     those are real data).
   - Bucket objects: `<prefix>skills/catalog/*`.
2. Move the 317 seed from `index.ts` into `startup/jobs.ts` as `startKobeSeed`, awaited before
   `startDefaultSync` starts, stopped with the other jobs.
3. Give the guard test a BlobStore (e.g. `MemoryObjects`), or the seed is skipped and the guard
   sees no 317 rows.

## Open questions (for Chris or the coordinator)

- Rolling upgrade (review N1): finish the server rollout before the team reconcile moves
  SandboxTemplates to the new image; an old server's run on a new-image sandbox fails visibly
  ("agent too old"). The other way round works.
- Gate 1 cold start: a fresh sandbox's first run now fetches up to seven small bundles (~60 KB
  together, serially). Not measurable locally; KOBE-319 (Gate A) should read the k3d cold-start
  trial.
- `e2e/run.sh` changes were syntax-checked only (no local k3d); the gallery runs prove them in CI.

## Follow-ups

- KOBE-333: rescans of catalog versions (Kobe's now have bytes) and maintainer package storage.
- A Kobe skill dropped from a later package set is left as is (no retire step yet).
- Review N2: the Required warning and the offer cap count team skills only; count installs (the
  seven) in the team's meter. Review: maintainer acts (SK24) must refuse Kobe skills;
  `by_kobe` on Default syncs is not tied to a Kobe skill in the DB.
- The promotion ticket (Phase B): a promotion of a skill named like a Kobe skill must answer a clear 409 (the DB says
  23514 `registry_skills_kobe_names`).

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
- Suites (after the review fixes): `@kobe/server` test:db 130 files / 1733 tests (six files
  timed out while the db and cli suites ran alongside; green when rerun alone); `@kobe/db` test:db
  57 files / 1331; `@kobe/cli` test:db 28 with `KOBE_PG_BIN_DIR=/opt/homebrew/opt/libpq/bin`
  (the older-schema blob-ref test now expects the catalog key columns); server, db, protocol,
  sandbox-agent unit suites; repo typecheck, lint, format:check. The image checks ran green
  against `kobe-sandbox:local-0d91bac618ab` on the Docker host.
