# KOBE-437: MA-5 Host bridge and app frame (web)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

Group MCP Apps (`group-ma-apps`), after KOBE-436. Spec `docs/specs/mcp-apps-host.md` MA2, MA4
(as amended), T2-T5, §7. Nothing pushed; Hadron untouched.

## First: MA-4 re-review LOWs (commit c5b9e8be, KOBE-436)

- **R-LOW-1:** the validator pool takes **one task per member** (in flight or queued). A
  member's second call, a full queue or a closed pool answers `busy`, which `callApp` turns into
  `validation_busy` (**503**, audited, throttled like other denials), never `invalid_arguments`.
  `SchemaValidator.validate(schema, instance, owner)` now returns `valid | invalid | busy`.
  `APP_CALL_REASONS` gains `validation_busy` (audit enum only; no migration).
- **R-LOW-2:** workers get `resourceLimits` (`WORKER_RESOURCE_LIMITS`: 64 MiB old, 16 MiB young).
  An out-of-memory worker raises `error`, is replaced, and the call is refused.
- Tests: `validate-pool.test.ts` (per-owner busy, other members unaffected, full queue, closed,
  limits read at spawn); `team-apps.db.test.ts` (a concurrent second call by Alice is 503
  `validation_busy`, Bob gets 200, audits).

## Spike: ext-apps `AppBridge` or Kobe's own bridge (spec MA2) → **Kobe's own**

Checked `@modelcontextprotocol/ext-apps` 2.0.3 (MIT) from the registry tarball:

1. Driven without a live MCP client: **yes** (`new AppBridge(null, …)`; handlers are setters).
2. Every handler overridable or denied: **mostly**; unhandled methods get the SDK's generic
   `-32601` without Kobe's `data.reason`, so a fallback handler would be needed anyway.
3. Works with a frame-route iframe: **yes** (transport-agnostic).
4. Peer dependencies: **fails**. `AppBridge` extends `Protocol` from the required peer
   `@modelcontextprotocol/client` 2.3.x, whose dependencies are `cross-spawn` (stdio
   transport), `eventsource`/`eventsource-parser` (HTTP transport), `jose` and `pkce-challenge`
   (OAuth): about 7 MB of transport and auth code that Kobe's web would carry for nothing.

Also: its `PostMessageTransport` checks only `event.source` (not `origin === "null"`), has no
per-frame size, rate or in-flight limits, and `console.debug`s every message (app data in the
console). Kobe would have to wrap the transport and every handler anyway. **Decision: Kobe's own
thin bridge** (zod, about 300 lines), written against the ext-apps specification types
(protocol `2026-01-26`). No new dependency, so no licence change.

## What was built

- **Server** (commit a932ad99):
  - `GET /v1/team/apps/:appId/frame?team=&sha256=` in `routes/team-apps.ts` (under
    `requireTeam` + `team.chat`): only `memberApp` + `servedTemplate` bytes (pinned and
    approved), `text/html` with `APP_FRAME_HEADERS` (CSP `sandbox allow-scripts; default-src
'none'; …`), only when `mayLoadAppFrame` (same-site, and `Sec-Fetch-Dest: iframe` when
    sent), strict query (`team` must equal the active team, 409 otherwise; `sha256` must equal
    the stored bytes, 409 `stale`). Unknown, not-live or drifted apps: 404 JSON.
  - `GET /v1/team/apps/:appId/tools`: the bridge's `tools/list`, the connector's tools that pass
    `checkAppTool` (pinned, read-only, app-visible, exposed), as `{name, title?, description,
inputSchema, outputSchema?, annotations}`.
  - `connectors/app-frame.ts`: `mayLoadAppFrame` and `appFrameDocument` shared with the admin
    preview route (refactored onto them; behaviour unchanged). Two routes, never one with a flag.
