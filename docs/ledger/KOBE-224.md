# KOBE-224: C6 `/` actions menu from the command registry (CE22)

- **Status:** done on branch, awaiting review (no PR: group G4)
- **Branch / worktree:** `group-4-composer` in `../Kobe-g4`
- **Depends on:** KOBE-203 (command registry), KOBE-206 (steering panel), KOBE-223 (`@` trigger
  root in the composer), KOBE-221 (shared threads)
- **Migrations / server / protocol:** none

## What it does

`/` at the start of the composer (empty, or after leading whitespace only; nothing after the
caret) opens a listbox "Actions" on assistant-ui's own trigger popover, a second
`TriggerPopover char="/"` with the `Action` behaviour (`removeOnExecute`) beside the `@` picker
(`components/chat/slash-menu.tsx`). The textarea is the combobox (aria-expanded / controls /
activedescendant from `ComposerPrimitive.Input`); arrows move, Enter or Tab picks, Escape closes
and keeps the text. Each option names its word, argument, action and, when it can't run, the
reason (`aria-disabled`).

- A pick runs the binding's handler and removes the whole `/` text (the matcher spans to the end
  of the text): nothing of it reaches the prompt (AC3).
- An action with an argument (`/model`, `/regenerate-with`, `/move`, `/share`) completes to
  `/word ` and lists the binding's `choices`, filtered by what follows; picking one runs that
  choice's `onSelect`.
- **A known word is never sent** (review M1, S3): every registry word is listed, bound or not.
  Unbound (a draft thread, a control not read yet) reads "Not available here right now.", a draft
  thread's actions "Send a first message to start the conversation."; a known word whose
  argument matches nothing, or that takes none, gets one disabled "no match" row. Picking any of
  these puts the text back, keeps the menu open and speaks the reason (re-announced on repeat).
- Only a word no action has lists nothing, so the popover stays closed and Enter sends the text
  as a message (AC2). A `/` later in the text never opens it.
- Enter or Tab on a bare `/` picks nothing until the member arrows through the list (S2).

## Registry design (for KOBE-225: palette and shortcuts)

Two layers, both keyed by `CommandId`:

1. **Static** (`lib/shell/commands.ts`, KOBE-203): id, name, icon, scope, shortcut, href, plus
   new `slash` (the `/` word, unique), `arg` (the argument's name) and `readOnlySafe`
   (offered to a shared-thread reader). New command `choose-model` (`/model`).
2. **Live bindings** (`lib/shell/command-bindings.ts`, `components/shell/command-bindings.tsx`):
   the existing `MenuBinding` type (KOBE-292 row menus) is the handler type: `onSelect`,
   `blocker` (why it can't run now: "enabled(state)"), `choices` (argument values with their own
   `onSelect`), `label`. The component that owns a button publishes the same binding its button
   uses with `useBindCommands(bindings)` while mounted; `CommandBindingsProvider` (chat app)
   merges them; `useBoundCommands()` reads them. Lazy choices (Move's projects) load while a
   listing says it is open (`useWantCommands` / `useCommandsWanted`). No provider (builder test
   pane): publishing is a no-op and listings are empty.

Publishers republish only when what a listing shows changes (`bindingsSignature`: ids, labels,
blockers, choices); the published handlers relay to the latest render's (`relayBindings`), so
the menu's items and highlight stay put while a run streams (review S1). Two sources binding one
command: the later-mounted wins.

Publishers: `ThreadCommands` (thread view: the row menu's `useThreadMenuBindings`, extracted from
`ThreadRowMenu` and shared by both, plus Stop via `stopBinding` (also the steering panel's Stop)
and Fork at the last answer via the answer's `ForkDialog`); `ContextRow` (compact: the gauge's
and actions menu's `openCompact`); `ThreadTitle` (rename: the pencil's `open`); `ModelPicker`
(`/model`: its `choose`); `AppCommands` in the chat app, mounted whatever the layout (`/new`:
`aui.threads.switchToNewThread`, what `ThreadListPrimitive.New` calls; `/files`: the Files
button's `rail.reveal("files")`). A draft thread binds its thread actions blocked; Pin/Unpin and
Archive/Unarchive bind the inapplicable word with its reason. Navigation commands with
a word (`/memory`, `/schedules`, `/agents`) get `hrefBindings`, listed last, navigating with
Next's router like the bar links (a full load only outside the app router).
Pure listing logic: `lib/shell/slash.ts` (`slashQueryAt`, `slashMatcher`, `slashEntries`,
`slashItems`, `slashOutcome`).

KOBE-225 should read `useBoundCommands()` + `slashEntries`-style filtering (registry order,
`readOnlySafe` for readers, `blocker` shown as disabled) and call `binding.onSelect` from the
palette and the key handlers; `choices` become a second palette step.

## Decisions

- Enter and Tab both complete an argument action (the primitive treats them alike); the action
  runs only once a choice is picked. Blocked actions stay listed (disabled, with the reason)
  rather than hidden, so members learn why.
- Shared-thread readers get no composer (KOBE-221 banner), so they never see the menu;
  `slashEntries({ readOnly: true })` blocks all but the read-only-safe actions (copy, fork, new,
  files, navigation) for the palette; `threadReadOnly` is the one derivation the row menu and the
  open thread's bindings share. `slashEntries` honours `available(ctx)` (consoles).
- `ThreadCommands` speaks its results (Copied, Moved …) in its own polite status line, via the
  rail's `RailAnnounce` context.

## Not registered (do not appear until a later ticket binds them)

- `/steer` (needs the composer text it would steer with), `/new <agent>` (agent argument), export
  (its button lives in the rail's Threads header, unmounted while the rail is collapsed), delete
  (no `/` word on purpose: no confirm), pin/archive of other threads.
- Review nits not done: N4 (query derived in an effect: one frame unfiltered, visual only), N8
  (one shared announcer instead of three status lines).

## Open questions

- None blocking.

## Evidence

- ac-1: `apps/web/components/chat/slash-menu.test.tsx` (listbox + combobox ARIA, registry order,
  arguments, disabled Stop, arrows; `/compact` opens the Compact dialog; `/fork` the Fork dialog;
  Tab completes `/regenerate-with`, choice regenerates with GLM; `/move` moves as the row menu
  does and announces the same text); `lib/shell/slash.test.ts`, `lib/shell/command-bindings.test.ts`.
- ac-2: same file, "text that is no action is a message" (`/hello there` sent; `see /comp`;
  leading whitespace vs a second line); `slash.test.ts` matcher cases.
- Review round: same file: `/compact` in a draft, `/new` at 390 px, `/model gml` no-match,
  bare `/` + Enter, burst typing, paste, IME Enter, click pick keeps focus, thread switch then
  `/pin`, `/hello … @file` with `mentions`, `/memory` via the router keeps attachments;
  `command-bindings.test.ts` signature and relay.
- ac-3: `/compact`, `/fork`, `/regenerate-with`, `/move` leave the composer empty with no
  message posted (or only the regenerate's own re-send).
- Browser (gate1, later): `e2e/browser/tests/slash-menu.spec.ts` (`/fork` dialog and empty
  composer; Escape keeps `/comp`; `/hello …` sent and answered).
- Commands: `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, web vitest (146 files, 1377
  tests) all green.
