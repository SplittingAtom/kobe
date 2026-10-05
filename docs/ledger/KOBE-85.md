# KOBE-85: 48b: Builder test pane: chat with the draft, test threads flagged

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-85-builder-test-pane` in `../Kobe-wt85`
- **Depends on:** KOBE-84/97 (builders), KOBE-76 (run-start resolver), KOBE-86 (inventory)

## Plan

- Migration `0058_threads_test_flag`: `threads.is_test boolean NOT NULL DEFAULT false`; `threads_agent_pin`
  now also allows `agent_id` set with `agent_version` null **only when `is_test`** (the draft pin; the
  version foreign keys are MATCH SIMPLE, so null skips them); `threads_test_private`: a test thread has
  no project and is never shared. No RLS change (same table, `team_id` rules unchanged).
- `POST /v1/threads {agent_id, test: true}`: pins the draft (`resolveDraftPin`), only for someone who may
  edit the agent (`agentAccess(...).edit`; otherwise 404 `agent_not_found`), not suspended/archived.
  Needs `agent_id`, no `project_id` (400). Response gains `is_test` (additive).
- Run start: `PINNED_AGENTS` takes the draft path when the pin has no version
  (`resolveDraftAgent`): the draft as it is at that moment (edits show in the next run), manifest
  computed as at publish against today's floor, then the same resolver, floor clamp, budgets, policy,
  isolation gate. `run.started` carries `agent_id` and `agent_version: null` (schema already allowed
  it); the sandbox wire gets `agent: null` (its schema wants a positive version).
- `DELETE /v1/threads/test[?agent_id=]`: the caller clears their own test threads (soft delete,
  skipping threads with a queued or active run). Not audited (throwaway, private).
- Web: `AgentTestPane` (restyled chat #65: `ThreadView` + runtime, no sidebar) in the builder for team
  and personal scope, for saved agents the server says `canEdit`; "New test chat", "Clear test chats".

## Decisions

- Where test threads are excluded: thread list, Trash list, search (`thread-search.ts`), project
  sharing (constraint), inventory "used" for personal/gallery agents and inventory run counts / last
  run (`agents/inventory.ts`). Still readable by id (the pane reloads them).
- Money is real: `run_usage`, budgets and the models usage report are untouched, so test runs count
  there (the inventory token total includes them for the same reason).
- Soft delete, not hard delete, for clearing: runs and `run_usage` rows must stay, and the retention
  purge removes the rows after the Trash window like any thread. Retention itself is unchanged.
- Break-glass reads still see test threads (incident reads show everything); `BreakGlassThread` gained `isTest`.
- The agent's prompt was never passed to Pi on any run (nothing set `config.system_prompt`), so the
  resolver now sets it from the version (or draft) prompt for every pinned run. Needed for "chats
  with the draft" to mean anything. **Behaviour change for published agents** (coordinator confirmed).
- No protocol package change.

## Review fixes (Opus)

- HIGH: `resolveDraftAgent` re-checks at every run start that the thread owner still has
  `agentAccess(...).edit` (current team role from `team_members`, ownership) and refuses archived
  agents; the run fails `agent_unavailable`. Tests: demoted creator, archived agent.
- MEDIUM: one prompt limit, `SYSTEM_PROMPT_MAX_BYTES` (100 KiB, UTF-8 bytes) in `@kobe/protocol`, used
  by the agent file and the wire's `system_prompt` (was 100,000 chars). Boundary tests in
  `frames.test.ts` and the db test.
- MEDIUM: `run.started` gains optional `draft_revision` (additive) for draft runs. Run starts have no
  separate audit event; the run event stream is the record.

## Open questions

- `switchAgentVersion` on a test thread answers `no_agent` (it has no version); fine, the UI never offers it.
- Test threads of a deleted-then-purged agent: the draft pin has no version FK; the run fails
  `agent_unavailable` like a missing agent.
- The builder page now loads `chat-global.css` (scoped to `[data-kobe-chat]`; its `body:has(...)`
  rule zeroes the body margin on pages with the pane open only).

## Evidence

- ac-1 chats with the draft: `services/server/src/thread-test-pane.db.test.ts` (draft model, mode and
  prompt reach `run.start`; follows edits; published version unaffected for normal threads; model not
  enabled fails like any run; edit right needed); web: `agent-builder/test-pane.test.tsx`.
- ac-2 flagged and kept out of lists: same db test (list, search, Trash, sharing, clear, inventory).
- `pnpm verify`, `test:db` for `@kobe/server` and `@kobe/db` (probe suite) green locally.
