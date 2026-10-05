# KOBE-87: Gallery mechanism: read-only gallery agents and fork to team

- **Status:** in review (PR #87)
- **Branch / worktree:** `kobe-87-gallery` in `../Kobe-wt87`
- **Depends on:** KOBE-45/46 (agents, versions), KOBE-86 (team suspension), KOBE-84/97 (builder)

## Acceptance criteria

- **ac-1 Gallery items are read-only.** No API writes a gallery agent, install admins included.
- **ac-2 Fork creates an editable team agent.**

## Decisions

- **No parallel table.** Gallery agents are the existing `install_agents` rows with
  `scope = 'gallery'` (KOBE-45) and their `install_agent_versions`; threads, pins, resolver and
  KOBE-86 team suspension (`team_agent_suspensions`) work unchanged.
- **Source of truth is the repo.** `services/server/src/gallery/definitions.ts` holds
  `GALLERY_DEFINITIONS` (`{ key, file }`, `file` = agent file text, slug = key). It ships empty;
  KOBE-89 adds the five agents there. Tests seed their own fixtures through `seedGalleryAgents`.
  Frontmatter `skills` may name built-in skills (KOBE-88) like any skill slug; nothing here
  validates names against skills that exist (the resolver does at run start).
- **Seeding** (`gallery/seed.ts`), at server start before serving (`index.ts`, server process
  only; a bad definition or database fails the start). Per definition: lock the row by
  `gallery_key`, replace the draft if the definition's `generation` (monotonic integer in the repo)
  is newer than `gallery_generation`, publish (system actor, `published_by` NULL), then store the
  generation. Same or older generation (an old replica in a rollout/rollback): no writes. Newer: one new version (older versions stay; threads pinned to them keep them). Replicas
  starting together converge (unique key + row lock; `publishAgent` answers `unchanged` to the
  loser). A row an older install curated under the same slug is adopted by key. An archived
  agent (by key or same slug) is skipped, never revived, never an error. One definition failing
  is logged (`failed`) and the rest still seed; a seed error never stops server start.
- **Retire on removal:** a seeded agent whose key left `GALLERY_DEFINITIONS` is archived (system
  actor, `agent.archived`): hidden from the gallery, no new threads, existing threads and forks
  untouched; idempotent. `install_agents.archived_by = 'seed'` records why. When the key
  returns (rollback ended, re-added) a seed-retired agent is restored (`agent.unarchived`, system),
  and republished only if the generation is newer, so no version flip. Archives by people leave
  `archived_by` NULL and are never undone by seeding.
- **Fork** reuses `POST /v1/agents/:id/fork {scope:"team"}` (needs `team.agents.build`, per
  `canForkAgent`). It copies the **published** version, creates the team agent with its first
  draft (`currentVersion` null, revision 1), records provenance and audits.
- **Provenance:** `forked_from_agent_id` / `forked_from_version` on `team_agents` and
  `install_agents` (no FK: a personal source can be deleted); returned as `forkedFrom`;
  `agent.created` audit carries `forkedFrom` + `forkedFromVersion` (new `seed` source value for
  seeded agents, system actor).
- **Migration `0059_gallery_agents`:** gallery key/generation columns (unique key, scope check),
  provenance columns, `install_agent_versions.published_by` nullable (NULL = published by the
  server from the repo). Team versions still need a publisher (checked in `insertVersion`).
- **UI:** team agents page gets a Gallery section (list, "Fork to team" for builders, link to the
  new draft in the builder). The install console gallery page is read-only (import, publish,
  suspend, archive removed). No chat agent picker exists in the web app yet, so there is none to
  extend; gallery agents are already startable via `agent_id` on `POST /v1/threads`.

## Open questions

- The chat agent picker is a separate ticket.
- A fork copies the version published at fork time; "update from gallery" for forks is out of
  scope.

## Evidence

- `services/server/src/gallery.db.test.ts`: seeding (create, idempotent restarts, concurrent
  replicas, new version on change with pinned threads, bad definitions, adoption), read-only on
  both routers (every write), visible and usable from two teams, per-team suspension, fork
  (editable, publishable, provenance, audit, role checks, slug numbering). ac-1, ac-2.
- Updated: `agents.db.test.ts`, `agent-versions.db.test.ts` (gallery now seeded, not curated).
- Web: `team-pages.test.tsx` "Gallery agents on the team page", `install-pages.test.tsx` "Gallery agents".
- `pnpm verify` and `test:db` (probe suite): see PR.