- **Web** (commit 611cbe46):
  - `lib/apps/bridge-schema.ts`: zod per method (JSON-RPC envelope, `tools/call`, `tools/list`,
    `ui/initialize`, `ui/message`, `ui/update-model-context`, `ui/request-display-mode`,
    size-changed).
  - `lib/apps/host-bridge.ts` `attachHostBridge`: answers only `event.source ===
frame.contentWindow` **and** `event.origin === "null"`; the §7 table; denied methods get
    `-32601 {reason: "not_allowed_in_kobe"}` (`ui/open-link`, `ui/download-file`, `resources/*`,
    `sampling/*`, `elicitation/*`, `prompts/*`, anything unknown); malformed params `-32602`.
    Per frame: 64 KiB per message (`-32600 too_large`), 10 requests per second
    (`rate_limited`), 4 tool calls in flight (`too_many_calls`), results ≤ 4 MiB
    (`result_too_large`). `ui/message` text ≤ 4 KiB, only text blocks, never sent;
    model context ≤ 8 KiB. Logging is dropped and counted. `initialize` gives
    `hostCapabilities {serverTools, logging, message, updateModelContext}` (no `openLinks`,
    `downloadFile`, `serverResources`) and `hostContext` with theme, Kobe's colours as ext-apps
    variables, display mode, locale, container size; no user or team ids. Host → app:
    `notify(...)` and `teardown(ms)` (`ui/resource-teardown`, answered or timed out).
  - `lib/apps/app-api.ts`: `callAppTool` (only `POST /v1/team/apps/:appId/calls`),
    `listAppTools`, `appFrameUrl`. Not `apiRequest`: it camelizes keys, which would alter the
    upstream result.
  - `components/apps/app-frame.tsx` `AppFrame`: host header outside the frame ("_title_ · App
    from _connector_", generic icon: Kobe's `img-src` blocks remote icons), `<iframe
sandbox="allow-scripts" referrerPolicy="no-referrer">` with no `allow`, `src` = the member
    frame route; inline 360 px default, ≤ 720 px; expanded ≤ 4,000 px; `tool-input` and
    `tool-result` sent after `ui/notifications/initialized`; `host-context-changed` on
    placement change. Not mounted anywhere yet (MA-9 tool cards, MA-6 app cards).
- **e2e** (commit 69d14d03): `e2e/browser/tests/app-frame.spec.ts` + `support/app-frame-probe.ts`
  (README section).

## Acceptance criteria

- **ac-1** (browser test): `app-frame.spec.ts` takes one live app (`KOBE_APP_ID` or the first
  of `GET /v1/team/apps`), keeps the deployment's real frame response (status and headers)
  and swaps in a hostile probe body. Checks: script runs with `self.origin === "null"`;
  fetch (remote and Kobe), XHR, WebSocket and a remote img each fail **and** raise a CSP
  violation (`connect-src`/`img-src`), so an unreachable host cannot pass; `window.open`
  returns null; `document.cookie`, `localStorage` and `parent.document` throw
  `SecurityError`; after a `_top` form post and `top.location` the page URL is unchanged, no
  popup, no response from the remote host. Skips when the member has no app.
  - **Run here** against a local stand-in (scratchpad harness: Kobe's real page CSP from
    `buildCsp` and the server's real `APP_FRAME_HEADERS`, Chromium 1187 / Playwright 1.55):
    **passed**. Negative controls: without the header CSP the spec fails on the headers, and a
    copy without header assertions fails on `connect-src` (the policy, not the network).
  - **Not yet run on gate1 or k3d:** gate1 runs main (no member frame route until this group
    deploys), and k3d has no app until MA-8 (KOBE-441) gives `e2e/lib/fake-mcp.js` a template.
    Gate1 also needs a member with a Catalyst key. Run it at the gate.
- **ac-2** (other windows ignored): `host-bridge.test.ts` "source and origin" (other window,
  `null` source, the host window, a non-opaque origin; detach) and `app-frame.test.tsx`.
- **ac-3** (`ui/open-link`, `ui/download-file`, `resources/read` denied):
  `host-bridge.test.ts` "denies open-link, download-file, resources/*, …".
- **ac-4** `npx pnpm@12.8.1 license:check`: passed (692 packages, 0 pending). No dependency
  added (the e2e package is outside the workspace and unchanged).

## Review items carried here

- MA-4 review LOW-1 (`Sec-Fetch-Dest: iframe`): on both frame routes (`mayLoadAppFrame`).
- MA-2/3 review L2 (self-navigation inside Kobe's origin): no `/v1` GET route writes (all
  writes are PUT/PATCH/POST/DELETE; Better Auth sign-out is a POST), so a frame navigating
  itself to a Kobe URL changes nothing and reads nothing (opaque, XFO DENY on pages).
- The admin preview's browser test (script runs, fetch fails) is the same mechanism and
  headers; `app-frame.spec.ts` covers it for the member route.

## Tests and checks

- web: `lib/apps/host-bridge.test.ts` (16), `app-api.test.ts` (4), `components/apps/
app-frame.test.tsx` (5); all web 2,010 passed.
- server unit 2,106 passed; db 598 passed; DB `team-apps.db` (13 with the new frame/tools/busy
  tests), `connector-template-review.db`, `mcp.db`: 59 passed.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `license:check`: green.

## Notes and questions for review

- `AppFrame` cannot send `ui/resource-teardown` from its own unmount (the frame is already gone
  by then). Owners (MA-9 cards, MA-6, team switch) call `HostBridge.teardown(ms)` before they
  remove a frame; MA-9 should expose the bridge from `AppFrame` for that.
- `ui/message` and model context answer "refused" until MA-7 wires the composer
  (`onMessage`/`onModelContext`); `ui/message` replies `{isError: true}` without a composer.
- The frame route serves a member's app without an audit row (the template is not team data and
  calls are audited). Say if a read audit is wanted.
- Should the e2e spec also run the admin preview route (needs a site admin and a drifted
  template)? Left out: same headers and helpers.
