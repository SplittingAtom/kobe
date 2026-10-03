# KOBE-46: Agent versioning, publish, pinning, rollback

- **Status:** in review
- **Branch / worktree:** `kobe-46-agent-versions` in `../Kobe-wt46`
- **Depends on:** KOBE-45, KOBE-29, KOBE-34, KOBE-35, KOBE-15, KOBE-20 (all merged)

## Acceptance criteria (spec D19, D6, D8, D20, U8, §5.4, §6.1; Gate 3 "v2 publish leaves v1 threads pinned and rollback works")

- **ac-1 Versions.** Publish creates an immutable, numbered version (frontmatter, prompt, frozen tool
  manifest, publisher, time) for team, personal and gallery agents. Immutability is enforced by the
  database. Concurrent publishes get distinct consecutive numbers.
- **ac-2 Frozen manifest.** Computed at publish time against the policy floor (install, plus the
  team's rules for team agents); allow only narrows, deny wins, approval mode only stricter than the
  floor. What happens when the floor changes later is decided and recorded.
- **ac-3 Endpoints and authz per role** (§6.1 `/v1/agents/{id}/versions`, `POST …/publish`):
  publish, rollback, version history, archive/unarchive; builders publish their own team agents,
  team admins any, members their personal agents, install admins the gallery.
- **ac-4 Thread pinning.** `POST /v1/threads {agent_id}` pins the current version; the pin survives
  later publishes; the thread read shows the newest version ("v3 available"); one-click switch.
- **ac-5 Delete → archive.** An agent with versions is archived, never deleted; pinned threads keep
  their version (database FKs, NO ACTION).
- **ac-6 Isolation.** Team versions are a team table (RLS, probe fixture); personal versions are
  confined to their owner; no pin crosses a team wall.
- **ac-7 Audit.** Publish, rollback, archive, unarchive, thread version switch.
- **ac-8 Seam for KOBE-47:** `resolvePinnedAgent` (no run-time resolution here).

## Decisions

1. **Two version tables, as KOBE-45 decision 6 recommended.** `team_agent_versions` (team table:
   PK `(team_id, agent_id, version)`, FK `(team_id, agent_id) → team_agents`, ENABLE + FORCE RLS,
   probe fixture) and install-wide `install_agent_versions` (PK `(agent_id, version)`, FK →
   `install_agents`; app role **SELECT + INSERT only**). Columns per §5.4 plus `draft_revision`
   (the draft published; null for a rollback) and `republished_from` (rollback source; check: exactly
   one of the two, source < version). `current_version` is now a foreign key to its version
   (circular FK, like threads/thread_entries), so it always names an existing version.
2. **Immutability in the database:** trigger `agent_versions_immutable` refuses every UPDATE and
   every direct DELETE (55000) for any role, including the owner. The only delete that passes is a
   cascade from deleting the team (`pg_trigger_depth() > 1`). A `team_id` change is left to RLS
   (WITH CHECK → 42501, which the probe suite asserts).
3. **Thread pins:** `threads.agent_scope` (enum `team|personal|gallery`) plus generated columns
   `team_agent_id` / `install_agent_id`, with NO ACTION FKs `(team_id, team_agent_id, agent_version)
→ team_agent_versions` and `(install_agent_id, agent_version) → install_agent_versions`.
   `threads_agent_pin` check: scope, id and version all set or all null. Partial indexes
   `threads_team_agent_idx` / `threads_install_agent_idx` (inventory usage per version, KOBE-48; FK
   checks on a team's cascade). `agent_scope` is not on the wire (agent ids are unique; avoids
   touching KOBE-33's search mapping); the detail adds `agent_current_version`.
4. **Version numbers only grow; `current_version` is always the newest.** Publish and rollback lock
   the agent row (`FOR UPDATE`) and insert `current + 1` (PK backstop). Rollback "republishes an
   older version" as a **new** number (v1 → v3), with the manifest recomputed against today's floor,
   so "current" never moves backwards and threads pinned to v2 stay on v2.
5. **Rollback leaves the draft alone** (it may hold the fix in progress); the builder sees the draft
   differ from the current version.
6. **Publish requires If-Match** (the draft revision, `*` to override): 428 without, 412 if the
   draft moved on. Nobody publishes changes they haven't seen. The stored draft is re-validated
   before freezing (409 `invalid_draft` if an older schema let something through).
7. **Frozen tool manifest** (`agents/manifest.ts`, format 1, stored as jsonb, zod-validated on every
   read): built-in tools = registry ∩ `tools.allow` (empty = all) − whole-tool `tools.deny` −
   non-expiring whole-tool deny rules of the floor − MCP resource tools (unavailable in v1);
   `connectors` = the agent's requested connectors (MCP tools resolve at run time from pinned
   snapshots, KOBE-59); the agent's own `tools_allow`/`tools_deny` kept for per-call checks
   (argument shorthands); `excluded[]` with reason and rule id (for the builder/inventory UI);
   `approval_mode {requested, floor, effective}` with effective = strictest(requested ?? ask-on-write,
   floor). Ask rules, argument-pattern rules and expiring rules are never frozen: they stay live.
   - **Floor = install for personal and gallery agents** (they run in many teams: freezing one
     team's rules into them would carry that team's policy into others), **install + team for team
     agents.**
8. **When the floor changes after publish (spec decision):** the manifest is a **ceiling, never a
   grant** (HARD CONTRACT, KOBE-45 decision 10). At run time a call must be inside the manifest
   (`manifestAllowsTool`) **and** pass the live policy engine. So a floor that **tightens** applies
   to every pinned version at once (live deny/ask rules; `effectiveApprovalMode(manifest,
currentFloor)` raises the mode); a floor that **loosens** never widens a published version — the
   builder republishes (or rolls back, which republishes) to pick it up. New tools in the registry
   (a Pi patch, a kobe-tool) never appear in old versions. Reading of D19 "frozen tool manifest" +
   D6 "teams can only tighten".
9. **Approval floor** (D6 "minimum approval mode"): `install_settings['policy.approval_floor']`
   (`policy/approval-floor.ts`). No admin route writes it yet; absent = no floor (`auto`, which is
   allow-listed only, never a bypass); unreadable = `ask-all` (fail closed). Strictness: auto <
   ask-on-write < ask-all.
10. **Delete becomes archive** (`archived_at` on both agent tables): DELETE of a never-published
    agent still hard-deletes (204, `agent.deleted`); of a published one archives (200 with the
    agent, `agent.archived`; idempotent). Archived agents are hidden from `GET /v1/agents` unless
    `include_archived=true`, can't be edited (409 `agent_archived`), published, rolled back, or
    pinned by new threads/switches (409 `agent_unavailable`); **threads already pinned keep
    working** (archive retires, suspend is the kill switch). `POST /:id/unarchive` (edit right)
    restores. The FK backstop refuses deleting an agent with versions (23503).
11. **Authorization** (`AgentAccess.publish`, D8): team agents — `team.agents.publish` (builder) on
    own agents, team admins on any (`team.agents.manage`), same split as edit; personal — owner;
    gallery — install admins only, through `/v1/install/gallery/agents/{id}/publish|rollback|
versions|unarchive`. Version history (`GET …/versions`) for whoever sees the agent; a version's
    content (`GET …/versions/{n}`) for whoever may read the definition (members get 403 on team
    agents, as for drafts). Unarchive = edit.
12. **Pinning** (`agents/versions.ts`): `POST /v1/threads {agent_id}` pins the current version of a
    team agent of the active team, one of the caller's personal agents, or a gallery agent;
    unknown/invisible → 404 `agent_not_found`; suspended, archived or never published → 409
    `agent_unavailable`. `POST /v1/threads/{id}/agent-version {version?}` (owner only) switches to
    the current version (default) or any published version of the same agent; refused while a run
    is active (`thread_busy`; queued runs resolve the pin when promoted), with no agent
    (`no_agent`), unknown version (404 `version_not_found`), unavailable agent (409). Audited
    `thread.agent_switched`.
13. **Gallery forks copy the published version** (when there is one), not the curators' draft in
    progress. Team/personal forks still copy the draft (builders can read it anyway).
14. **Audit** (all `recordAudit` as the last write of the transaction): `agent.published`
    (`version`, `draftRevision`), `agent.rolled_back` (`version`, `fromVersion`), `agent.archived`,
    `agent.unarchived` (scope `any`: team view for team agents), `thread.agent_switched` (team).
    `docs/audit-log.md` updated.
15. **Code review (subagent): no CRITICAL/HIGH; MEDIUM fixed:**
    - the switch checks the thread's pinned scope (`resolveSwitchPin` takes the current pin);
    - pin paths take `FOR SHARE` on the agent row (`findPinnableAgent({ lock })`), so an archive,
      suspend or publish can't commit between the check and the pin (lock order thread → agent;
      agent changes never lock threads);
    - `versionAllowsCall(manifest, tool, input)`: the manifest plus the version's own deny/allow
      entries (MCP tools included) with the engine's matchers, for KOBE-36/47;
    - an unreadable stored manifest is `UnreadableVersionError` → 500 `version_unreadable` (logged
      with agent id and version) and `resolvePinnedAgent` → `version_unreadable`;
    - archived agents keep their slug but no longer count toward the per-location cap.
    - Noted, not changed: version history shows `publishedBy` user ids to members (team members
      are already listed to members); the trigger comment says no other trigger may delete
      versions.
