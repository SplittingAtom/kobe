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

MA-4 LOW-1 (`Sec-Fetch-Dest: iframe`) is on both frame routes. MA-2/3 L2: no `/v1` GET writes,
and Better Auth sign-out is a POST, so a frame navigating itself inside Kobe changes nothing.

## Tests and checks

- web: `lib/apps/host-bridge.test.ts` (16), `app-api.test.ts` (4), `components/apps/
app-frame.test.tsx` (5); all web 2,010 passed.
- server unit 2,106 passed; db 598 passed; DB `team-apps.db` (13 with the new frame/tools/busy
  tests), `connector-template-review.db`, `mcp.db`: 59 passed.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `license:check`: green.

## Review fixes (review-ma5: MEDIUM-1, MEDIUM-2, LOW-1..8), 0dd6d460..bd32ad7b

- **MEDIUM-1:** `AppFrame` renders a keyed `FrameInstance` (`frameKey`: app, team, template
  hash, `cardKey`), so any change is a fresh iframe; the bridge binds to its first window and
  posts nothing after `detach` (late answers dropped). Tests in `app-frame.test.tsx` and
  `host-bridge.test.ts`.
- **MEDIUM-2 (coordinator decision):** CSP adds `child-src 'none'` and `webrtc 'block'`; every
  frame document (both routes) starts with `WEBRTC_GUARD` after its doctype, removing
  `RTCPeerConnection`, `webkit`/`moz` variants and `RTCDataChannel` (pinned bytes and hashes
  unchanged). Spec T3 and §3 residual risks amended. Browser results (local harness):
  Chromium (Playwright 1.55, build 1187) and WebKit 26: constructor absent in the frame; a fresh `about:blank` realm
  throws `SecurityError` (child frames blocked); both with and without the `sandbox`
  attribute. Firefox: not run (Playwright's Firefox does not start on this Mac); run
  `KOBE_ALL_BROWSERS=1` in the Playwright container at the gate.
- **LOW-1/2:** 40 messages per second per frame, counted before measuring or parsing
  (cheap length check for strings and buffers); `initialized` honoured once.
- **LOW-3:** calls one at a time per frame, 4 admitted; `validation_busy` retried once (250 ms).
- **LOW-4:** `AppFrameHandle.teardown(ms)` (ref); any answer counts as torn down.
- **LOW-5:** `host-bridge.interop.test.ts` drives the real ext-apps `App` 2.0.3 against the
  bridge (initialize, tool-input, tools/call, message, context, display mode, open-link and
  resources/read refused, teardown). ext-apps, `@modelcontextprotocol/core`/`client` 2.3.1 are
  web **devDependencies** only (MIT/Apache-2.0, `licenses:update` run).
- **LOW-6:** `KOBE_REQUIRE_APP=1` fails instead of skipping; CSP parsed (`sandbox` exactly
  `allow-scripts`, no `allow-same-origin`); a second frame without the attribute.
- **LOW-7:** `ui/message` capped at 4 KiB of UTF-8. **LOW-8:** frame-route tests for a member
  without a key (404) and a removed member (403); `/tools` takes the calls' rate limit.

## Notes for MA-9

- Owners call `AppFrameHandle.teardown()` before removing a frame; pass a `cardKey`.
- `ui/message` and model context answer "refused" until MA-7 wires the composer.
- The frame route writes no audit row (coordinator decision 1).
