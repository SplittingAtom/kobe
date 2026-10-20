# KOBE-450: Composer controls below the composer after the first prompt; slash commands for Pi's built-ins

- **Status:** in review (group G11b, branch `group-11b-composer`, not pushed)
- **Branch / worktree:** `group-11b-composer` in `../Kobe-g11b`, from main 4f7388a4
- **Decisions:** Chris 2026-10-20 (ticket note): Kobe-safe Pi commands only; the Agent stays
  changeable after the first prompt under today's rules, only its position moves.

## Part 1: the controls

- Before the first prompt (no `remoteId`): Agent, Model and Thinking stay in the toolbar after
  Attach (KOBE-418), folded into "Agent and model" on a narrow composer.
- After it: `ComposerSelectors placement="below"` leads the line under the composer
  (`[data-composer-footer]`, now `flex-wrap`): selectors, the key hint (flex, truncates), the
  gauge (`ms-auto`, right). Compact pills (`.compactPicker`, `AgentChips compact`); never folded
  there, they wrap. The toolbar keeps Attach, Dictate and Send/Queue. `ModelWarning` unchanged.
- Agent rules unchanged (ac-5): new conversation = picker; started = today's fixed chip (the
  version switch stays in the header). Model/thinking still save on the thread.
- Opening a thread by URL briefly renders the new-conversation composer before the thread loads
  (pre-existing); the selectors then move below. Tests wait for the loaded thread.

## Part 2: Pi 1.0.x built-in commands (pinned 1.0.0, `images/sandbox/pi/package.json`)

Source: `@earendil-works/pi-coding-agent@1.0.0` `dist/core/slash-commands.js`
(`BUILTIN_SLASH_COMMANDS`, 24 commands) plus `/llama` from its `docs/slash-commands.md`. Mapping
in `apps/web/lib/shell/pi-commands.ts` (tested against that list).

| Pi            | Kobe                | Kind / reason                                                         |
| ------------- | ------------------- | --------------------------------------------------------------------- |
| model         | `/model`            | existing                                                              |
| thinking      | `/thinking ‹level›` | new word; the thinking picker's binding (server clamps as before)     |
| export        | `/export`           | new, server: `GET /v1/threads/:id/export`, owner only, audited        |
| session       | `/session`          | new: details + usage dialog from existing reads (read-only)           |
| share         | `/share`            | existing (team sharing; Pi's GitHub gist upload never offered)        |
| copy          | `/copy`             | existing (conversation as Markdown; each answer has Copy)             |
| fork          | `/fork`             | existing (at the latest answer; earlier ones via the message's Fork)  |
| clone         | `/fork`             | alias: Kobe's /fork is Pi's clone                                     |
| name          | `/rename`           | alias                                                                 |
| new           | `/new`              | existing                                                              |
| compact       | `/compact`          | existing (dialog with optional focus, server-decided)                 |
| hotkeys       | `/shortcuts`        | alias; new word on the existing shortcut sheet                        |
| resume        | `/search`           | alias; new word on the existing palette (search threads)              |
| settings      | not offered         | Pi's own settings file / TUI menu; Kobe settings in profile, consoles |
| tree          | not offered         | TUI tree view; messages show their versions, Fork branches            |
| scoped-models | not offered         | TUI Ctrl+P cycling config; models are the team's (`/model`)           |
| import        | not offered         | reads a session file outside the workspace into Pi                    |
| bug           | not offered         | sends a report outside Kobe; thumbs down tells the agent's owner      |
| changelog     | not offered         | Pi's release notes, not Kobe's                                        |
| trust         | not offered         | writes Pi's trust file; the server decides every tool call            |
| login, logout | not offered         | provider keys in the sandbox; secrets stay out, models via gateway    |
| reload        | not offered         | reloads Pi-local extensions/skills; the server sets each run's        |
| quit          | not offered         | ends the Pi process the server runs; `/stop` stops a run              |
| llama         | not offered         | llama.cpp router from Pi's config; models set in the Site console     |

- ac-6: Kobe runs Pi in RPC mode with `--no-extensions --no-skills --no-prompt-templates`
  (`sandbox-agent/src/pi/pi-launch.ts`); RPC `prompt` runs no built-in command (they exist only in
  Pi's interactive mode). The `/` menu never sends a known word: a Pi alias offers Kobe's
  command, a not-offered word keeps one disabled row "/<word> isn't offered in Kobe: <reason>",
  Enter sends nothing. Note for KOBE-451: Pi still expands `/skill:<name>` for the `--skill` dirs
  the server loaded (the effective set only).
- One command per word: the registry test (every `/` word unique) holds; aliases never take a
  registry word (tested).
- Palette: the new commands are listed (label = description); `filterActions` also matches Pi's
  alias words (`name` finds Rename). `/search` is the palette itself, so the palette doesn't
  list it (as before).

## Server (for the Opus review)

- `GET /v1/threads/:id/export` (`routes/thread-retention.ts`, `retention/export-thread.ts`):
  same guards as the full export (`refuseDownload`: Sec-Fetch-Site / Origin, `?team=` stale-tab
  check), `team.chat`; owner only via `OWN_THREADS` (restorable Trash included), team named in
  every query; not found otherwise with nothing recorded. Audit `thread.transcript_exported`
  `{threadId, entries}` written in the same transaction as the ownership read, before streaming.
  Streams header + active-branch entries (offloaded bodies capped as in the full export).
- No migration in 450.

## Shared files touched (g11a works on the rail/panels)

- `apps/web/lib/shell/commands.ts`: 3 entries after `choose-model` (`choose-thinking`,
  `thread-info`, `export-thread`, icon `InfoIcon` import) and a `slash` field on
  `command-palette` (`search`) and `keyboard-shortcuts` (`shortcuts`). Nothing in the rail scopes.
- `lib/shell/slash.ts`, `lib/shell/palette.ts`: small Pi-word hooks.

## Evidence

- ac-1/ac-5: `components/chat/composer-selectors.test.tsx` ("after the first prompt…", 4 tests);
  `model-picker.test.tsx` reads the open thread's picker below.
- ac-2/ac-6: this table; `lib/shell/pi-commands.test.ts` (list = Pi 1.0.0's, kinds, reasons,
  menu rows, palette aliases).
- ac-3: `components/chat/pi-commands.test.tsx` (/thinking levels + save, blocked without levels;
  /session dialog; /export link `…/export?team=`; /name → /rename; /login refused, nothing sent);
  `slash-menu.test.tsx` listing; server `retention.db.test.ts` "/export of one conversation" (3).
- ac-4: `e2e/browser/tests/composer-controls.spec.ts` (new) plus updates to `chat-layout`,
  `thinking`, `steering-panel` specs and `support/chat.ts` `selectors()`. Not yet run on gate1:
  it needs this branch deployed there.
- Checks before stop: typecheck, lint, format:check, web (2140) and server (2195) unit tests,
  `@kobe/db test:db` incl. the cross-team probe suite (1535), server db `retention` +
  `threads-plans` (38): green.
