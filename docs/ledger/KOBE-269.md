# KOBE-269: Chat shell polish: crushed icon buttons, list indents, sheet over send

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-269-shell-polish` in `../Kobe-wt269`
- **Depends on:** none (found in the gate1 browser check 2026-10-13)

## Plan

1. Icon buttons: `chat-global.css` pads every `button:not([data-slot])` 0.25rem 0.75rem, so a raw
   28 px icon button left its 16 px svg 2 px (measured on gate1). Move the raw icon buttons to
   `IconAction` (shadcn Button sets `data-slot`), with registry entries.
2. Lists: no Tailwind preflight in the chat, so `<ul>`/`<ol>`/`<p>` keep UA margins and the 40 px
   indent. Reset them for Kobe chrome only.
3. 768–820 px: the overlay sheet covered the composer's Send.

## Decisions

- **Sweep:** raw icon-only buttons inside `[data-kobe-chat]` were the retention banner close, the
  file-gone banner close (`file-tab.tsx`, same pattern, not in the brief) and the Files row
  Download/Delete. All four are now `IconAction`s; new registry commands `dismiss-notice`
  (thread), `download-file` and `delete-file` (rail). Size `sm` (24 px, `p-1`). Labels unchanged.
  The attachment chips' Retry/Remove set their own `p-1`, so the rule never crushed them; kept.
- **Guard:** `crushedIconButtons()` in `components/chat/testing.tsx` lists buttons in
  `[data-kobe-chat]` with an svg, no visible text, no `data-slot` and no `p-*` class. Asserted
  empty in the retention, file-gone, Files rows + open tab, and composer-attachments tests
  (happy-dom: classes and attributes, not pixels). A lint selector was considered and dropped:
  it cannot see class names held in variables (the `iconButton` constant was exactly that case).
- **Lists:** base-layer `[data-kobe-chat] :where(ul, ol, p):not([data-kobe-markdown] *)` sets
  `margin: 0; padding: 0` (what preflight does; utilities and CSS modules still win). The
  Markdown root carries `data-kobe-markdown`, so message lists keep UA spacing plus their
  utilities exactly as before. `list-style` is not reset. The only bare chrome list that relied on
  the UA indent for its bullets (policy denial reasons in `tool-call.tsx`) now says `list-disc ps-5`.
- **768–820 sheet (CE7/CE8):** smallest fix that keeps the table's "artifact column overlays the
  conversation; conversation holds ≥ 400": the sheet ends above the composer instead of covering
  it. CSS anchor positioning: `[data-kobe-composer] { anchor-name: --kobe-composer }` and, in the
  band, `.artifact { bottom: anchor(--kobe-composer top) }`. No JS, no new breakpoint, the sheet
  keeps its width and stays non-modal. Without anchor support the declaration is dropped and the
  sheet keeps today's full height. Rejected: composer above the sheet (hides the sheet's bottom
  under it), a modal sheet in this band (changes CE7's overlay into the < 768 behaviour), a
  ResizeObserver-fed height variable (more code for the same result).

## Open questions (for Chris or the coordinator)

- Confirm on gate1 after deploy at ~800 px with an artifact open: Send visible and clickable,
  sheet bottom at the composer's top; queue chips and the Files list flush left.

## Evidence (acceptance criteria → test or command output)

- ac-1 (icon buttons): `threads.test.tsx` retention close, `file-viewer.test.tsx` rows + gone
  notice, `attachments.test.tsx` composer: `crushedIconButtons()` empty (failed before the fix
  with "Download todo.md", "Delete todo.md", "Dismiss file notice", "Dismiss retention notice").
- ac-2 (lists): `layout-contract.test.tsx` "chrome spacing (KOBE-269)" pins the reset;
  `markdown.test.tsx` pins `data-kobe-markdown` and the Markdown list classes.
- ac-3 (sheet): `layout-contract.test.tsx` 768–820 test pins `bottom: anchor(--kobe-composer top)`
  and the anchor name; `next build` keeps both declarations in the emitted CSS.
