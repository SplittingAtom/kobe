# KOBE-308: A2: Semver, sequence, changelog and package hash on skill versions

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch, Skills v1.2 Phase A)
- **Branch / worktree:** `group-skills-a` in `../Kobe-skA`
- **Depends on:** KOBE-307 (same branch)

## Plan

Migrations first (alone in one commit): `0129_skill_semver` (drizzle-generated: nullable
columns, `skill_access` enum, `access` + `archived_at` on `team_skills`, unique semver per skill,
format checks for `package_hash` and `changelog`) and `0130_skill_semver_backfill` (custom:
backfill, then SQL-only checks). Then server, web and tests.

## Decisions

- **Backfill under lifted FORCE:** `team_skills` and `team_skill_versions` are FORCE-RLS team
  tables, so 0130 runs `NO FORCE … FORCE` around the UPDATEs (as 0123). Both version tables'
  immutability triggers refuse every UPDATE, so they are `DISABLE`d / `ENABLE`d around the
  backfill too (owner may; one transaction). The notice counts rows before FORCE returns.
- **NOT NULL via SQL checks**, not Drizzle `notNull()`: `*_semver_format` (`semver IS NOT NULL`
  and `^(0|[1-9][0-9]{0,8})(\.…){2}$`, no pre-release/build) and `*_seq_matches`
  (`seq IS NOT NULL AND seq = version`). Keeps one generated + one custom migration and a
  `db:rebase` that can't regenerate a NOT NULL ADD COLUMN ahead of the backfill. Drizzle types
  stay nullable; the store maps nulls to `0.<n>.0` / n (never happens after 0130).
- **seq = version** for local skills (check). `version` stays the key every FK uses (scans,
  reviews, threads); `seq` is the name shared with catalog versions (KOBE-311). No separate
  unique index on seq (the PK covers it). Unique `(…skill_id, semver)` per table.
- **Numbering:** uploads take optional `?semver=&changelog=` (query, beside `scope`). Default =
  next minor of the latest (0.1.0 for a new skill), in step with the 0.n.0 backfill. A requested
  number not above the latest (by seq) → 409 `semver_not_increasing`, "Version X must be higher
  than the latest version, Y."; malformed → 400 `invalid_request`. Comparison is numeric
  (`skills/semver.ts`, no dependency). Increase is enforced in the server under the existing
  per-location advisory lock, not in the database.
- **package_hash**: nullable, hex-64 when set; left null until KOBE-309 defines package
  hashing (legacy versions stay null). **changelog**: nullable, 1–1024 chars.
- **access**: enum `skill_access` (available, default_on, required, hidden), default
  `available`, backfilled from `offer_to_all`. `offer_to_all` stays the resolver's input;
  `setOfferToAll` writes both until the resolver reads `access` (SK27 ticket). No DB check
  tying them (required/hidden would break it). `archived_at` added, unused yet.
- **API:** skill JSON + `latestSemver`, `access` (null for personal), `archivedAt`; version JSON
  - `seq`, `semver`, `changelog`, `packageHash`; versions listed by seq desc; `/versions/:v` and
    `/bundle` take a seq or a semver; bundle filename `<slug>-v<semver>.zip`; review queue rows +
    `semver`. Audit `skill.uploaded` gains optional `semver` (additive; no rename).
- **Web:** skills list, team inventory, editor ("Current version" / "Saved as") and review queue
  show the semver. Uploading a chosen number from the web waits for the Workbench (phase B).
- **Upgrade note** in `docs/install.md`: previous-release pods can't store uploads after the Job
  (or after a rollback); reads and run starts keep working.
- The KOBE-307 upgrade test now checks its renamed constraints with `arrayContaining` (it
  migrates to the end, and 0129/0130 add constraints).

## Open questions (for Chris or the coordinator)

- Default number for a new skill is 0.1.0 (matches the backfill); say if 1.0.0 is preferred.

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/skill-semver-upgrade.db.test.ts` (pre-existing team + personal rows,
  migrated as the non-superuser owner: 0.n.0 / seq n, offer → default_on, FORCE and triggers
  back, checks refuse null/malformed/duplicate/mismatched); fails if `NO FORCE` is removed
  (checked by hand).
- ac-2: `services/server/src/skill-semver.db.test.ts` "refuses a number that is not above the
  latest" (409 + message, no blob, no version) and the malformed cases; `skills/semver.test.ts`.
- ac-3: same db test "lists newest first by seq …", review queue, audit; web tests
  (`skill-editor-pages`, `my-skills`, `skill-review-pages`, `team-inventory-page`).
- `@kobe/db test:db` 54 files / 1253 tests; `@kobe/server test:db` 119 / 1632; all unit tests
  green (`turbo run test --continue`; a sandbox-agent real-process timing test flaked once under
  load and passed alone); lint, typecheck, format, licence, hygiene, wording ok.
