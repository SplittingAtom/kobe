# KOBE-374: Gold tool badges, whole-composer focus outline that pulses while running, drag a workspace file into the composer

- **Status:** committed on the group branch (not pushed)
- **Branch / worktree:** `group-2-quality` in `../Kobe-g2`
- **Depends on:** KOBE-301 (status tokens, pulse), KOBE-304 (Files tree, its drag type),
  KOBE-223 (structured `mentions[]`, server validation), KOBE-288 (queue/steer composer)

## Decisions

- **Gold tokens** (`app/theme.css`, light / chosen dark / OS dark): `--kobe-tool-badge` (text),
  `-bg`, `-border` (decoration), mapped to Tailwind `text-tool-badge`, `bg-tool-badge-bg`,
  `border-tool-badge-border`. Light `#6b4e00` on `#fbf0c4` (6.8:1, 7.7 on cards); dark `#f5cd5b`
  on `#3b2f08` (8.6:1, 11.7 on cards). Checked in `app/theme-css.test.ts`.
- **Badge:** the tool name on a step is a gold chip (`TOOL_BADGE`). A skill's Read step keeps its
  "Read skill" label, on the same gold chip, with the skill name after it. Outcome icon and label
  keep `OUTCOME_TONE` (KOBE-301), unchanged.
- **Focus:** `components/chat/composer.module.css`. The panel has a 2px outline, transparent at
  rest; `:focus-within` makes it `--kobe-composer-focus` (light `#52525b`, dark `#a1a1aa`; 3:1 or
  more on the page, muted and card, tested). The text field's own ring (the chat's
  `.app :focus-visible` 3px accent) is removed by a more specific `.panel .input` rule. Buttons
  inside keep their own ring. The old `focus-within:border-foreground/25` is gone.
- **Pulse:** `data-running` on the panel while `isThreadRunning` (queue/steer mode). The border
  and the focus outline turn `--kobe-status-running`, and a box-shadow halo pulses (2s). Only the
  shadow animates, so there is no layout shift and focus stays solid in every frame. Under
  `prefers-reduced-motion`: no animation, a still halo. It ends when the run ends or is stopped.
- **Drag in:** the tree's drag carries `application/x-kobe-workspace-path` (path) plus
  `application/x-kobe-workspace-folder` for folders, so a folder can be told apart while hovering.
  It never carries `Files`, so the composer tells it from OS files, which still attach.
  `effectAllowed` is `copyMove` (`copy` for read-only files). Read-only **files** (project mounts,
  thread uploads) are now draggable, to be mentioned; the tree's `canMoveInto` still refuses to
  move them. Read-only folders stay undraggable. A drop on the composer is handled by the composer
  only (the tree's drop never fires there), so it is a mention, never a move.
- **Mention = a pick:** `lib/chat/mention-insert.ts` inserts the protocol marker at the caret,
  adds the path to the draft's `MentionStore` (so the chip and `mentions[]` follow, KOBE-223), and
  focuses the input with the caret after it (one frame later, after a closing drawer). Client
  refusals follow the KOBE-223 rules: folders, `.kobe/`, `mentionPathIssue`, more than 20. The
  server still validates.
- **Keyboard:** "Mention in message" (`mention-file`, file-menu scope) on file rows only. It goes
  through `ChatSession.composerMentions` (a tiny channel; only a writable composer listens) and
  closes the rail drawer. With no writable composer (shared thread, Trash) the Files panel says
  "Open a conversation of your own to mention a file in your message."
- **Drop target:** `data-mention-drop="file"` gives an accent outline and tint, and the hint reads
  "Drop to mention this file". `="folder"` gives a dashed red outline and the hint says folders
  can't be mentioned (dropEffect `none`).

## Evidence

- ac-1: `components/chat/tool-badge.test.tsx`; `app/theme-css.test.ts` (gold AA, light and dark).
- ac-2: `components/chat/composer-outline.test.tsx` (panel and input classes, CSS rules, queue
  mode, shared-thread note); theme test (focus and running outlines 3:1).
- ac-3: same file (data-running on, off after completion and after Stop; idle none; keyframes
  animate box-shadow only with the running token; reduced motion `animation: none`).
- ac-4: `components/chat/composer-mention-drop.test.tsx` (drop gives a chip, `mentions[]` on
  send, focus, no move; project file mentioned; folder refused; OS file attaches; tree move still
  works; menu item, caret at end; no item on folders; shared-thread refusal);
  `lib/chat/mention-insert.test.ts` (rules, insertion, channel, drag types);
  `rail-files.test.tsx` menu lists updated.
- ac-5: the component tests above, plus `e2e/browser/tests/composer-cues.spec.ts`. It is written
  and **not yet run on gate1**: badge colour and shots, focus outline 2px solid and the field's
  none, pulse animation name and shots, reduced motion none, drag to composer gives a chip.
- Runs (2026-10-17): format:check, lint, web typecheck, hygiene, wording OK; web vitest 177 files
  / 1780 tests green; `next build` OK. The e2e package has no local deps, so the spec is not
  typechecked here.

## Open questions

- The chat-wide `.app :focus-visible` ring stays on every other field. Only the composer's
  textarea drops it.
- `app/__snapshots__/chat-theme.css.snap` was updated for the three new Tailwind colours.
