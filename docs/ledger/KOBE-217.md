# KOBE-217: B13: Regenerate with another model

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #283)
- **Branch / worktree:** `kobe-217-regenerate-model` in `../Kobe-wt217`
- **Depends on:** KOBE-209 (markers), KOBE-214 (root branching, `branchPoint`), KOBE-44 (thread model)

## Plan

1. Find how a run gets its model today, and whether a per-regenerate model needs a server or
   protocol change.
2. Tests first (`components/chat/regenerate-with.test.tsx`), then a split button beside Regenerate.

## Decisions

1. **No server or protocol change.** `POST /v1/threads/{id}/messages` carries `content`,
   `parent_entry_id` and `file_ids`, with no model. The run's model is the thread's
   (`threads.model_alias`, `PATCH /v1/threads/{id} {model}`, KOBE-44), or the agent's pin. CE17 says
   "Regenerate with another model switches the thread" and rejects a one-off model per message.
   So "Regenerate with…" is `ThreadController.regenerateWith(model, text, parentEntryId)`. It
   calls `setModel` (the picker's call), then `send` from the same `branchPoint` as Regenerate,
   root included. That branch and the turns after it use the new model. **It does change the
   thread's current model, the same as the picker.**
2. **Marker placement comes from the sandbox agent's order.** On `run.start` with
   `parent_entry_id`, it appends the `kobe.branch` marker under the branch point and starts Pi.
   The `kobe-models` extension then calls `setModel` on `input`, before the prompt is stored. So
   Pi's `model_change` sits between the marker and the new prompt. The tree shows it as
   `meta.before` of the new sibling, only on that branch (KOBE-209). The fake gets
   `agent.modelChange(runId, modelId)` and records `run.model` (the agent's pin, else the thread's
   choice) for the test.
3. **The menu.** It uses assistant-ui's `ActionBarMorePrimitive` (Radix DropdownMenu, which keeps
   the action bar shown while it is open), and its trigger is the new registry command
   `regenerate-with` ("Regenerate with…"). It lists "Team default (…)" and the enabled models,
   with the thread's choice marked "(current)". The rules (enabled filter, null = follow the
   default, agent pin, unavailable choice) live in `lib/chat/model-choices.ts`, shared with the
   picker. The team default entry sends `model: null` (or no `PATCH` when already null), so it
   never pins the default's alias. The current choice regenerates without a `PATCH`.
4. **When it is offered** (review of #283). It shows once the summary is read. It is hidden for a
   pinned agent's thread, when no model is enabled or the list is unknown, and wherever
   Regenerate is hidden (read-only, no branch point). It is disabled under `canRegenerateWith`
   (`thread-state.ts`), which uses Regenerate's conditions (run going, message being sent,
   Trash, not read) plus a queued run (the `PATCH` would apply to it too) and a model change in
   flight. The controller checks the same predicate before it starts. `setModel` marks the thread
   busy synchronously, so a second choice is refused, and a local ref guards the menu as well.
5. **Failures.** A refused model (`model_not_enabled`, the server's fixed text) shows in the
   thread banner, and nothing runs. If the `PATCH` succeeds but the message doesn't go, the
   previous model is put back and the send's failure stays in the banner (or "could not be
   regenerated, so the model was not changed"). A throw is reported as a client error. The thread
   is never left switched without a new version.
6. **Team models once per thread.** `TeamModelsProvider` (`use-team-models.tsx`, mounted in
   `chat-app.tsx`) loads them once for the thread on screen. The picker, the gauge and every
   answer's menu read `useThreadTeamModels()`, so a failure refetch happens once.
7. **Gauge.** It needs no change. The scale is the thread's model, so it re-scales as soon as
   `setModel` returns. The tokens come from the newest call: the streamed run, then the
   `run_usage` read after it ends, which is the new version's call. The KOBE-214 limitation still
   applies when you later switch to another version: the gauge keeps showing the newest call.

## Open questions (for Chris or the coordinator)

- None blocking. The KOBE-214 gauge follow-up (gauge per branch shown) still stands.

## Evidence (acceptance criteria → test or command output)

`apps/web/components/chat/regenerate-with.test.tsx`:

- **ac-1** "switches the thread's model, then regenerates as a sibling with a model marker above
  it": `PATCH {model: glm}` comes before `POST /messages {content, parent_entry_id: root}`, the run
  ran on `glm`, the result is "Version 2 of 2", the `model` marker comes before the prompt in the
  DOM, the picker shows `glm`, and the first version shows no marker.
- **ac-2** "offers the team's enabled models only…" (the disabled `gpt` is not listed); "is hidden
  for a pinned agent's thread; Regenerate stays"; "is hidden on a thread shared read-only"; "a
  model disabled since the list was read fails with the server's error and nothing runs".
- **ac-3** "switching back is a visible marker of its own": regenerating with Kimi after GLM
  gives "Version 3 of 3", with a `kimi` marker above the prompt, and the picker shows `kimi`.
- Gauge: "the gauge re-scales to the new model and then reads the new version's call".
- Review fixes: `lib/chat/regenerate-with.test.ts` (`canRegenerateWith` cases; controller: no race,
  default = null, refused model, restore after a failed send, a throw). UI: "is disabled like
  Regenerate for a thread in Trash", "the team default entry…", "a regenerate that can't be
  sent puts the model back and shows why". `lib/chat/model-choices.test.ts`.
- `pnpm verify` green. No server change, so `test:db` was not needed.
