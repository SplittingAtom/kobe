# KOBE-158: 56f: Web: memory panel, Undo chip and admin switches, e2e

- **Status:** in review
- **Branch / worktree:** `kobe-158-memory-panel-web` in `../Kobe-wt158`
- **Depends on:** [KOBE-155](KOBE-155.md) (panel API), [KOBE-156](KOBE-156.md), [KOBE-157](KOBE-157.md). No migration.

## Plan

`apps/web` and `e2e` only. Chip with Undo, memory panel, team and install switches, plain-text
rendering of memory and `remember` approval content (KOBE-157 review).

## Decisions

- **Chip** (`chat/memory-notice.tsx`, replaces the `memory.updated` case in `NoticeSlot`): Undo calls
  `ChatApi.undoMemory`, which uses `undoMemoryAction` from the protocol: `POST /v1/memory/:id/restore
{version: previous_version}`, or `DELETE /v1/memory/:id` when the write created the doc. The server does
  not check the doc is still at the event's version (KOBE-155), so Undo restores even after later edits.
- **Panel** (`components/memory/`, page `/me/memory`, link "My memory" in the chat header): list, open, edit
  (sends `expected_version`, 409 explained), delete (confirm), version history with Restore. Project scope:
  `/me/memory?project=<uuid>` renders the same panel with `scope=project&project_id=`. There is no project
  list in the web yet (KOBE-57/160), so no project picker; until then the API refuses every project doc.
- **Plain text only:** content, paths and the chip path are React text nodes (`<pre>`), never markdown or
  HTML (the markdown renderer is not used), and `visible()` (moved to `lib/security/visible.ts`, re-exported
  from `approval-card.tsx`) shows controls, bidi and zero-width characters as `\uXXXX`. The editor warns when
  the text has hidden characters (they are kept on save: a textarea cannot show them).
- **`remember` approval card:** a structured view ("Saved to project memory in <path> (added to the end | replaces the
  file)") with the content as escaped plain text, labelled "Memory to store". Other tools still show JSON.
- **Provenance:** the panel API has no `written_by`; it gives each version's `source` (agent, approval, panel,
  restore), shown in the header line and the history. Names of authors/approvers are not in the API (migration).
- **Switches:** team page `/admin/team/memory` (permission `team.memory.manage`, two checkboxes, project
  needs memory) and an install section on Settings (`install.settings.manage`), both on `/v1/memory/settings`.
  The brief's "user" switch does not exist in the API (levels are team and install), so there are two levels.
- **e2e** (`e2e/run.sh`, section "memory (KOBE-158)"): remember twice, `memory.updated` carries the previous
  version, restore returns the first content as a new version, delete of a created doc is 204 then 404, another
  member gets 404; with memory off the next run lists no remember/recall and has no index; back on restores them.
- **Test-only additions outside apps/web:** the fake model answers `tools?` with the names of the tools the
  request offers (`services/model-gateway/src/testing/fake-llm.ts`, tested); `chat_run` prints
  `memory_events`; `file_fetch` takes an optional JSON body. No server or sandbox-agent change.

## Open questions (for Chris or the coordinator)

- The e2e could not be run locally (needs the k3d cluster); the "system?" echo is cut at 40 000 characters, so the
  index check assumes Pi's system prompt plus skills stays below that.
- A "user" admin switch (per-person opt-out) is not in the contract; say if one is wanted (needs API and DB).
- Panel for project memory needs a project picker once projects exist in the web.

## Evidence

- ac-1: `chat/memory-notice.test.tsx` (restore, delete for a created doc, error and retry, plain-text path);
  e2e "memory: Undo (restore version 1)..." and "Undo restored the prior content".
- ac-2: `me/my-memory.test.tsx` (list, open with provenance, edit with expected_version, conflict, delete,
  cancel, restore, plain text, project, disabled).
- ac-3: `admin/memory-switches.test.tsx` (team, project, install, refusal); e2e "memory off: ..." lines.
- Plain text: `chat/approvals.test.tsx` "remember", `my-memory.test.tsx` "shows content as plain text".
