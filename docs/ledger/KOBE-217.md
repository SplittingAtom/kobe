# KOBE-217: B13: Regenerate with another model

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #)
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
   So "Regenerate with…" is: `controller.setModel(alias)` (the picker's call), then assistant-ui's
   `message.reload()` (the same `onReload` → `branchAndSend` → `branchPoint` as Regenerate, root
   included). The run is per-run only in the sense CE17 wants: that branch and the turns after it
   use the new model. **It does change the thread's current model, the same as the picker.**
2. **Marker placement comes from the sandbox agent's order.** On `run.start` with
   `parent_entry_id`, it appends the `kobe.branch` marker under the branch point and starts Pi.
   The `kobe-models` extension then calls `setModel` on `input`, before the prompt is stored. So
   Pi's `model_change` sits between the marker and the new prompt. The tree shows it as
   `meta.before` of the new sibling, only on that branch (KOBE-209). The fake gets
   `agent.modelChange(runId, modelId)` and records `run.model` (the agent's pin, else the thread's
   choice) for the test.
3. **The menu.** It uses assistant-ui's `ActionBarMorePrimitive` (Radix DropdownMenu, which keeps
   the action bar shown while it is open), and its trigger is the new registry command
   `regenerate-with` ("Regenerate with…"). It lists the team's enabled models (`useTeamModels`,
   cached by the session). The thread's current model (its choice, else the team default) is
   marked "(current)". Choosing it regenerates without a `PATCH`, so a thread on the team
   default stays on the default.
4. **Hidden** for a pinned agent's thread (`state.agentModel`), when no model is enabled or the
   list can't be read, and wherever Regenerate is hidden (read-only threads, no branch point).
5. **Refusal.** A model disabled after the list was read gets the server's fixed
   `model_not_enabled` text, shown in the thread's error banner (`controller.#fail`). Nothing runs
   and the thread's model is unchanged.
6. **Gauge.** It needs no change. The scale is the thread's model, so it re-scales as soon as
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
- `pnpm verify` green (web: 116 files, 1131 tests). No server change, so `test:db` was not needed.
