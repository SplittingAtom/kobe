# KOBE-122: Chat agent picker

- **Status:** in review
- **Branch / worktree:** `kobe-122-chat-agent-picker` in `../Kobe-wt122`
- **Depends on:** KOBE-86 (suspension), KOBE-76 (pinning), KOBE-44 (model picker)

## Plan

New-chat picker of the agents the user can run in the current team; selected agent goes to
`POST /v1/threads` as `agent_id`; pinned model locks the model picker; header names the agent.

## Decisions

- **New endpoint `GET /v1/agents/runnable`** (`services/server/src/agents/runnable.ts`, mounted in
  `routes/agents.ts` before `/:id`). Nothing existing fit: `GET /v1/agents` ignores team suspension
  (and lists drafts and unpublished agents); `/inventory` is admin-only and only lists used agents.
- Runnable = exactly what thread create can pin (`findPinnableAgent` + `unavailable`): team agents
  of the active team, the caller's own personal agents, gallery agents; status `active`, not
  archived, published; install-wide agents also hidden when the team suspended them
  (`team_agent_suspensions`). A db test asserts every listed agent starts a thread and hidden ones
  are refused.
- `model` comes from the **current published version** (what a new thread pins), not the draft.
- Paginated by (slug, id) keyset, `limit` 1..200 default 50, same cursor format as the inventory.
  Filtering and paging are in memory over the capped lists (500/100/100); versions read only for
  the page. `team_id` explicit on top of `withTeam()`.
- Web: `AgentPicker` is a native radio group ("Chat with"; No agent default), shown only for a
  conversation not created yet and not in the builder test pane. The draft agent lives in
  `ChatSession` like the draft model. A pinned agent's model is not sent on create (server wins).
- Header chip "Agent: name" plus Suspended/Archived badge come from the thread detail (`agent_name`, `agent_status`, effective in the team); a new chat shows the draft agent's name.
- Chat reads the list with limit 200 and follows `next_cursor` (at most 10 pages).

## Open questions (for Chris or the coordinator)

- Gallery is empty on main until KOBE-87 seeds it; the picker then shows only team/personal agents.

## Evidence (acceptance criteria → test or command output)

- ac-1 (start a chat with any runnable agent): `src/agents-runnable.db.test.ts` (listing, member
  access, listed agents can start threads), `components/chat/agent-picker.test.tsx` (create sends
  `agent_id`, header shows the name).
- ac-2 (suspended/archived hidden, pinned disables model picker): db test (team and personal
  suspended, gallery suspended per team and reactivated, archived, unpublished, other team);
  web test "disables the model picker ... sends no model".
- Runnable and pin rules are shared: `canPinAgent` and `installVisibleTo` in `agents/versions.ts`
  are used by both `findPinnableAgent` and `listRunnableAgents`.
- Thread detail test: `agents-runnable.db.test.ts` "thread detail names the pinned agent".
