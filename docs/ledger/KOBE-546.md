# KOBE-546: Tree: Conversation tree panel, header button, Continue from here, labels UI, narrow list (web) (CT-5)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (not pushed; the coordinator opens the group PR)
- **Branch / worktree:** `kobe-546-tree-panel` in `../Kobe-wt546`, from `kobe-545-tree-projection`
  (merged again after its review fixes) and `kobe-545-lineage-fork-point` (fork rows' `forked_at_entry_id`)
- **Depends on:** KOBE-544 (local head), KOBE-545 (projection, layout, `branches` read, lane tokens),
  KOBE-543 (label route; the fake mirrors it)

## Plan

1. Pure half `lib/chat/tree-panel.ts`: texts, header counts, badges (shown/spoken), row name,
   filter, node menu, keyboard moves, junction groups, label rules and error words, node entries,
   files left behind (CT6), the messages dimmed by Continue from here, the chip excerpt.
2. Controller: `continueFrom(entryId)` / `clearContinue()` (`state.continueFrom`), `showBranch(entry,
reveal?)`, `reveal(entry)`, `announce(text)`. API `setThreadLabel` → `PUT …/labels/{entryId}`
   (answer re-validated in wire casing, `branches.ts` `writeThreadLabel`); fake route.
3. UI: `TreeHost` (context: notes, lineage, labels by message, open), panel
   `conversation-tree.tsx` (graph + rows), `tree-list.tsx` (narrow), `tree-actions.tsx` (menu,
   label editor, confirmation, fork dialog), `tree-entry-points.tsx` (header button, ForkMarker
   link, bar's Tree + CT6 files line), `tree-commands.tsx` (palette), `continue-from.tsx` (chip,
   dimming, hover action).

## Decisions

- **Address:** `PanelId` `conversation-tree`, prefix `/tree` (`app/tree/page.tsx` renders null). The
  workspace's `TreeHost` gets a route (`push("/tree")`, close = the panels' `closePanel`, so Back
  closes it and a reload reopens it over the remembered thread). A thread view without a host
  (builder test, Workbench, eval) wraps itself in a host with in-memory open state (CT19).
- **One lineage read:** the host reads lineage and `branches`; the tree uses both. The lineage
  strip still reads its own (unchanged; a second read on open). Could share later.
- `useFocusReread` (545) gained `replace(value)` (bumps the read seq so an older in-flight read
  cannot overwrite a label write's answer); `useBranches` exposes it as `replace`.
- **Click:** a node on screen only scrolls (`reveal`); off screen `showBranch(last entry, reveal =
first entry)` (newest leaf below, CT4). A tip equal to the leaf clears the head.
- **Continue from here:** the head stays when the answer is on the path on screen, else moves to
  the newest branch through it; `state.continueFrom` = the answer's last entry. `#send` treats it
  like an edit's explicit parent (`parent_entry_id`, head cleared at a non-queued send), clears it,
  restores it on a failed POST. Any other head move drops it; the host's thread switch uses a new
  controller (another thread never shows it). Dimming: `laterOnScreen` → `data-kobe-dimmed` +
  `opacity-50` on the messages. Not offered on the leaf's node, live answers, app cards, readers.
- **Menu:** Radix dropdown on the row's ⋯ (context-menu key / Shift+F10 open it for the row the key
  was pressed on). Its portaled events stop at the content (they bubbled to the row's click).
  Compare and carry-a-summary exist in `treeMenu` behind `compare` / `carrySummary` flags (false).
  Retry only on a ghost that is the leaf with an interrupted run (`controller.retry`); elsewhere a
  ghost has nothing to retry from the web. Fork and Label are hidden on test threads.
- **Make it current** from the menu: `showBranch` then `makeCurrent`; when the leaf's branch being
  left has a files badge (`filesLeftBehind`), an inline confirmation with the CT6 line comes first.
  The bar shows the same line while browsing (BranchBar's `filesChanged`); `thread_busy` → the
  bar's `LEAF_BUSY_NOTE` in the panel.
- **Edit this message:** close, `showBranch` when off screen, then `beginEdit` on the message once
  assistant-ui shows it (up to 20 frames).
- **Labels:** inline editor under the tree (`checkLabel`: trimmed, 1–60, protocol's
  `branchLabelSchema`); server codes → fixed words (`labelErrorMessage`); "Label saved" / "Label
  removed" through the controller's polite region. Picker: `TreeData.labelOf(message id)` →
  "Version 2 of 3 · label" (label on the node's own first entry wins).
- **Drawing:** one `aria-hidden` SVG under fixed-height rows (32 px; text cut with an ellipsis and
  the full text in the row's accessible name), lanes `var(--kobe-lane-N)`, dashed for forks and
  pending nodes, dotted for overflow, hollow ghosts, pulsing live node (reduced motion: none).
  "summary carried" and "compacted above" are trailing notes of their node, not rows.
- **Forks:** `treeForks` over the lineage's `forks` (wire `forked_at_entry_id`); unplaced forks
  count in the header only. Fork rows are treeitems; Enter/click opens the fork (address replaced
  as the Threads panel does).
- **Palette:** registry gains `conversation-tree` and `continue-from-here`; `previous-branch` /
  `next-branch` are now listed (`palette`, read-only safe). Message commands act on the message
  last focused or hovered in the conversation, else the newest that applies.
- **Narrow:** `useShellBand()` overlay/single → `TreeList` (sections by junction, rows with label,
  excerpt, time, summed badges, chips, ⋯ as a tab stop).

## Open questions (for Chris or the coordinator)

- A reload at `/tree` on a draft (no remembered thread) shows the chat with no panel and keeps the
  `/tree` address until the member navigates.
- Rows are one line (fixed height for the single SVG); CT4 says text wraps. Wrapping would need a
  per-row SVG segment or measured heights.
- Ghost Retry off the leaf: the web cannot re-send an uncommitted prompt; hidden there.
- The lineage strip and the tree host each read the lineage once per open.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `apps/web/components/chat/conversation-tree.test.tsx` "opens from the header button at
  /tree…", "Close and Back close it; a reload…", "clicking a node off screen…", "opens from the
  ForkMarker link, the bar's Tree and the palette; never on a draft", "draws a fork…".
- **ac-2** same file "dims what follows, sets the chip…", "from the tree's menu…";
  `lib/chat/thread-head.test.ts` "Continue from here (CT8)"; `tree-panel.test.ts` `laterOnScreen`.
- **ac-3** same file "labels (ac-3)" (owner set/remove + filter + announcement, picker, reader,
  test thread refused and hidden); `tree-panel.test.ts` label rules and menu on test threads.
- **ac-4** same file "rows are a role=tree…", "Make it current from the menu warns…", "Edit this
  message…"; `tree-panel.test.ts` keyboard moves and row names.
- **ac-5** same file "narrow windows (ac-5)"; `tree-panel.test.ts` "the narrow list".
