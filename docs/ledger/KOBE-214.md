# KOBE-214: B10: Enable root branching (finish the KOBE-32 follow-up)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR #)
- **Branch / worktree:** `kobe-214-root-branching` in `../Kobe-wt214`
- **Depends on:** KOBE-32 (chat runtime), KOBE-213 (compaction entries in the history)

## Plan

1. Find out whether the server, protocol or sandbox agent must change for a root branch.
2. Tests first: edit the first message, the picker across roots, reload, regenerate the first
   answer, with a compaction in the history.
3. Remove `ROOT_BRANCHING_AVAILABLE` / `ROOT_BRANCHING_PENDING` and the `PendingAction`
   placeholders.

## Decisions

1. **No server, protocol or sandbox-agent change.** Pi 1.0 writes a settings entry
   (`thinking_level_change` / `model_change`) at the root of every session before the first
   prompt (see `services/server/src/runs-interrupted.db.test.ts` `rootSettingsEntry`). The first
   prompt's parent is that entry, so editing it sends `parent_entry_id` = the root settings entry.
   The sandbox agent appends its `kobe.branch` marker under it. The new prompt is a sibling root
   in the projection, because hidden entries at the root are not nodes. The gate1 database
   confirms this (read-only query, 2026-10-14): all 139 threads have exactly one root entry, and
   it is a settings entry. No user message has a null parent. 18 `kobe.branch` markers already
   sit directly under a root, so first-message edits already worked there. The "coming soon" state
   only showed for test fixtures whose first prompt had a null parent.
2. **A prompt with no entry above it** cannot occur with Pi 1.0. It shows no Edit or Regenerate,
   because `parent_entry_id` cannot name "the root itself": absent means the leaf. Supporting it
   would need `parent_entry_id: null` in `submitMessageBody` and `run.start`, plus a sandbox-agent
   marker with `parentId: null`. That is not done, since no real thread needs it. `branchAndSend`
   keeps `CANNOT_BRANCH` as a guard, with a reworded message.
3. **Compaction (KOBE-213):** a trailing `compaction` entry belongs to its branch's last message,
   so its marker is shown only on that root. Choosing that root sets the leaf to the compaction
   entry (`lastEntryOfNode`), and Pi continues after the compaction.
4. **ac-3:** a branch switch posts `/leaf`, which is persisted in `threads.leaf_entry_id`. On
   reload the projection's head is the leaf's message, so the chosen root stays.
5. Test fixtures gain Pi's root settings entry (`branchedThread`, `thread-style.test.tsx`). The
   fake gets `agent.branchMarker()`, which works like the sandbox agent's `kobe.branch` entry.

## Open questions (for Chris or the coordinator)

- The context gauge reads the newest model call across the whole thread, not per branch. After a
  switch to another root it can show the other branch's size. This applies to all branching, not
  only root branching. Follow-up if wanted.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `conversation.test.tsx` › "root branches" › "editing the first message starts a
  sibling root, the picker switches roots and a reload keeps the choice"; "Regenerate on the
  first answer branches from the root".
- **ac-2** `lib/chat/features.ts` deleted; `PendingAction` removed from `messages.tsx`; tests
  updated (`conversation.test.tsx` D15 branches, `thread-style.test.tsx`); "a first message with
  no entry above it … offers neither Edit nor Regenerate".
- **ac-3** same root test: unmount + reopen shows the chosen root (both directions), with the leaf
  persisted (`leaf_entry_id` = compaction entry / new answer).
- `pnpm verify` green; CI on the PR.
