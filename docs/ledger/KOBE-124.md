# KOBE-124: Preselect the gallery Assistant as the default agent

- **Status:** in review
- **Branch / worktree:** `kobe-124-default-assistant` in `../Kobe-wt124`
- **Depends on:** KOBE-89, KOBE-122. **Migrations:** none.

## Decisions

- `GET /v1/agents/runnable` now returns `galleryKey` for gallery agents (from
  `install_agents.gallery_key`); the web identifies the Assistant by key `assistant`, never by name.
- `ChatSession` computes the default when the runnable list loads: the gallery agent with that key,
  else none (suspended/archived/unpublished agents are not in the list, so they fall back to No agent).
  It is applied to the draft until the user picks anything (including No agent); each new chat
  starts again from the default.
- **Team-configurable default agent: out of scope.** There is no existing team settings JSON to hold
  it; it would need a column or table (migration), which this ticket forbids.

## Evidence

- ac-1/ac-2: `apps/web/components/chat/default-agent.test.tsx` (preselected by key, fallback, user
  override); `services/server/src/agents-runnable.db.test.ts` (galleryKey in the list).
