# KOBE-418: Chat layout: no bar row two; selectors in the composer; per-answer Show details; Compact now beside thumbs down; gauge under the composer

- **Status:** committed on the group branch (not pushed)
- **Branch / worktree:** `group-9-layout` in `../Kobe-g9`
- **Depends on:** KOBE-197 (bar, row two), KOBE-208 (Detail), KOBE-211 (gauge), KOBE-213
  (Compact now), KOBE-260 (thinking), KOBE-305 (rail resize, chat-column minimum). KOBE-419 builds
  on this bar.

## Decisions

- **Row two is gone** (`components/shell/context-row.tsx` and `components/chat/thread-actions.tsx`
  deleted; the `context` shell slot, `.rowTwo` CSS and the Menu's `aria-controls` second id
  removed). The bar is one row at every width; `data-bar-layout` is `wide` or `single`.
- **Composer toolbar** (`composer-selectors.tsx`): Attach, then the agent control (picker on a new
  conversation, the fixed `Agent: <name>` chip after), the model select and the thinking select
  (only for models that offer it), then Dictate and Send/Queue. Accessible names unchanged
  (`Chat with: …`, `Model for this conversation`, `Thinking level for this conversation`). The
  agent popover opens upwards. Read-only and Trash composers show their banner and no selectors;
  `/model` is not bound there.
- **Folding:** under 640 px of composer panel (`FOLD_SELECTORS_BELOW_PX`) or in the one-column
  band, the selectors fold into one `Agent and model` button (SlidersHorizontal icon, registry
  command `conversation-settings`) whose group opens above the toolbar. The pickers stay mounted
  while folded (hidden), so `/model` keeps working and nothing remounts across the fold. Escape
  closes it and focuses the button (an Escape the agent popover handled is left alone); a press
  outside closes it. Measured by ResizeObserver plus window resize.
- **Model picker split** (`model-picker.tsx`): `useModelPicker` (state, `/model` binding),
  `ModelSelects` (the selects) and `ModelWarning` (the "isn't enabled any more" alert, under the
  toolbar so a folded menu never hides it). The pinned-model hint is the select's description
  and tooltip, not inline text.
- **Show details per answer:** `AnswerDetailScope` nests a Detail context per answer; its toggle
  (`answer-detail`, "Show details", `aria-pressed`) sits right after Fork on every answer. The
  answer's choice holds until the conversation-wide toggle changes (generation is now a string,
  `outer.local`), which still wins, as over hand-set blocks. Per-answer choices are not saved.
  Mod+Shift+D and the palette's "Show all details" are unchanged (`detail` is now `app` scope).
- **Compact now** (`compact-now.tsx`): a provider in `ThreadView` (shell only) owns the dialog
  and `/compact`; the latest answer gets a `Compact now` icon (Shrink) after thumbs down, enabled
  only when `compactBlocker` is null, else `aria-disabled` with the reason as description and
  tooltip. While a run goes the answer's actions hide (`hideWhenRunning`), as before. Focus after
  the dialog returns to what opened it, else the latest answer's button, the gauge, the composer.
  The gauge's red action keeps the "Compact this thread" name.
- **Gauge** under the composer box: a `data-composer-footer` row (min-height 1.5rem, always
  rendered, also under the read-only/Trash banner) with the hint on the left and the gauge at its
  end (`ms-auto`); tooltip opens upwards. No shift when it appears or turns red.
- **Files button removed** (`FilesButton`); `files` is `app` scope (Mod+Shift+F, `/files`).
- **Width:** `--thread-max-width` 80rem (`THREAD_MAX_WIDTH`); user bubbles capped at 85% by the
  grid track `fit-content(85%)` (they had no cap before); tables and code already scroll in place.
- **Phone:** nothing row two held is lost: selectors in the composer menu, gauge under the
  composer, details and Compact on the answers, Files through the rail drawer and Mod+Shift+F.
- Kept: KOBE-374 outline/pulse (panel unchanged), KOBE-288 queue/steer, KOBE-304 drag into the
  composer, KOBE-305 grid and chat-column minimum (CSS untouched), KOBE-225 shortcuts.

## Follow-up after review questions (coordinator, 2026-10-18)

- Show details shows only on answers with something to open (reasoning, tool card, stored step,
  compaction marker); plain-text answers have none (`answer-detail.test.tsx`).
- The read-only shared-thread banner names the thread's agent (`AgentChips`, with Suspended or
  Archived), since that composer has no selectors (`thread-share.test.tsx`).

## Review fixes (review-418, 2026-10-18)

- B1: the folded menu is `display: none` inline while closed (the chat has no preflight `[hidden]`
  rule, so its `flex` class kept it on screen). Unit test checks the inline style and the absence
  of display classes; `chat-layout.spec.ts` checks it is hidden at 390 px before opening and after
  Escape.
- S1: `opensAsBlock` matches assistant-ui's converted `{ type: "data", name }` parts (stored step,
  compaction marker); tests for both.
- S2: the action-bar e2e asks for a tool step; the width e2e has a lower bound at 1920 px.
- S3: the fold is measured in a layout effect, before paint.
- Nits: the menu closes when focus leaves it; the gauge shows in the shell only (not the builder
  pane, as before); key hints stay on one line under the composer; comment wraps; the steering
  spec asserts its boxes. Not done: a Trash thread still names no agent (minor, left as is).

## Evidence (acceptance criteria → test or command output)

- ac-1: `composer-selectors.test.tsx` (no row two, no Files), `shell.test.tsx`,
  `breakpoints.test.tsx`, `ssr.test.tsx`.
- ac-2: `composer-selectors.test.tsx` (order, new vs started, read-only, phone fold, measured
  fold, Escape and outside press); `agent-picker`, `model-picker` tests unchanged and green.
- ac-3: `answer-detail.test.tsx`; `rich-history`, `shortcut-keys`, `command-palette` updated.
- ac-4: `compact-dialog.test.tsx` (latest answer only, after Bad answer, blockers, focus return,
  `/compact`), `slash-menu.test.tsx`.
- ac-5: `context-gauge.test.tsx` "under the composer" block.
- ac-6: `rail-files`, `layout-preferences`, `shell` tests use Mod+Shift+F; registry has no `bar`
  entries for removed controls (`commandsIn("bar")` in `shell.test.tsx`).
- ac-7: e2e updated: `compact-now`, `theme`, `thinking`, `my-shared-cases`, `context-gauge`,
  `steering-panel` (Queue on the selectors' line), `support/chat.ts`; `status-cues` and
  `composer-cues` need no change (thread header badge, composer panel). New
  `chat-layout.spec.ts`: light/dark/phone screenshots of the composer and an answer's actions.
- ac-8: `chat-layout.spec.ts` measures the column at 1440 and 1920 (≤ 1280 px, centred, no
  page scroll) and attaches screenshots. Gate1 specs run after the deploy.
- `pnpm --filter @kobe/web test` 183 files / 1829 tests green; lint and typecheck clean. Coverage
  (v8, touched files): 96% lines overall; compact-now 100%, composer-selectors 100%, composer 93%.
