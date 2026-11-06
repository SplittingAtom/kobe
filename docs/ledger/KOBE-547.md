# KOBE-547: Tree: Compare versions side by side (web) (CT-6)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (not pushed; the coordinator opens the group PR)
- **Branch / worktree:** `kobe-547-compare` in `../Kobe-wt547`, from `kobe-546-tree-panel`
- **Depends on:** KOBE-546 (tree panel, node menu hook, palette, labels), KOBE-544 (local head)

## Plan

1. Pure half `lib/chat/compare.ts`: a message's versions (siblings in the chat's projection), the
   pair the dialog opens with, the dropdowns, titles, whether the prompts show.
2. `messages.tsx`: `ReadOnlyAnswer` / `ReadOnlyPrompt` share the conversation's parts (`AnswerParts`,
   `CopyAction`, `PlainText`); `MessageFooter` gains `shown` (always visible, for the headings).
3. `compare-dialog.tsx` (+ module CSS), opened by `TreeData.compare(messageId)` from `TreeHost`;
   entry points: picker icon (`markers.tsx`), node menu (`tree-actions.tsx`), palette
   (`compare-versions` in `lib/shell/commands.ts`, bound in `tree-commands.tsx`).

## Decisions

- **Versions** = the message's committed siblings of the same role in `projection.items`, in the
  picker's order ("Version k" = k-th sibling). A regenerate also commits a new prompt entry, so
  most versions are prompt siblings; assistant siblings compare as answers alone.
- **A prompt's answer** = its newest committed assistant child (retries under one prompt are rare).
- **Prompts show** in the columns only when the two compared prompts differ (an edit); a
  regenerate repeats the same text, so only the answers show.
- **Opens** from the picker's icon on the two newest versions (older left); from the tree's
  "Compare with…" or the palette on a focused message (coordinator, after review) with the picked
  version left and the newest other one right (`initialPair(versions, picked)`). Each column's
  native `<select>` (only with more than two versions) lists every version but the other column's.
- **Rendering:** each column gets assistant-ui's `MessageProvider` (a message context off the
  branch on screen) over the thread's own context, so the parts, tool cards (collapsed by
  default), markdown, usage footer and `AnswerFeedback*` are the conversation's components, not
  copies. Only Copy and the thumbs (with the thumbs-down details) are offered.
- **Heading:** label (CT9; the version's own, else its answer's) or "Version k", then the run's
  model, tokens and time (`MessageFooter shown`). Region `aria-label` "Version k[, label]".
- **Show this version:** `controller.showBranch(answer's last entry, version's first entry)`: the
  newest branch through that version, scrolled to it; a tip equal to the leaf clears the head.
  Owner and reader alike; never `POST /leaf`.
- **Tree menu:** "Compare with…" is live (`compare: true`); picking it closes the tree first
  (the dialog takes the window) and starts from that node.
- **Palette:** "Compare versions" (message scope, read-only safe) acts on the focused or hovered
  message with versions, else the newest one; blocker `NO_VERSIONS` otherwise.
- **Full-screen** under 820 px from `useShellBand()` (overlay/single, as the tree's list);
  `data-kobe-compare="sheet"`, one column per row. Test panes have no band provider (always wide).
- "Comparing versions" is announced through the controller's polite region when it opens.
- The dialog lives in `TreeHost`, so test threads (builder test, Workbench, eval) get it (CT19).

## Open questions (for Chris or the coordinator)

- Test panes (no `ShellBandProvider`) never go full-screen.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `apps/web/components/chat/compare-dialog.test.tsx` "opens from the picker on the two
  newest; a dropdown swaps; Show moves the head only", "opens from the tree's Compare with… and
  from the palette", "works for a reader and on a test thread (CT19)…";
  `apps/web/lib/chat/compare.test.ts` (versions, pair, dropdowns).
- **ac-2** same file "render read-only: Markdown, tool cards collapsed, Copy and feedback only",
  "feedback is per column; full-screen under 820 px; Escape closes".
