# KOBE-458: A thread started by launching an app from the rail has no agent, so its runs get no connectors

- **Status:** in review (group G11d, branch `group-11d-app-launch-agent`, not pushed)
- **Branch / worktree:** `group-11d-app-launch-agent` in `../Kobe-wt458`, from main cc055170
- **Depends on:** KOBE-440 (rail launch), KOBE-451 (run connector set, connectors off), KOBE-450

## Cause

`launchAppCard` created the new thread with `agent: null`. A run with no agent takes
`requiredOnly` in `runs/agents.ts`: Required skills, no MCP servers, so `runs.mcp_connector_ids`
was `{}`. A new conversation from the composer gets the agent the web preselected (gallery Kobe,
`session.ts` `#applyDefaultAgent`, matching `galleryKey === "kobe"` in the browser).

## Decisions

- **One rule, on the server:** `services/server/src/agents/default-agent.ts`.
  `isDefaultNewThreadAgent` (gallery + key `kobe`) and `defaultNewThreadPin(tx, viewer)` (the
  Kobe row, then `resolveAgentPin`: the same visibility, team suspension, archive and published
  checks as `POST /v1/threads`; anything else gives no agent, never an error).
  - `GET /v1/agents/runnable` marks that agent `default: true`; the web preselects
    `a.default === true` (its copy of the key, `DEFAULT_AGENT_GALLERY_KEY`, is gone).
  - A rail launch's new thread pins `defaultNewThreadPin` (`apps/app-cards.ts`).
  - The skill-eval `kobePin` now delegates to it (same semantics). The Workbench test chat's
    own Kobe lookup (`test-chat.ts`) is a different rule (always Kobe) and stays.
- **ac-3 was broken:** a started thread showed a fixed chip, so an agentless thread could never
  take an agent; worse, the chip named the draft's default ("Agent: Kobe") on a thread that had
  none. Fixed with `POST /v1/threads/:id/agent {agent_id}` (`threads/choose-agent.ts`): owner
  only, agentless threads only (`agent_already_chosen` otherwise; versions still move with
  `/agent-version`), not test threads or Trash, refused while a run is active, pinned through
  `resolveAgentPin` exactly as at creation, audited `thread.agent_chosen` (db audit events +
  `docs/audit-log.md`). The web keeps the Agent picker for the owner's agentless started
  thread (`ThreadAgentPickerMenu`); choosing calls it, then the chip names the agent. The chip
  no longer shows the draft's choice once the thread exists.
- **No access widened:** the run path is unchanged. A thread with an agent resolves the pinned
  version through `resolveEffective`: the agent's `tools`/`connectors`, the team's exposure, the
  owner's grants, the thread's connectors-off, and `runs.mcp_connector_ids` enforced by the MCP
  decision point (KOBE-451 HIGH-1). No migration.

## Security notes

- Choosing an agent later is equivalent to starting a new thread with it (same pin check, owner
  only, team-scoped update with `team_id` explicit, `agent_id IS NULL` guard in the UPDATE).
- A suspended/archived/unpublished or someone else's personal agent: `agent_not_found` /
  `agent_unavailable`; a reader: `read_only`; a stranger: `thread_not_found`.

## Open questions (for Chris or the coordinator)

- Product: is "an agentless thread may take an agent once" acceptable under D19 ("threads pin
  the version they started on")? It only applies to threads that started on no agent.
- The ten agentless app-launch threads on gate1 are not changed; their owners can pick an agent
  in the composer after deploy.

## Evidence (acceptance criteria → test)

- ac-1: `services/server/src/app-launch-agent.db.test.ts` "pins the agent the runnable list marks
  default" (thread row + read `agent_id`/`agent_name`); suspended default → no agent.
  Failed with the old `agent: null` (2 of 5 red), green after.
- ac-2: same file, "offers the member's connectors, the app's own included, on the first run"
  (`run.start` `config.mcp_servers` and `runs.mcp_connector_ids` = the app's connector).
- ac-3: same file, "gives later runs that agent's connectors" (first run `{}`, after
  `POST /agent` the next run has the connector) and the refusals; web
  `apps/web/components/chat/thread-agent.test.tsx`; `default-agent.test.tsx` (preselect by the
  server's flag).
- ac-4: `e2e/browser/tests/gate-apps/explorer.spec.ts` "from the rail with no thread open …
  (KOBE-458)": rail launch in a new conversation, thread `agent_id` = the runnable `default`,
  chip names it, the follow-up `OPEN` prompt makes the model call the app connector's tool (an
  app result with a `tool_call_id`). Runs on gate1 after deploy (env as the other gate-apps
  specs); typechecked here.
- `pnpm verify`: format, lint, typecheck, unit tests (web 239 files, server 168), licence, hygiene
  green; `test:db` server 169 files / 2096 tests and db 87 / 1550 green. `@kobe/cli` backup db
  tests (2 files) fail locally with ENOENT even with `KOBE_PG_BIN_DIR` set (local pg tools; the
  CLI is untouched). `openapi.json` regenerated for `POST /v1/threads/{id}/agent`.
