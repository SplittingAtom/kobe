# KOBE-311: A5: Registry, tags, installs and grants schema

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch, Skills v1.2 Phase A)
- **Branch / worktree:** `group-skills-a` in `../Kobe-skA`
- **Depends on:** KOBE-308 (`skill_access` enum), KOBE-310 (same branch)

## Plan

Migrations alone in one commit: `0132_skill_registry` (generated: enums and 12 tables) and
`0133_skill_registry_rls` (custom: RLS on the four team tables, seeds, system-tag guard). Then
the Drizzle schema (`schema/registry.ts`, `grants.ts`, `installs.ts`), tenancy registry
(`tenancy/agents.ts`), probe fixtures, the protocol contract (`skill-catalog.ts`) and tests.

## Decisions

- **Site-wide (†):** `registry_skills` (flat unique name, publisher, summary, status, optional
  `replacement_id` for Deprecate SK31), `registry_maintainers`, `registry_versions` (semver +
  seq unique per skill, runtime/package hashes, JSON documents as objects, `claimed_by/at` for
  the SK23 claim, `verdict`; a published state iff `approved_at` and `reviewed_by` are set; unique
  `(id, skill_id)` so installs can name both), `registry_review_events` (append-only),
  `registry_tags` (kind system|topic, status active|retired), `registry_skill_tags`,
  `site_grants` (`skill_reviewer`), `site_skill_settings` (seeded singleton; `registry_team_id`
  ON DELETE SET NULL, allowlisted in `teamReferencing`).
- **Grants (least privilege):** catalog skills, versions and tags SELECT/INSERT/UPDATE (never
  deleted: archived, retired); review events and hash checks append-only; maintainers,
  skill tags and site grants SELECT/INSERT/DELETE; settings SELECT/UPDATE (the row is seeded).
- **Team tables (FORCE RLS, canonical policy, probes):** `team_skill_installs` (PK team+skill;
  composite FK `(version_id, skill_id)` → `registry_versions(id, skill_id)`, so a version always
  belongs to the installed skill; `pin_mode`, `access` reusing `skill_access`, `origin`),
  `team_skill_optouts` (reason ≤ 500), `team_skill_blocks`, `member_skill_enablements` (PK team+id,
  unique (team, user, skill_ref); `skill_ref` exactly `{kind: catalog|team, skillId}`; version
  and pin mode together and only for catalog skills; composite FK to `team_members` ON DELETE
  CASCADE, so a member's choices leave with the membership).
- **System tags (ac-3):** `default` seeded in 0133. A CHECK limits system tags to the code-defined
  set (`default`, active); an invoker-rights trigger (`registry_tags_system_guard`, pinned
  search_path, not SECURITY DEFINER) refuses deleting, renaming or changing the kind/status of a
  system tag, even as the owner. The app role has no DELETE on tags anyway.
- **Contract (ac-4):** `packages/protocol/src/skill-catalog.ts`: pin modes, access modes,
  origins, tag kinds/statuses, `SYSTEM_TAGS`, publishers, skill statuses, version states (plus
  published/installable subsets), review actions, site grants, `skillRefSchema`, install and tag
  request/response schemas. A server unit test keeps every DB enum equal to its protocol list.
- No views, no SECURITY DEFINER; no backfill (new tables), so no FORCE lifting.

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- ac-1: `@kobe/db` `probe.db.test.ts` (fixtures for the four team tables) and
  `skill-registry.db.test.ts` (upgrade with existing teams/members as the non-superuser owner;
  FORCE RLS; RLS refuses another team's row).
- ac-2: `catalog.db.test.ts` (classification, team references, grants matrix, no SECURITY
  DEFINER) green.
- ac-3: `skill-registry.db.test.ts` "system tags are code-defined".
- ac-4: `packages/protocol/src/skill-catalog.test.ts`, `services/server/src/skills/catalog-contract.test.ts`;
  `drizzle-kit generate` → no schema changes.
