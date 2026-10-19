# KOBE-439: MA-7 `ui/message` and model context (web, server, protocol)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

Group MCP Apps (`group-ma-apps`), after KOBE-438. Spec `docs/specs/mcp-apps-host.md` §8, MA7, T8.
Nothing pushed; Hadron untouched.

## Commits

- `32a4ad26` protocol: `submitMessageBodySchema.app_context` (`app-context.ts`): 1 to 3 parts,
  one per app, each `{connector_id, app_id, template_sha256, data: {content?,
structuredContent?}}` of at most 8 KiB. `daa1470f` protocol: `APP_CONTEXT_PREAMBLE` (shared by
  server and chat). **Both are their own commits, for their own PR** (docs/parallel-work.md).
- `f4dedb54`, `8cb87909` server; `09e0eaa6` web; then the export test, ledger and spec.

## Design

- **No new storage.** The context is part of the run's input: the server writes one fixed
  sentence (`APP_CONTEXT_PREAMBLE`), then per part
  `<app-context source="connector:<name>" untrusted="true">` + JSON (with `<`, `>`, `&`
  escaped, so data cannot close the fence) + `</app-context>`, then a blank line and the member's
  text (`apps/context-block.ts` `withAppContext`). Pi's user entry is that input, so the thread's
  history, replays, forks and exports carry exactly what was sent (spec §8 "stored in the user's
  thread entry"). Schedules never carry it (only `trigger: user`).
- **Server check** (`runs/orchestrator.ts` `submitMessage`): each part must name an app the
  member can open now (`memberApps`: MA8, their own credential), of that connector, with the
  same approved template hash; else 422 `app_context_invalid` ("An app's context can no longer
  be sent. Remove its chip and try again."). The connector's name comes from the server, never
  the client.
- **`ui/message`** (`lib/apps/app-context.ts` `ComposerInsertChannel`,
  `components/apps/use-app-composer.ts`, `components/chat/composer.tsx` `useAppInserts`): the
  text goes in at the caret of the composer on screen (the card's own thread: frames run only for
  visible cards), which takes the focus and flashes (`data-app-insert`); never sent; 4 KiB of
  UTF-8 (the bridge and the channel). No composer (read-only, Trash): the app gets
  `{isError: true}`.
- **`ui/update-model-context`** (`AppContextStore` on the chat session): one chip per app per
  thread draft (last write wins), 8 KiB or the app gets `-32602`;
  `components/apps/app-context-chips.tsx` shows "Context from _app_: _one line_", the exact JSON
  in a disclosure, and a remove button. The runtime's send and the composer's queue path send
  `appContextBody(chips shown)` and clear them on success; a failed send keeps them.
- **History** (`components/chat/messages.tsx` `PlainText` + `splitAppContext`): a user message
  that starts with the preamble shows its blocks as "Context from _connector_ (untrusted data)"
  chips (JSON in a disclosure) above the member's own text.
- OpenAPI regenerated (`SubmitMessageBody.app_context`).

## Acceptance criteria

- **ac-1** never sends, own thread: web `app-context.test.tsx` "puts ui/message text into this
  thread's composer and never sends it" (no POST); `app-context.test.ts` (channel: latest
  composer only, 4 KiB).
- **ac-2** visible, removable, only what it shows is sent: web "shows a removable chip and sends
  exactly the chips shown" (last write wins, body = the chip, cleared after) and "sends nothing of
  a chip the member removed".
- **ac-3** fenced and untrusted, in history and exports: server `app-context.db.test.ts` (run
  input and the sandbox's `run.start` message are exactly the preamble + block + text),
  `context-block.test.ts` (cannot close the fence or forge the attribute),
  `export-markdown.test.ts` (the block in the Markdown export), web history test.
- **ac-4** sizes: protocol `app-context.test.ts` (8 KiB per part, 3 parts, one per app); server
  400 over 8 KiB; web store refuses over 8 KiB; `ui/message` 4 KiB.

## Notes for review

- The chips live in the browser tab (session) per thread draft: a reload drops unsent chips,
  as it drops other draft state that is not the text. Spec §8 says "after the send the chip
  clears"; it does not say chips survive a reload.
- Steering a running run (`POST /v1/runs/:id/steer`) does not carry chips; Enter during a run
  queues a message, which does.
