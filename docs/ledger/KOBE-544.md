# KOBE-544: Tree: the local head (web) (CT-3)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (not pushed; the coordinator opens the group PR)
- **Branch / worktree:** `kobe-544-local-head` in `../Kobe-wt544`, from `kobe-542-tree-protocol`
- **Depends on:** KOBE-542 (protocol shapes); KOBE-543 (server: `leaf_entry_id` on the wire,
  `thread_busy` under queued runs) runs in parallel; built against the protocol and the fake.

## Plan

1. Pure rules (`lib/chat/head.ts`): `headOf`, `isBrowsing`, `settleHead`, `branchLeafOf`,
   `onBranchOf`, `messagesDiffer`, `branchContextTokens`.
2. Controller: `ThreadState.head` (absent = follows the leaf) and `reveal`; `showBranch`
   (tree, KOBE-546), `showVersion` (reader picker), `showLeaf` (✕), `showHit` (CT15),
   `makeCurrent`; sends from a browsed branch; `thread.updated.leaf_entry_id`.
3. UI: runtime projects from the head; reader picker → `showVersion`; `BranchBar` under the
   lineage strip; composer note; gauge follows the head; search hits open on their branch.

## Decisions

- The head is stored only while it differs from the leaf (`state.head`); `#set` runs
  `settleHead`, so any leaf move that reaches the head (Make it current, a send's commit,
  another tab's move) makes the tab follow the leaf again. A head at the leaf therefore
  follows every leaf move by construction (CT13).
- "N messages differ" = messages on the head's branch that the leaf's branch does not have
  (the ones on screen that would change), counted by projected message, not by entry.
- While browsing, the live overlay is withheld: a run streams on the leaf's branch, so the
  browsed branch shows without it. A send clears the head optimistically (restored if the POST
  fails), so the sending overlay shows under the browsed branch as an edit does today.
- A send from a browsed branch sends `parent_entry_id` = the head (the branch's last entry);
  on the leaf's branch the body is unchanged (no parent).
- The owner's picker keeps `switchLeaf` (Q21) and clears the head; the reader's picker calls
  `showVersion(entry)` (the exact entry assistant-ui chose, no descent). `showBranch` and search
  hits descend to the newest leaf below the entry (`branchLeafOf`, by seq).
- Make it current: one `POST /leaf` with the head; `thread_busy` → the bar's note
  `LEAF_BUSY_NOTE` ("…wait for the queued runs…"), no retry, no error banner; other refusals
  (Trash, 429) go to the thread's error notice. Announces "This branch is now current".
- CT16: the bar shows `OVER_WINDOW_NOTE` while the head's branch (newest call's prompt on that
  branch, `branchContextTokens`) exceeds the thread model's window (`threadScale`, shared with
  the gauge); Make it current proceeds. Scheduled thread (`summary.scheduleId`): schedule note.
- CT6: `BranchBar` takes a `filesChanged` node (KOBE-545/546 fill it).
- Search hits: `session.openHit(threadId, entryId)` (Threads panel rows by click capture, the
  bar's search by its button) hands the hit to the controller (now, or on acquire; before the
  read it waits for it). The rail's "on another branch" note comes from `SearchHitStore`, which
  learns from the thread's entries once it has been read in this tab (no new read, CT1).
- Scroll to the hit: `useReveal` finds assistant-ui's `data-message-id` of the hit's node.
- Fake server: leaf route refuses readers (403 `read_only`) and queued runs (`thread_busy`), as
  the server will (KOBE-543); `agent.leafMoved` emits `thread.updated` with `leaf_entry_id`;
  search matches message text and answers `matched_entry_id`.
- Test threads (builder test, Workbench, eval) run `useKobeRuntime` + `ThreadView`, so they get
  the head and the bar with no extra code.

## Open questions (for Chris or the coordinator)

- The rail's "on another branch" note shows only for threads read in this tab (opened once);
  the search answer alone cannot tell. A server flag on the hit would make it immediate.
- Follow-up chips stay while browsing (they belong to the leaf's answer); hide them then?
- `thread.updated` arrives only on run streams; a leaf move with no run open in a tab still
  relies on the focus re-read (CT13's fallback), unchanged.

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/chat/branch-head.test.tsx` "a reader's arrows move only the head…",
  "the owner's arrows still move the leaf…"; `lib/chat/thread-head.test.ts` reader case.
- ac-2: `branch-head.test.tsx` "Make it current posts the leaf once…", "under a queued run…",
  ✕ in the reader test; `thread-head.test.ts` Make it current / queued cases.
- ac-3: `branch-head.test.tsx` "continues the head's last entry…"; `thread-head.test.ts`.
- ac-4: `branch-head.test.tsx` "opens on the hit's branch, scrolled to it…"; `thread-head.test.ts`
  search hit cases.
- ac-5: `branch-head.test.tsx` "a reader sees the owner's leaf move live…";
  `thread-head.test.ts` "a head at the old leaf follows the new leaf; a browsed head stays".
- CT16: `branch-head.test.tsx` over-window and schedule cases; `context-gauge-head.test.ts`.
- Pure rules: `lib/chat/head.test.ts`.
