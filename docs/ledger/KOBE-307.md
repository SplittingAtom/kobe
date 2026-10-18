# KOBE-307: A1: Rename site_skills to personal_skills (scopes)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch, Skills v1.2 Phase A)
- **Branch / worktree:** `group-skills-a` in `../Kobe-skA`
- **Depends on:** none (first migration of v1.2, lands alone)

## Plan

Rename the three personal-skill tables and every object named after them, in place, and the
Drizzle and server identifiers that mirror them. No behaviour change.

## Decisions

- Migration `0128_personal_skills_rename` is hand-written (`-- kobe:hand-written`, as 0091):
  drizzle-kit can only generate a rename interactively. Its snapshot is 0127's with every
  `site_skill` renamed (`db:check`: no schema changes). ALTER ... RENAME only: no rewrite, no
  rows touched, so no FORCE-RLS backfill concern (the tables are site-wide, no RLS).
- Renamed: `site_skills`, `site_skill_versions`, `site_skill_scans` → `personal_*`; their 15
  constraints (incl. `site_skills_pkey`) and the trigger `site_skill_versions_immutable`. No
  enum, index, policy or function body names them (checked in the upgrade test). Grants follow
  the tenancy matrix (`tenancy/agents.ts`), re-applied by the migration runner.
- Drizzle: `siteSkills` / `siteSkillVersions` / `siteSkillScans` → `personalSkills` /
  `personalSkillVersions` / `personalSkillScans`; `SiteRow` → `PersonalRow` in the skill store.
- Kept: the Site skill blocklist (`skill_blocklist`, `/site/skill-blocklist`,
  `siteSkillBlocklistRoutes`) is Site-wide, not personal, and keeps its name. Migration 0091 and
  the KOBE-256 upgrade test keep the old names as history (that test now expects the final
  `personal_*` names, since it migrates to the end).
- Audit: no audit action or category ever named site skills (`skill.uploaded` already records
  `scope: "personal"`), so no event is renamed and `HISTORICAL_AUDIT_ACTIONS` is unchanged. No
  audit row is touched (the upgrade test compares seq/hash before and after and verifies the chain).
- Guard: `scripts/site-identifiers.mjs` (run by `check-site-wording.mjs` in CI) now fails on
  `site_skill(s|_versions|_scans)` and `siteSkill(s|Versions|Scans)` in code, with self-tests;
  the blocklist names pass.
- Web (`apps/web/app/me/skills`) and `routes/skills.ts` had no `site_skill` identifiers.

- Review fixes: upgrade note in `docs/install.md` (not expand/contract: old pods fail run starts
  until replaced; no `helm rollback`, back up first; no compatibility views). Guard regex now
  also catches compound names (`site_skills_pkey`); the upgrade test also scans views, column
  defaults and comments. Skipped N4 (`RAISE NOTICE` in 0128): it would put a non-migration
  change on top of the migration-only commit; the install note covers the rename.

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/personal-skills-rename-migration.db.test.ts` (no object named
  `site_skill*` after upgrade; constraint and trigger names); `scripts/check-site-wording.mjs`
  → `site wording: ok`; `pnpm --filter @kobe/db db:check` → no schema changes.
- ac-2: same test, "touches no audit row": rows and hashes equal before/after the upgrade as the
  non-superuser owner, `verifyAuditChain` ok. Readers unchanged (no renamed names).
- ac-3: `@kobe/db test:db` 53 files / 1249 tests passed; `@kobe/server test:db` 118 / 1624
  passed; `pnpm verify` (no DB) green except one web unit test that timed out under load and
  passed on rerun (`@kobe/web test` 181 / 1812). Gate 1/2 browser shards run in the group's CI.
