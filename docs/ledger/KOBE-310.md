# KOBE-310: A4: SkillStore interface (Postgres records + object-store bytes)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch, Skills v1.2 Phase A)
- **Branch / worktree:** `group-skills-a` in `../Kobe-skA`
- **Depends on:** KOBE-309 contract (same branch), incl. its R1/R2 doc commit

## Plan

`SkillStore` (`services/server/src/skills/skill-store.ts`) with `PostgresSkillStore`; upload,
download and sandbox fetch go through it; the KOBE-309 path rules on the upload path now (R1);
the one-off recompute and alias groups for existing rows (R1/R2). Migration
`0131_skill_store` alone in its own commit.

## Decisions

- **Interface:** `putPackage`, `getPackage(location, hash)` (runtime or package hash, verified),
  `listVersions`, `openVersion` (download), `openSandboxBundle` (sandbox fetch:
  `locateBundle` + verified stream), `recordApproval` (wraps `decideReview`), `export(location,
skillId, {fromSeq, toSeq})`. Location-scoped: a hash is only found in the caller's team or
  own personal skills (walls). The team review route still calls `decideReview` directly.
- **Bytes:** every read is verified against the row's hash (and size where recorded); a
  corrupted object throws `IntegrityError` (buffered) or errors the stream before its last chunk.
  **Dedup by hash within a location:** a put reuses the key of an existing version with the same
  runtime (or package) hash in the same team / user; otherwise a fresh per-attempt key as before,
  so a failed upload still deletes only what it wrote. Never across locations.
- **Runtime vs package (309 contract):** uploads are stored as the runtime zip (`content_hash`
  = runtime hash, what sandboxes get) plus, when they differ, the package zip
  (`package_storage_key`, new column). `package_hash` is recorded for every new version.
  `fileCount`/`uncompressedBytes` now count the runtime payload. The scanner scans the whole
  package. Download (browser editor) returns the package zip, so `evals/` and the manifest
  survive an edit. **Behaviour change by contract:** a new upload's `evals/` and
  `kobe.skill.yaml` no longer reach the sandbox.
- **Unchanged** now means the same package hash (N9): an evals-only change is a new version with
  the same runtime hash. Pre-310 rows compare by their content hash.
- **kobe.skill.yaml on upload:** parsed by the contract's text rules (fatal UTF-8, BOM
  stripped, 16 KiB, unique keys, no aliases), schema-checked, name must match SKILL.md
  (`invalid_manifest` 400). Its `version`/`changelog` number the version when the request gives
  none; a request value that differs is 400 (the manifest never renumbers silently).
- **R1:** the upload path runs `checkPackagePaths` (authored: no provenance.json): new codes
  `reserved_path`, `path_conflict`; invisible/bidi/lone-surrogate names are `unsafe_path`.
- **R1/R2 existing rows:** `skill_hash_checks` (site-wide, hashes only, app SELECT+INSERT)
  holds one row per stored hash: same / alias (runtime differs) / legacy (problems, runtime
  null). `recomputeSkillHashes` runs in the background at every server start, checks only
  unrecorded hashes (ON CONFLICT DO NOTHING, idempotent, safe on several replicas), skips and
  logs unreadable objects (retried next start), and logs a count report. New versions record
  their own row at upload. Legacy versions keep running; `export` returns them without bytes.
- **Blocklist on alias groups:** group = runtime hash + every stored hash aliased to it
  (`hashGroups`, one query). `blockedAmong`/`isBlocked` match any member; add is a no-op when the
  group is blocked; remove deletes every listed member (each audited). Writes take an advisory
  lock. The review queue's `blocked` flag uses the same rule.

## Open questions (for Chris or the coordinator)

- Promotion (333) must refuse legacy versions: `legacyProblems(hash)` is there for it.
- Orphaned objects from crashed uploads are still left for a later sweep (as before).

## Evidence (acceptance criteria → test or command output)

- ac-1: routes `skills.ts` (upload, versions, download) and `sandbox-routes.ts` use the store;
  `skill-package-upload.db.test.ts`, existing `skills.db.test.ts`, `skill-materialization.db.test.ts`.
- ac-2: existing API and sandbox tests unchanged and green (`@kobe/server test:db`).
- ac-3: `skill-store.db.test.ts` runs the interface against `PostgresSkillStore`.
- ac-4: same file: dedup within a location, not across; corrupted and resized objects refused;
  `skill-hash-checks.db.test.ts` (recompute outcomes, idempotence, alias-group blocklist,
  legacy export); `skill-store-upgrade.db.test.ts` (0131 on pre-existing rows, non-superuser owner).
