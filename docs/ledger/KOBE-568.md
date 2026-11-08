# KOBE-568: Server: fork lands in Personal with binding; transfer; adopt

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #485)
- **Branch / worktree:** `kobe-568-fork-transfer-adopt` in `../Kobe-wt568`
- **Depends on:** KOBE-565 (`site_agents.bound_team_id`), KOBE-566 (roster writes, `assignDecision`).
  Spec `docs/specs/agents-roster.md` AR8, AR10, AR16, §5, §6.7-6.9 (AR-4). No migration.

## Plan

Server only. Rules `agents/access.ts` (`canForkAgent(actor, via)`, `forkBinding`); fork source and
copy `agents/fork.ts`; transfers `agents/roster-transfer.ts`; adopt `agents/roster-adopt.ts`; routes
`routes/agent-transfer.ts` (transfers mounted in `agentRoutes` before `/:id`, adopt on the team and
site roster routers); contract `packages/protocol/src/agent-ownership.ts`; OpenAPI in
`openapi/agent-roster.ts` (`agentOwnershipOpenApiPaths`). `store.ts` gained `insertAgent(tx, …)`
(createAgent's body, so adopt is one transaction) and `NewAgent.boundTeamId`; `roster-writes.ts`
exports `lockRoster`, `lockPersonalAgent`, `writeEntry`, `audit` (no behaviour change).

## Decisions

- **Fork source (§5):** the team's own agent (`build`), the caller's own personal agent, a gallery
  agent (`use`), or someone else's personal agent with an assigned (`active|suspended`) entry on the
  site roster (`use`, unbound) or the active team's roster (`build`, bound). Site entry wins when
  both exist (anyone may read it from the site, so the copy is unbound). Anything else 404.
- **What is copied:** the published version; the draft only when nothing is published and the
  caller may read the draft (own, team-owned, gallery). Someone else's never-published entry →
  `422 agent_not_published`. Own published agents now fork from the published version (AR8), not
  the draft as before.
- **Binding:** `forkBinding`: a bound source keeps its team; team-owned or team-entry → active team;
  else null. `agent.created` (source fork) carries `boundTeamId`; it is site-level (`teamId` null)
  like every personal agent's audit. Members (no `build`) can no longer fork team content at all
  (403), as before; gallery forks are now open to members (personal).
- **Body:** `scope` accepted (any short string) and ignored; the response's `warnings` gets
  `{path: "scope", …}` (`AGENT_FORK_SCOPE_IGNORED`). Response adds top-level `boundTeamId`.
- **Transfer storage: no new table.** A pending offer is one `site_settings` row per agent
  (`agent_transfer:<agentId>`, JSON ids + timestamp): at most one per agent, short-lived, site-wide
  like the agent. Writes run in `withTeam()` of the offer's team, membership read there with
  `team_id` explicit. If a reviewer prefers a dedicated table, it is a small expand-only migration
  after #484; the module is the only reader.
- **Transfer shape:** `POST /:id/transfer {toUserId}` (owner → another active member of the active
  team; a new offer replaces the old one), `POST /:id/transfer/accept` (recipient),
  `DELETE /:id/transfer` (owner cancels or recipient declines, 204), `GET /v1/agents/transfers`
  (both directions). The owner's `GET /v1/agents/:id` carries `transfer`; the recipient's read of
  that id returns the summary (no definition) + `transfer`. Accept re-checks membership, binding,
  the recipient's slug (`409 slug_taken`) and cap (`409 limit_reached`) under their create lock,
  then moves `owner_user_id` only: entries keep their rows (and `assignedBy`), threads their pins.
  All four writes count against `agent-roster:<userId>`. Audit `agent.transfer.requested`,
  `.cancelled` (`by`), `agent.transferred`, all with the offer's team.
- **Adopt:** allowed whether or not the owner is present (admins may adopt; AR10 only says
  "can"). Copies the agent's **current** published version (not the entry's pin) as the new agent's
  **draft** with fork provenance; it is not auto-published, so the team eval gate (KOBE-93) and
  the gallery console's publish stay the only publish paths. The roster runs nothing of it until
  then: say if adopt should publish v1 directly. Site copy: `scope = gallery`, no `gallery_key`; the
  `customized_*` columns stay null (their CHECK requires a repository key), which already means
  "the seed never touches it". Proposals and removed entries are not adoptable (404). Audit
  `agent.roster.removed` + `agent.adopted` (new agent id, `fromAgentId`, `fromVersion`);
  `agent.created` with `source: adopt`.

## Open for 571/572

- **571 (web):** fork dialog posts `{slug?}` only (drop `scope`; `forkGalleryAgent` still sends
  `scope: "team"` and now gets a personal copy plus the warning). Bound note from the response's
  `boundTeamId`. Transfer UI: `GET /v1/agents/transfers` for the inbox, `transfer` on the agent read;
  adopt buttons on Team/Site rows for admins (no `actions.adopt` on rows yet: render for
  `remove`-capable admins on assigned entries). After adopt, open the copy's editor to publish.
- **572 (browser):** "fork bound": fork a team-assigned agent as a builder → Personal, assign to
  site → 422. "owner leaves": adopt into team, publish, run. `site-gallery-edit.spec.ts` forks and
  deletes; its fork is now personal (delete still works).

## Open questions (for Chris or the coordinator)

- Transfer offers live in `site_settings` (no migration). OK, or a dedicated table later?
- Adopt leaves the copy unpublished (eval gate stays in charge). OK, or publish v1 on adopt?

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/agent-ownership.db.test.ts` "fork lands in Personal" (gallery,
  site-assigned, team-assigned, team-owned, own draft/published, 403 for members on team content,
  404 cross-team, bound fork → site 422 and other team 422, own team 201, copy of a copy bound);
  `src/agents/access.test.ts` (`canForkAgent`, `forkBinding`); updated `agents.db.test.ts`,
  `gallery.db.test.ts`, `audit.db.test.ts`.
- ac-2: `agent-ownership.db.test.ts` "transfer" (acceptance required, both reads and lists, entry
  row and thread pin kept, new owner withdraws, decline/cancel, slug clash 409, bound → other team
  422, audit ids only).
- ac-3: `agent-ownership.db.test.ts` "adopt" (team admin only, 403 builder/member/other team;
  published version copied with provenance; entry removed; site adopt → gallery without key; audit).
- Contract/OpenAPI: `packages/protocol/src/agent-ownership.test.ts`, `src/openapi/document.test.ts`.
