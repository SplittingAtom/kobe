# KOBE-380: SMA5: Memory stewards — site_grants value, Workspace steward table, permissions.ts

- **Status:** in review (local commits; coordinator opens the PR)
- **Branch / worktree:** `kobe-380-sm-stewards` in `../Kobe-wt380` (on `kobe-377-sm-contract`, PR #532)
- **Depends on:** KOBE-376 (merged), KOBE-377 contract (PR #532). v1.3 wave A2; second serial
  migration, lands alone.

## Plan

Two commits: (1) the migration alone, (2) the feature (permissions, routes, UI, docs).

## Decisions

- **Migration** `0218_memory_stewards` (generated): `ALTER TYPE site_grant ADD VALUE
'memory_steward'` (drizzle-generated, like `0180_catalog_site_edit`'s `registry_publisher`; PG
  ≥ 12 allows it in the migration transaction as long as nothing in the same batch uses the
  value) and team table `memory_stewards` (`team_id, user_id` PK, `granted_by` → users NO ACTION,
  `granted_at`). `0219_memory_stewards_rls` (custom): ENABLE + FORCE RLS, canonical
  `team_isolation` policy; no break-glass policy (stewards are not content).
- **Composite FK** `(team_id, user_id)` → `team_members` ON DELETE CASCADE: only a member can be a
  steward and the grant goes with the membership. `removeMemberInTx` deletes the steward row
  first so the removal is audited (`memory.steward.revoked`); the cascade covers team deletion.
- Tenancy: `memory_stewards` in `tenancy/memory.ts` (team); probe fixture in
  `probe-fixtures/memory.ts`. `SITE_GRANTS` and the `identity.site_grant.*` audit enum follow the
  DB enum (the audit enum now reads `siteGrant.enumValues`).
- **Permissions** (`authz/permissions.ts`): team `team.memory.curate` (team_admin) and
  `team.memory.site_proposals.confirm` (team_admin); site `site.memory.curate`,
  `site.memory.policy`, `site.memory.site_proposals.decide` (admin). Stewards are grants beside
  the ladders, like `skill_reviewer`: `teamMemoryAllows({role, memorySteward})` and
  `siteMemoryAllows({siteRole, grants})` add exactly `MEMORY_STEWARD_TEAM_PERMISSIONS =
[team.memory.curate]` / `MEMORY_STEWARD_SITE_PERMISSIONS = [site.memory.curate]`. A Workspace
  steward needs membership (non-member → nothing). Contributors/Members get no `team.memory.*`.
  `team.memory.manage` (switches) stays Team admin only.
- `GET /v1/team` now also returns `memorySteward` and includes `team.memory.curate` in
  `permissions` for stewards (`teamPermissionsFor(role, { memorySteward })`).
- **Routes** (contract of KOBE-377): `GET/PUT/DELETE /v1/team/memory/stewards[/{userId}]` gated by
  `team.members.manage` (Team admins; the Members page); PUT is idempotent (audit once), 404
  `user_not_found` for a non-member, DELETE 404 `not_found`. `GET /v1/site/memory/stewards`
  (`site.users.manage`, active holders only). Site grant given/taken through the existing
  `PUT/DELETE /v1/site/roles/grants/{userId}/memory_steward` (generic; no Registry membership).
- **UI**: Members page gets a **Memory stewards** section (list with role, Take with confirm,
  Make form offering active non-steward members of any role). Site roles: the Skill reviewers
  section became a generic `SiteGrantSection` (filters by grant: memory stewards no longer show as
  reviewers); **Site memory stewards** offers only plain users (admins already curate).
- **Admin MCP**: `site_grants_list/give/take` take `z.enum(SITE_GRANTS)`, so `memory_steward`
  works there; titles/descriptions now name both grants. The team member tools list no grants,
  so no Workspace steward tool was added.
- `memory.policy.set` audit comment corrected: Site stewards never set Policy.
- No route consumes `team.memory.curate`/`site.memory.*` yet: the item store (KOBE-378 and later)
  gates with `teamMemoryAllows` + `isWorkspaceSteward` and `siteMemoryAllows` + `grantsOf`.

## Open questions (for Chris or the coordinator)

1. "Can't confirm Site proposals" read as both: Workspace stewards can't confirm a Workspace item
   as a Site proposal (Team admins only), and Site stewards can't accept/dismiss Site proposals
   (Site admins only). Confirm.
2. Site admins are not offered the Site steward grant in the UI (it adds nothing); the server
   still allows it (generic grant rules). Fine?

## Evidence (acceptance criteria → test or command output)

- **ac-1:** `services/server/src/authz/permissions.test.ts` (team matrix incl. Contributor and the
  new permissions; steward × every team role; site steward over every site permission);
  `memory-stewards.db.test.ts` (`GET /v1/team` permissions per role and grant).
- **ac-2:** `memory-stewards.db.test.ts` (grant/revoke, idempotent, audited in the team log;
  membership removal audited; Site grant audited `identity.site_grant.*`); web
  `components/admin/memory-stewards.test.tsx` (Members page + Site roles sections).
- **ac-3:** permissions tests (no Policy, no Site proposals, no switches, no non-memory rights;
  grants don't mix with Skill reviewer); DB test (`siteRole` null, Site console routes 403, no
  Registry membership, steward can't manage stewards).
- **ac-4:** commit 1 holds only the migration (+ the enum mirrors it forces);
  `packages/db/src/memory-stewards-upgrade.db.test.ts` (enum value kept grants, RLS forced,
  policy, cross-team 42501/23503, cascade); probe + catalog suites green (1094 tests).
- **ac-5:** `docs/guide/admin/team-admin.md`, `site-admin.md`, `admin-from-a-conversation.md`,
  `glossary.md` (summaries feed `/llms.txt`); `docs/audit-log.md`; upgrade note in
  `docs/install.md`.