16. **Coordinator DB review (PR #35, approve with changes), addressed:**
    - **M1 (no behaviour change):** the approval floor is install-wide only (D6: no team floor;
      teams tighten with ask/deny rules); absent floor = no minimum, consistent with D32
      scheduled runs in `auto`. Documented in `policy/approval-floor.ts` and `manifest.ts`.
    - **M2:** trigger `threads_agent_pin_owner` (0020, BEFORE INSERT/UPDATE OF agent_scope,
      agent_id, owner_user_id; one PK lookup): a personal/gallery pin must name an install agent
      of that scope, and a personal agent of the thread's owner (23514). Team pins are confined
      by their FK (includes team_id).
    - **M3:** per-agent version cap (`KOBE_AGENT_MAX_VERSIONS`, default 1000, 1–100000; 409
      `version_limit_reached`, rollbacks count); a publish/rollback whose definition **and**
      manifest equal the current version is 409 `unchanged` (a republish that only picks up a
      floor change is allowed); publishes + rollbacks share a per-user rate limit (30 / 10 min,
      `rate_limits` table, 429 `rate_limited`, checked before the cap).
    - **M4:** operator erasure procedure in `docs/agent-versions.md`; open question below.
    - **M5:** the migration adds two STORED generated columns, which **rewrites `threads`** under
      ACCESS EXCLUSIVE (fine pre-release). NOT VALID + VALIDATE was not used: drizzle's migrator
      runs all pending migrations in one transaction, so the rewrite's ACCESS EXCLUSIVE lock is
      held until commit anyway and a separate VALIDATE buys nothing; and `0019` is generated
      (`db:rebase` regenerates it from the schema, dropping hand edits). Post-release, a change
      like this needs its own expand migration.
    - **L1:** pins keep **FOR SHARE**, not FOR KEY SHARE: suspend, archive and publish are non-key
      UPDATEs (FOR NO KEY UPDATE), which conflict with FOR SHARE but not with FOR KEY SHARE, so
      KEY SHARE would let a suspend commit between the check and the pin. Test "holds the agent
      row while pinning…" (a suspend times out with 55P03 while a pin transaction is open; with
      FOR KEY SHARE the test fails: mutation-checked).
    - **L3:** gallery version history and detail show `publishedBy: null` to non-curators.
    - **L4:** catalog test pins the trigger set on both version tables and that no other public
      function names a version table (so the `pg_trigger_depth() > 1` escape can't widen).
    - **L2:** recorded here as asked (its text was not in the coordinator's message; flagged).
17. **Web:** install gallery console gets Publish (If-Match from the listed revision), Archive (for
    published agents) and Unarchive; team agents page lists archived agents with their status.
    `apiRequest` gained an `ifMatch` option. The builder/inventory UI is KOBE-48.

## For KOBE-47 (run-time resolution) — must know

- **BLOCKING:** `versionAllowsCall` (or at least `manifestAllowsTool`) and
  `effectiveApprovalMode` must be on the run-start path, with the pin read via
  `resolvePinnedAgent` **under the thread row lock inside the run-start transaction** (lock order
  thread → agent → run). Without that the manifest is advisory.

- Call `resolvePinnedAgent(tx, { teamId, userId: thread owner }, { agentScope, agentId,
agentVersion })` inside the run's `withTeam`. It returns the exact version or an error
  (`agent_not_found`, `version_not_found`, `agent_suspended`): **never fall back** to another
  version or the default agent. Archived agents still resolve (pinned threads keep working).
- Read `threads.agent_scope` with the pin (repository `summaryColumns` has it).
- Tool gate: deny any call with `!versionAllowsCall(version.toolManifest, tool, preparedInput)`
  **before** the policy engine (manifest + the version's own deny/allow, MCP tools included), then
  still pass `agent.tools_allow = manifest.tools_allow`, `tools_deny = manifest.tools_deny`,
  `version` to `PolicyInput.agent`. The manifest is a ceiling only.
- `resolvePinnedAgent` errors: `agent_not_found`, `version_not_found`, `version_unreadable`,
  `agent_suspended`. Pass `{ lock }`-style care if you need the agent row stable for the run start.
- Approval mode: `strictestApprovalMode(effectiveApprovalMode(manifest, await
readApprovalFloor(tx)), <thread/user mode>)`; scheduled runs stay `auto` (D32) but still only
  inside the manifest.
- Model/connectors/skills from `version.definition.frontmatter` (not the draft), intersected with
  the team (model → team default fallback).

## For KOBE-48 (builder, inventory)

- Agent responses carry `currentVersion`, `archivedAt`, `revision` (ETag). Publish:
  `POST /v1/agents/{id}/publish` with `If-Match: "<revision>"` → 201 `{agent, version, warnings}`.
  History: `GET …/versions?before=&limit=` → `{currentVersion, versions[], nextBefore}`; one
  version with manifest: `GET …/versions/{n}` (`toolManifest.excluded[]` explains what the floor or
  the agent removed). Rollback: `POST …/rollback {version}`. Archive: `DELETE` (200 when archived);
  `POST …/unarchive`. Inventory: `GET /v1/agents?scope=team&include_archived=true`; usage per
  version from `threads_team_agent_idx`.
- Thread view (KOBE-32): badge when `agent_current_version > agent_version`; button →
  `POST /v1/threads/{id}/agent-version {}`.

## Open questions (for Chris or the coordinator)

- **Erasure of versions (part of the pending retention/erasure question).** Versions are
  immutable and never deleted by the app, so personal prompts of deactivated users live on. Today
  the only path is the operator procedure in `docs/agent-versions.md` (disable trigger → remove
  pins/threads → delete versions → delete agent). Should Kobe offer an audited erasure (e.g. with
  KOBE-18 retention / deactivation)?
- `KOBE_AGENT_MAX_VERSIONS` is not exposed as a Helm value yet (default applies).

- **Floor change semantics** (decision 8): tightening live, loosening needs a republish. The
  alternative (re-derive the manifest at every run) would make "frozen" meaningless; flagged.
- **Approval floor storage** (decision 9): read from `install_settings`, default none; the install
  policy console (KOBE-35 follow-up or KOBE-20) should add the write route + audit.
- **Archived agents keep serving pinned threads.** If archive should also stop runs, KOBE-47
  should refuse `archivedAt` like `suspended`.
- **Gallery drafts are visible to all members** (KOBE-45 behaviour). With versions, members could
  be limited to the published version of gallery agents; not changed here (KOBE-48).
- **MCP connectors in the manifest are the requested list**, not checked against the connector
  registry (KOBE-59 does not exist yet). A whole-connector deny rule is enforced live, not frozen.
- Orbit gate (D20) on publish is Phase 4 (not built; `publishAgent` is where it would hook).

## Evidence (acceptance criteria → test or command output)

- Review round 2: `agent-versions.db.test.ts` (db) › "confines personal pins…", "lets anyone
  pin a gallery agent", "catalog: version tables' triggers"; (server) › "serializes concurrent
  publishes and rollbacks", "refuses to publish a draft identical…", "holds the agent row while
  pinning…"; `agent-version-limits.db.test.ts` (cap incl. rollback, per-user rate limit);
  `config.test.ts`.
- ac-1: `packages/db/src/agent-versions.db.test.ts` (UPDATE/DELETE refused 55000 for app and owner
  roles; app role has no UPDATE/DELETE on install versions 42501; duplicate version 23505; agent
  with versions can't be deleted 23503; `current_version` must exist 23503; origin checks; RLS).
  `services/server/src/agent-versions.db.test.ts` › "serializes concurrent publishes and
  rollbacks" (3 parallel distinct → v4..v6; 5 parallel identical → one version, four
  `unchanged`; **mutation check:** without the row lock the original test failed),
  › "keeps published versions immutable while the draft moves on".
- ac-2: `src/agents/manifest.test.ts` (19: allow narrows, `*` adds nothing, deny wins, floor
  rules, install-only floor, live-only rules, expired rules, malformed glob fails closed, approval
  clamps, run-time helpers); DB › "frozen manifest against the floor" (install + team deny rules
  excluded with rule ids, approval floor clamps `auto`, personal agent only install floor, rule
  removed → v1 unchanged, v2 picks it up). `src/policy/approval-floor.test.ts`.
- ac-3: › "publish" (If-Match 428/412, member/other builder 403, team admin any, personal,
  gallery only via install console), › "version history" (paging, member history but 403 on
  content, team wall for a member of both teams), › "rollback"; `src/agents/access.test.ts`.
- ac-4 / Gate 3: › "v2 publish leaves v1 threads pinned, badges v2, and rollback works" (v1 thread
  stays v1, `agent_current_version` 2, new thread v2, rollback → v3, old pins unchanged, new
  thread v3, `resolvePinnedAgent` returns v1's content); › "switches a thread …"; › "refuses to
  switch …"; › "pins only agents the caller can use" (unpublished 409, others' personal 404,
  other team 404, gallery after publish); DB › "threads pin a published version" (FK per scope,
  cross-team 23503, wrong scope, survives v2, team cascade).
- ac-5: › "archive instead of delete" (draft-only 204; published 200 + hidden + read-only +
  unpinnable + pinned thread intact + unarchive; gallery archive).
- ac-6: probe suite and catalog check cover `team_agent_versions`; `src/agents/store.db.test.ts`
  (every version function applies the personal owner filter; Bob can neither pin nor resolve
  Alice's personal agent).
- ac-7: audit rows asserted for publish, rollback, archive, unarchive, switch; `audit/events.test`
  (docs table covers every action).
- ac-8: `resolvePinnedAgent` in `agents/versions.ts` (tests above, incl. `agent_suspended`,
  `version_unreadable` › "a version whose manifest can't be read").
- Commands: see the PR body.
