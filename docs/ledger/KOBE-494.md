# KOBE-494: Site Console gallery agents: Edit in the agent creator; an edit detaches

- **Status:** in review (committed on the branch, not pushed)
- **Branch / worktree:** `kobe-494-gallery-edit` in `../Kobe-wt494`
- **Depends on:** KOBE-87 (gallery seed), KOBE-46 (versions), KOBE-476 (two-tab creator)

## Plan

1. Migration commit (own PR): `0177_gallery_agent_customized` adds nullable
   `site_agents.customized_at`, `customized_by` (FK users, NO ACTION), `customized_from_generation`
   with check `site_agents_customized` (all or nothing, generation > 0, only with a `gallery_key`).
   `site_agents` is already a site-wide table with `ALL_PRIVILEGES` for the app role, so no
   tenancy or grant change. DB test in `packages/db/src/agents.db.test.ts`.
2. Feature commit: seed, site routes, web, docs, browser spec.

## Decisions

- **Seed** (`gallery/seed.ts`): a customized agent returns `skipped_customized` (after the archived
  check, so archived agents behave as before) and only raises `gallery_generation` to the repo's
  (never lowers it). Update available = `gallery_generation > customized_from_generation`; no
  extra column needed.
- **Reset to repository** clears the marker and sets `gallery_generation` to NULL, then seeds that
  one definition at once (`seedGalleryAgent`): the seed sees no generation, replaces the draft and
  publishes the repo definition as a new version (`published_by` NULL). If that seed fails the
  agent is still re-attached and the next start seeds it.
- **Repository definition** for Compare/Reset: the newest definition per key this server seeded
  (`rememberSeeded`), else `GALLERY_DEFINITIONS` (tests seed their own fixtures).
- **Routes** (`routes/site-gallery.ts`, `site.gallery.manage` on every request): `PUT /:id`
  (draft, If-Match) reuses `updateAgent`; publish, rollback, versions, version detail reuse
  `mountVersionRoutes` at gallery scope with a new `onPublished` hook that marks the agent; new
  `GET /builder-options` (site catalog models + active site connectors as `TeamConnectorView`),
  `GET /:id/compare`, `POST /:id/reset` (409 `not_customized`). Create, delete, status and
  unarchive stay 405 `gallery_read_only`. Dangerous mode: `mayUseDangerousMode(null, siteRole)`.
- **Marking** happens after a successful save/publish (`markCustomized`, idempotent, audited
  `agent.customized` once). Not in the same transaction as the save (`updateAgent` opens its own);
  the seed only acts at start-up, so the window is a rollout racing an edit.
- **Audit:** draft saves are the existing `agent.updated` (scope gallery, actor the admin) rather
  than a new `agent.draft_saved` (same event teams' draft saves use); publish `agent.published`;
  new `agent.customized`, `agent.reset_to_repository` (site). Rows in `docs/audit-log.md`.
- **Startup seeds** (`packages/db/src/startup-seeds.ts`): customized gallery agents are real data
  for `kobe restore` (`AND customized_at IS NULL`).
- **Web:** the Behaviour tab's data now comes from `BuilderSourcesContext`
  (`agent-builder/builder-sources.tsx`; default = active team, unchanged for teams). The gallery
  editor (`components/admin/site/gallery-agent-editor.tsx`, route `/admin/site/gallery/[id]`)
  reuses `IdentityFields`/`BehaviourFields` with the site's sources; Publish asks first; a simple
  version list (repository vs site admin). Skills are typed by name (no site skill list).
  `gallery-customization.tsx`: Customized badge, update notice with Compare (side by side) and
  Reset (asks first). The editor offers Reset for any customized agent (so it can be restored
  even when the repo has not moved; the browser spec needs this).
- **Docs:** `docs/specs/gallery-agents.md` (decision note, D19/D21 amended 2026-10-23),
  `docs/install.md` upgrade note, `docs/backup-restore.md`.

## Open questions (for Chris or the coordinator)

- `agent.draft_saved` was named in the brief; I kept `agent.updated` (the existing draft-save
  event, with `scope: "gallery"`). Say if a separate action is wanted.
- The gallery editor has no test chat, eval gate or Orbit export (team-only features).

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/agents.db.test.ts` "marks a seeded gallery agent customized only as a
  whole"; `pnpm --filter @kobe/db test:db` 93 files / 1560 tests green (probe suite included).
- ac-2/ac-3/ac-4: `services/server/src/gallery-edit.db.test.ts` (13 tests: admin only incl. a
  demoted admin, audit rows, If-Match, publish versions, fork gets the new version,
  `skipped_customized`, compare, reset + re-seed); updated `gallery.db.test.ts`,
  `agent-versions.db.test.ts`.
- ac-5 web: `components/admin/site/gallery-agent-editor.test.tsx`, `site-pages.test.tsx`
  (Edit link, badge, notice, Compare, Reset asks first). Browser spec
  `e2e/browser/tests/site-gallery-edit.spec.ts` (not run against gate1, per the brief).
