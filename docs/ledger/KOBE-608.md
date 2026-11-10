# KOBE-608: Answers with an MCP app card show only the app; the rest behind "Show response"

- **Status:** implemented, unit-tested; the coordinator runs the browser spec on gate1.
- **Branch:** `kobe-608-app-only` (on `pipeline-b`).

## How "app answer" is decided

`apps/web/components/apps/use-app-answer.ts` (`useAppAnswer`): for each `mcp__` tool call of the
message, the same lookup `ToolCardApp` uses (thread app list by prompt, live run, tool call id)
plus the live `tool.result` app marker. `app` (view app, read not failed) or `pending` (marker,
list not yet re-read) makes it an app answer; `text` (MA10) or `failed` (the stored result could
not be read; `LiveApp` reports it through `ThreadApps.markFailed`) falls back. Never the iframe's
load event. Once an app answer, it stays one for that message until a text/failed verdict
arrives (a re-read list never flickers the rest back in).

## Rendering

`apps/web/components/chat/app-answer.tsx`: `AnswerParts` renders the parts in passes through a
context. `all` = as before. `kept` = app tool cards, tool cards with an approval card or a blocked
domain (live), approval outcome rows, `kobe-problem`, entry markers. `rest` (under a `Disclosure`
"Show response", `aria-expanded`, mounted only when open) = prose, reasoning, other tool cards,
offloaded/skipped parts, "Used skill". The app card is rendered once (kept pass), so opening the
toggle never remounts its frame. Working…, `AnswerBlockedNotices` and the action bar (Copy copies
the message text) sit outside and are untouched. Applies to `AnswerMessage` and `ReadOnlyAnswer`.

## Tests

- `apps/web/components/apps/app-answer.test.tsx` (7): hides the rest; toggle (keyboard) reveals in
  order with one frame; text-card fallback; failed-read fallback; problems and approval outcomes
  kept (shown once when opened); Copy text; live run: hidden at the marker, a pending approval of
  a later call shows, later prose stays hidden.
- `tool-card-app.test.tsx`: the text-reason card of a second call now sits under Show response.
- `e2e/browser/tests/app-only-answer.spec.ts`: `KOBE_APPS_CONNECTOR`/`KOBE_APPS_OPEN` (as the
  Explorer Gate); skips without the app unless `KOBE_REQUIRE_APP=1`. One model run.

## Docs

`docs/specs/mcp-apps-host.md` MA3 amendment (2026-11-10, KOBE-608); `e2e/browser/README.md`.

## Open questions

- Reload: until the thread's app list arrives the answer shows as before, then collapses (one
  change at open; live runs decide at the marker, so no flicker there).
- A `pending` marker whose list read then fails keeps "Loading app" with the rest hidden; Show
  response still reveals it.
