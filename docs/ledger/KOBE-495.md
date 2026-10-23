# KOBE-495: Site Console: view and edit catalog skills and publish site-made versions

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (committed locally, not pushed)
- **Branch / worktree:** `kobe-495-catalog-edit` in `../Kobe-wt495`
- **Depends on:** KOBE-494 (detach pattern; this branch starts on it)

## Plan

1. Migration commit (own PR): `0180_catalog_site_edit` (generated) + `0181_registry_publisher_guard`
   (custom). (renumbered from 0178/0179 after KOBE-492 took those; PR #392).
2. Feature commit: server (`services/server/src/skills/site-edit/`, route
   `routes/site-skill-catalog-edit.ts` at `/v1/site/skills/catalog-skills/:skillId`), web (Skill
   tags → Open → `/admin/site/skill-tags/catalog/[id]` and `/edit`), docs, browser spec.

## Decisions

- **Publisher `site` on versions only.** `registry_publisher` gains `site`; a skill keeps its own
  publisher (Kobe names stay Kobe's). The composite FK `registry_versions_publisher_fk` can't allow
  "the skill's publisher or site", so it is replaced by an AFTER trigger that raises the same
  SQLSTATE (23503) and constraint name (existing tests unchanged), plus a guard on
  `registry_skills.publisher` changes. New-enum-value safety: the migration batch runs in one
  transaction, so every SQL use of `'site'` compares `publisher::text` (no unsafe enum literal).
- **Site version shape** (`registry_versions_site_publisher`): the admin is `submitted_by`, no
  reviewer/claim/self-approval, stored bytes; `registry_versions_approval` accepts `kobe` or `site`
  without a reviewer. The review guard trigger then sets `self_approved` false (unchanged code).
- **Detached marker** on `registry_skills` (`detached_at/by/from_version`, `kobe_shipped_version`),
  all-or-nothing, Kobe skills only. Set when a site draft of a Kobe skill is started (the first
  edit), in that transaction under the skill row lock (the seed's lock), and again (no-op) in the
  publish transaction: never in a second transaction (494 review). The seed checks it before the
  scan and again under the lock; detached → `skipped_detached`, shipped semver recorded. The seed
  never retires/archives anything (checked: no such code path), detached or not.
- **Reset to Kobe**: refused (`shipped_not_above`, stays detached) while any Site version's semver
  ≥ the shipped one; otherwise clears the marker, drops the site draft, audits, then seeds the
  shipped package at once (best effort; the next start retries).
- **Site drafts**: separate site-wide tables `site_skill_drafts` (one per skill, shared by Site
  admins, base version FK'd to the skill's own versions) and `site_skill_draft_files`; grants only,
  no team RLS touched. Same rules as Workbench drafts (paths, 200 files, SKILL.md cap, 5 MiB,
  If-Match revisions). `provenance.json` is never written into a draft. Not under legal hold
  (site admin content, no team data) — say if that is wrong.
- **Admin re-check**: route middleware (`site.skills.catalog.manage`, role read per request) and
  `isSiteAdmin` inside every writing transaction (draft start/write/delete/discard, publish, reset).
- **Guards**: blocklist = any of the skill's (or the new) hashes blocked → refused; retired =
  status `deprecated`/`archived` → refused until undeprecated.
- **Notification**: new kind `skill.version.site_published` with `actor_user_id` (DB check: set
  exactly for that kind); protocol adds the kind and `actor_name`. Recipients: the skill's
  maintainers who are members of the team of its newest maintainer version (`source.teamId`).
  In-app only (no email). The bell lists the kind (`notifications/store.ts`).
- **Default sync**: a site version in the Default's current major queues an `add` (as the Kobe
  seed does); Track installs pick it at resolve; pinned installs never move.
- **Web**: Workbench editor reused via a `DraftClient` (`lib/skills/draft-client.ts`;
  `useDraftEditor(teamId, id, client?)`), so autosave, revisions and the scan preview are the
  Workbench's. Rename = write new path + delete old. View files use the lazy read-only CodeMirror;
  SKILL.md Rendered/Raw. Compare reuses the review diff (`ReviewDiff`).
- Protocol additions ride in the migration commit (DB enum/kind ties and the web title switch need
  them to build); they are additive.

## Open questions (for Chris or the coordinator)

- Browser spec restore: versions are immutable, so it withdraws the version it published. On a
  site with no team-published catalog skill the spec skips (set `KOBE_CATALOG_SKILL`).
- Maintainers of a team-published skill outside the publishing team get no notice (no team to
  file it under); email was not added.

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-2, ac-3, ac-4, ac-5: `services/server/src/site-catalog-edit.db.test.ts` (8 tests: view
  admin-only, draft persist + stale rev + role re-check, scan Block, semver must rise, publish
  publisher site + audit + provenance + maintainer bell, retired/blocklisted, detach + seed skip +
  shipped recorded, Default add queued, compare, reset refused/accepted + seed publishes).
- DB: `packages/db/src/catalog-site-edit-upgrade.db.test.ts` (upgrade from 0177 in one batch;
  site versions; publisher rule; detached check; drafts; notification actor);
  `kobe-published-skills.db.test.ts` unchanged and green. Full `@kobe/db` suite incl. probe: 94
  files / 1566 tests green.
- Web: `apps/web/components/admin/site/catalog-skill.test.tsx` (view, Kobe edit asks, detached
  notice + Compare + Reset refusal, retired, editor load + publish with If-Match, scan Block
  findings); skills/site/notifications suites green.
- Browser: `e2e/browser/tests/site-catalog-edit.spec.ts` (not run against gate1).
