# Kobe — MCP Apps Host (companion to Catalyst spec 0612ef17)

Status: **approved 2026-10-19 by Chris** (Hadron project `kobe`, spec
`7119888c-0058-419c-b6df-37ae09687433`, KOBE-432). Version 0.2, 2026-10-19: per Chris, the
**conversation is where apps render**. The rail is a launcher that inserts an app card into the
thread, and the artifact column is only the "expand" view.

Contract: Catalyst spec `0612ef17-bc24-40e4-a40d-c1bba08ca2ce` ("Catalyst MCP Server — Go Rebuild &
MCP Apps", v1.0 agreed 2026-10-18), §8 "Requirements on the Kobe Host", plus M6, M10–M13 and the
§5 app allowlist. Catalyst's own gates do not depend on Kobe (M24). This spec owns the **Kobe
Explorer Gate**.

Depends on KOBE-431 (probe credentials, done in G10) and KOBE-303 (site-wide keys, done in G10).

## 1. Summary

Kobe becomes a host for MCP Apps (the `io.modelcontextprotocol/ui` extension of MCP 2026-07-28).
A connector's `ui://` templates are pinned like its tools.

**Apps render in the conversation.** When the model calls a tool that carries `_meta.ui`, the
tool's card in the thread renders the pinned template with the tool's full result, captured by
Kobe's MCP proxy straight from the upstream. When a member launches an app from the Workspace
Rail, Kobe inserts an **app card** into the current thread: a thread entry with no model turn,
which the model sees in its history as an untrusted text result. Either card can be expanded into
the artifact column. Kobe renders apps in a sandboxed, network-less iframe and answers their
`tools/call` requests through the same server-side decision as every other MCP call.

The first app is Catalyst's **Lakehouse Explorer**. Kobe carries no Catalyst-specific code: any
connector that follows the same rules gets the same treatment.

An app runs with exactly the authority of the member viewing it, over **read-only** tools of
**its own connector**. It cannot reach the network, Kobe's origin, other connectors, the sandbox
or the model directly. Anything it wants to put in front of the model goes through the member:
either as text in the composer that the member sends themselves, or as a context chip they can
see and remove before sending.

## 2. Where this sits among the Kobe decisions (D1–D32)

| Decision                              | How this spec relates to it                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D27** MCP                           | It extends D27. D27 lists "MCP resources/prompts UI" as _later_. This spec brings forward **only `ui://` templates rendered as apps**, and keeps everything else D27 says. Resources stay unavailable to Pi, and data is never read through `resources/read` (Catalyst M13 agrees). Templates are pinned and drift exactly like tools. **Chris must approve this amendment (Q1).** |
| **D29** Policy                        | Unchanged. App calls go through the same decision, at a new enforcement point `app_bridge`, in a mode stricter than `auto`: allowed only if read-only and not denied. Nothing is ever prompted.                                                                                                                                                                                    |
| **D25** Artifacts                     | The same isolation pattern: an opaque-origin iframe loaded from a Kobe frame route whose header CSP carries `sandbox` (amended 2026-10-19). It is stricter here: `allow-scripts` only, without `allow-forms`, and no network.                                                                                                                                                      |
| **D9** One active team                | An app belongs to the active team. Switching team destroys every open app frame.                                                                                                                                                                                                                                                                                                   |
| **D10** Break-glass                   | Break-glass grants are never used to call connectors, so they never open apps.                                                                                                                                                                                                                                                                                                     |
| **D32** Schedules, skill evals        | Not involved. Apps run only in a member's browser session.                                                                                                                                                                                                                                                                                                                         |
| **D31** Audit                         | Every app call is audited. So are pins, drift and approvals of templates.                                                                                                                                                                                                                                                                                                          |
| **D3** Licences                       | Only MIT and Apache-2.0 libraries are used (§9).                                                                                                                                                                                                                                                                                                                                   |
| **D15** Persistence, **D16** wire     | Full structured results of UI tools are stored with the thread entry, and a rail launch is a new kind of thread entry (MA11). `tool.result` gains an `app` marker. Postgres stays the record.                                                                                                                                                                                      |
| **D17** Mid-run input                 | A rail launch during a run is queued like a message and inserted when the run ends (MA11).                                                                                                                                                                                                                                                                                         |
| **D18** Retention, legal hold, export | App results and app cards follow the thread: purged with it, held by legal hold, copied by fork. Exports carry only the text (MA10).                                                                                                                                                                                                                                               |
| CE2/CE5/CE6/CE12/CE13                 | Tool cards (CE12) render apps inline. The rail gets an "Apps" launcher. The artifact column (CE6) is only the "expand" view. Icons have tooltips.                                                                                                                                                                                                                                  |

## 3. Threat model

**Assets:** the member's connector credential (a grant or the site key); the member's Kobe
session and team data; the integrity of what the model sees and does; other connectors' data.

**Adversaries:**

1. A compromised or malicious MCP server, or a template that changes upstream after review (a
   rug-pull).
2. A template with an XSS-style bug that someone else's data can trigger (for example, a table
   named `<script>`).
3. Other frames or windows trying to talk to Kobe's bridge.
4. Prompt injection: data from the connector that ends up in the model's context.
5. A member trying to exceed their authority through the app path (for example, calling write
   tools without approval).

**Controls:**

- **T1. Pinned templates only.** Kobe renders only template bytes it pinned and a site admin
  approved, served by the Kobe server from Postgres. The browser never fetches the template from
  the upstream, and neither does the sandbox. A template that changed upstream is `drifted` and
  is not rendered until it is re-approved (§5).
- **T2. Iframe isolation.** The frame is `<iframe sandbox="allow-scripts" src=…>` loading Kobe's
  app frame route (MA4, amended 2026-10-19: never `srcdoc`, which inherits Kobe's page CSP and
  blocks the template's inline scripts). Without
  `allow-same-origin` its origin is opaque: no Kobe cookies, storage or DOM. Without
  `allow-top-navigation*`, `allow-popups`, `allow-forms`, `allow-modals` or
  `allow-downloads`, it cannot navigate, open windows, submit forms or download. No `allow`
  permission policy is granted (no camera, microphone, geolocation or clipboard-write).
  `referrerpolicy="no-referrer"`.
- **T3. CSP.** The frame route sends the policy as a **response header** (amended 2026-10-19; no
  injected meta CSP): `sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline';
style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none'; connect-src
'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri
'none'; form-action 'none'; frame-ancestors 'self'; webrtc 'block'`. The `sandbox` directive gives
  the document an opaque origin even when it is opened top-level, like D25's artifact frames.
  `connect-src` does not govern WebRTC, so the CSP3 `webrtc 'block'` directive is added for the
  browsers that enforce it, and the frame route puts a small script before the template's bytes
  that removes `RTCPeerConnection`, `webkitRTCPeerConnection`, `mozRTCPeerConnection` and
  `RTCDataChannel` (amended 2026-10-19, KOBE-437 review MEDIUM-2; defence in depth, see the
  residual risks below).
  A `_meta.ui.csp` the server declares (domains to connect to, load resources from or frame) is
  **ignored in v1**: no app gets network access. Catalyst omits it (M11). Kobe's web CSP keeps
  `frame-src 'self'` / `about:` only, so no other frame is possible.
- **T4. postMessage discipline.** The host listens on `window` and handles a message only when
  `event.source === frame.contentWindow` for a frame it created. An opaque origin always reports
  `"null"`, so the source check is the binding, and `event.origin` must also be `"null"`.
  Replies go only to that `contentWindow`. The target origin is `"*"` by necessity, because an
  opaque origin cannot be named, so a reply never carries anything the app is not entitled to.
  Every message is JSON-RPC 2.0, parsed by a zod schema per method. Anything unknown or malformed
  gets a JSON-RPC error and is dropped. Each frame is limited to 64 KiB per message, 10 requests
  per second and 4 calls in flight.
- **T5. A narrow bridge.** The host answers only the methods in §7. `tools/call` is allowed only
  for tools of the **same connector** that are pinned (not drifted), `readOnlyHint: true`, with a
  visibility that includes `"app"`, and exposed to the team (§6). The app can never call another
  connector, `resources/read`, `sampling`, `elicitation`, open a link or download a file.
- **T6. No credential in the browser.** The browser and the iframe never see a key or token. The
  server reveals the member's credential (their grant, or the KOBE-303 site key), passes it only
  to mcp-proxy over the internal port, and mcp-proxy attaches it to the upstream request (D27). The
  sandbox is not involved.
- **T7. The browser principal** (§6) is the signed-in member and the active team, with no thread
  and no run. It cannot obtain approvals, so anything that is not read-only is denied, and no
  `tool_rules` allow-rule can widen this in v1.
- **T8. The member mediates everything sent to the model.** `ui/message` only fills the composer
  draft and never sends. `ui/update-model-context` shows a visible, removable chip that is sent
  with the member's next message as an **untrusted data** block. Nothing from an app reaches the
  model without a member action, and it is fenced as untrusted when it does (§8).
- **T9. Spoofing.** The app's frame always sits under a host-drawn header that Kobe renders
  outside the iframe ("App from _connector name_", with the connector icon). The app can never
  cover Kobe's chrome: its "fullscreen" display mode means the expanded view in the artifact
  column, never the window. This means the frame can never pass for a Kobe sign-in or approval dialog.
- **T10. Limits and audit.** Tool arguments are capped at 64 KiB and results at 4 MiB (the
  proxy's existing cap). App calls are rate-limited per member: a burst of 30, then 5 per second.
  Each one is audited as `mcp.app_call` (team scope: connector, tool, user, decision, reason,
  template hash; never arguments or results).

- **T11. Results come from the upstream, not the sandbox.** The full result an app renders is
  captured by mcp-proxy from the upstream response and reported to the server under the internal
  key (MA10). The sandbox, Pi and the model cannot forge or alter it: a compromised sandbox can
  only affect Pi's own text entry, which renders as text. A rail-launched card's result comes from
  the server's own call (§6). The app's `tool-input` is the input the upstream ran, stored with
  the result, never Pi's entry. (Amended 2026-10-19, KOBE-438 review: the proxy cannot see Pi's
  tool-call id, so a result is stored under a server-signed capture ticket and claimed by the
  run's `tool.result` as described in MA10.) What a compromised sandbox can still do: attach a
  genuine upstream result of its own run to a tool call id of its choosing, and, because it names
  the thread on each call (as for every MCP call since KOBE-62), store it under another active run
  of the same member in the same sandbox. Either way the data is the member's own, from the
  upstream.
- **T12. Each viewer acts as themselves.** A stored result is shown to whoever can already read
  the thread (it is team data, like the text result). The app's further calls always run under the
  **viewer's** browser principal, never the author's. A viewer who cannot call the connector, or a
  thread whose template drifted or was removed, gets the text card (MA10). Break-glass readers
  (D10) always get the text card.
- **T13. Many frames.** A thread can hold many app cards. Frames are created only near the
  viewport, at most 3 run live per thread, and each frame keeps the T4 limits, so a long thread
  cannot exhaust the browser or flood the server.
- **T14. What the model sees of an app card** is the opening tool's **text** result, fenced as
  untrusted data and marked as opened by the member (MA11). The structured result and the
  template never enter the model's context.

**What remains (accepted):**

- An app can show the member misleading content about their own data. This is no worse than the
  connector's own text results.
- An app can put misleading text in the composer. The member reads it before sending.
- Connectors-off (KOBE-451) holds on app calls only when the call names the thread (KOBE-460):
  a picker in a new conversation names none, and the member's own session could leave it out.
  It is the member's per-conversation choice, not a permission; an off connector's context is
  still refused at send.
- The upstream sees each call under the member's credential (or the shared site key, KOBE-303).
  The upstream's own authorization applies, as it does for model-initiated calls.
- **WebRTC in browsers without `webrtc 'block'`** (amended 2026-10-19, coordinator decision on
  the KOBE-437 review). Chromium does not enforce the directive, and `connect-src` does not cover
  ICE. An approved but malicious template (or a template bug that third-party data triggers)
  could get past the removal script, for example from another realm, and leak tool results or
  tool input over STUN or TURN (a server name, a username, UDP). The mitigations are the site
  admin's review of the hash-pinned template (T1, §5), the removal script, and `webrtc 'block'`
  where browsers enforce it. The KOBE-437 browser test records what each browser does: in
  Chromium and WebKit the constructor is gone and a fresh `about:blank` realm is blocked
  (`frame-src`/`child-src 'none'`), so "another realm" is theoretical there today; Firefox is
  measured at the gate.
- **A sandbox run naming another of the member's running threads** (added 2026-10-20,
  coordinator decision on the KOBE-451 re-review, R-1; on Chris's gate list). The MCP decision
  point allows only connectors in the named run's `run.start.mcp` and not off in its thread, but
  the thread is the sandbox's claim: code started by one thread's run can name another of the
  same member's running threads in the same sandbox and use that run's connectors. Every call is
  still the member's own, decided under every active run's policy (review M1) and audited; the
  member's "off for this thread" does not hold against their own other running thread.

## 4. Decisions

Decisions are numbered MA1, MA2, …; the proposed tickets in §10 are MA-1, MA-2, ….

**MA1. Scope: `ui://` templates rendered as apps; no other resources.** Kobe probes
`resources/list` and reads only the `ui://` resources that pinned tools reference through
`_meta.ui.resourceUri`. Resources stay "method not found" for Pi at the proxy. Prompts, other
resource schemes and `resources/templates/list` are out of scope. _Rejected:_ a general resources
UI (D27 "later"; data would bypass tools, against Catalyst M13).

**MA2. Rendering stack.** The web app hosts frames with the ext-apps **`AppBridge`**
(`@modelcontextprotocol/ext-apps` v2.x, MIT) **if** a spike (ticket MA-5) confirms three things:
it can be driven without a live MCP client in the browser (Kobe proxies `tools/call` through its
own API); every method handler can be overridden or denied; it works in a frame loaded from
Kobe's frame route (MA4 as amended), not `srcdoc`; and its peer dependencies
(`@modelcontextprotocol/core`/`client`, Apache-2.0) do not ship transport code that the CSP or
bundle budget rejects. Otherwise Kobe writes a thin host bridge of its own (about 300 lines, zod,
against the ext-apps specification text). Kobe's own code does the iframe creation, the frame
route with its header CSP (as D25's frame routes) and the source checks either way. No assistant-ui MCP Apps
renderer was found in the published `@assistant-ui/*` packages as of 2026-10-19
(`@assistant-ui/react` 0.15.29). If one ships, it is weighed in the same spike. _Rejected:_ the
ext-apps "sandbox proxy" double-iframe on a second origin, because it needs a second hostname and
TLS certificate (D25 removed the artifact hostname for this reason), and a single opaque-origin
iframe with a meta CSP gives the same isolation for templates that need no network.

**MA3. Apps render in the conversation; the rail launches; the artifact column expands.**
(Chris, 2026-10-19.)

- **In the conversation (primary).** A tool card (CE12) whose tool carries `_meta.ui` with a
  pinned template renders the app inline under the card's header (MA10).
- **The rail "Apps" section (secondary)** is a launcher. It sits in CE5 order Threads, Apps,
  Files; it is hidden when the team has no app and has an icon in the 48 px collapsed rail.
  Clicking an app inserts an **app card** into the current thread (MA11). It does not open the
  artifact column.
- **Expand (secondary).** Every app card, whether from a tool or from the rail, has an "Expand"
  control. It moves the live frame into the artifact column (CE6) as a transient tab of kind
  `app`: not an artifact, no versions, nothing stored. The card in the thread shows "Opened in the
  side column" until the tab closes, and the frame then returns to the card. There is only ever
  one live frame per card. Below 768 px, expand opens the full-screen sheet (CE8).

_Rejected:_

- The artifact column as the main surface: an app's output belongs to the moment in the
  conversation that produced it, and the model refers to it there.
- Rendering inside the 280 px rail: too narrow for a tree and a preview (Catalyst's own breakpoint
  is 480 px). Picker apps are now the exception (amendment below).

_Amended 2026-10-20 (Chris, KOBE-460): picker apps may render live in the rail._ The Apps tab has
two sections. Below, the app list exactly as before (every app, pickers included; a click inserts
an app card, MA11). Above, a **Pickers** section, hidden when the member has no live picker: a
dropdown of None and the live apps (MA8) whose display name contains "Picker" (case-insensitive;
choice 4), remembered per member (`rail_picker`, a layout preference); the chosen one renders
live in the section, laid out like the Files tree (it fills the section and scrolls inside it).
One live picker frame at a time; a picker that stops being live (drift, connector off for the
team, key gone) falls back to None with a short note.

1. Its `ui/message` inserts into the composer draft of the conversation on screen (or the
   new-conversation draft), with the §8 marker and gate; `ui/update-model-context` attaches its
   chip there. Nothing is sent without the member and nothing is stored in a thread.
2. Selecting a picker widens the rail to at least 400 px when the window allows (the drawer to
   `min(400px, 85vw)`); None restores the member's own width, which is never overwritten by the
   widening. The member can still drag it wider.
3. The bottom list keeps every app.
4. A picker is recognised by "Picker" in the display name; nothing else marks it.
5. It opens like a card: each time it is shown, Kobe calls its opening tool (the MA11 launch
   tool, with `{}`) through the call route below, naming the thread on screen, and gives the
   frame `ui/notifications/tool-input` (`{}`) and `tool-result` after initialize. Nothing is
   stored. A failed open shows a short error and Retry; `connector_off` shows the note above.

Security is the cards': the same member frame route and header CSP (MA4, `sandbox
allow-scripts`), only pinned, approved, not drifted templates, MA8 visibility, and the same bridge
(§7). Its `tools/call` goes through `POST /v1/team/apps/{appId}/calls` under the member's browser
principal with every §6 check. It has no card, so it names the thread on screen (`thread_id`):
the server then also refuses a thread the member may not read (`thread_not_found`) and one where
the app's connector is off (`connector_off`), both audited `mcp.app_call`. In a new conversation
it names no thread, and Kobe does not run it while the draft has its connector off. The picker
runs only while the Apps tab is on screen in an expanded rail.

**MA4. Server-mediated `resources/read`, never the sandbox.** Templates are fetched only by the
server's pin and refresh probes, through mcp-proxy's internal probe endpoint (server key only,
with the KOBE-431 probe credential), and stored in Postgres. **Amended 2026-10-19 (coordinator,
KOBE-434 Q1):** a frame gets the template from a Kobe **frame route**, the way D25 serves
artifacts: `text/html` only with the header CSP of T3 (`sandbox allow-scripts`, so an opaque
origin even top-level; `default-src 'none'`; inline script and style only; no network),
`X-Frame-Options: SAMEORIGIN`, `no-store`, `nosniff`, and only into a frame of Kobe's own page.
No `srcdoc` and no meta CSP. A template therefore never runs as Kobe's origin. Two routes, never
one with a flag: the site-admin review preview (KOBE-434,
`GET /v1/site/connectors/{id}/templates/frame?uri=&version=live|approved`, which may show
unapproved bytes) and MA-5's member route, which serves only pinned, approved templates. Every
other template read (the review's source, `GET /v1/team/apps/{appId}/template`) is JSON with
`Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: default-src 'none'`.

**MA5. Browser principal and the decide pipeline.** It is defined in §6. The decision reuses the
policy engine with `enforcement_point: "app_bridge"` and `mode: "app"`. The evaluation order is
install deny → team deny → install or team ask (→ **deny**, with reason `app_no_prompt`) → risk
class (anything other than `read` → **deny**, `app_read_only`) → allow. User allow-rules are not
consulted, so they cannot widen the result.

**MA6. Visibility.** A tool's `_meta.ui.visibility` (default `["model", "app"]`) is pinned as part
of the tool's `annotations` and `_meta` snapshot. Two rules follow:

- A tool whose visibility lacks `"model"` is **not offered to Pi** (catalog and proxy `tools/list`).
- A tool whose visibility lacks `"app"` is **not callable from apps**.

A change of visibility is a change to the pinned definition, so it is drift.

**MA7. Model context from apps is member-visible and untrusted.** See §8. _Rejected:_ invisible
context injection (the member could not see what the app told the model) and auto-sending
`ui/message` (an app could otherwise drive the model without the member).

**MA8. Who sees an app (§8.7).** An app is live for a member (shown in the rail, rendered in a
card) only when all of these hold:

- the connector is active and enabled for the active team, with an exposure that includes the
  opening tool;
- the opening tool and its template are pinned and not drifted;
- the member **can call the connector**: it is `none` auth, or it uses a KOBE-303 site key that
  is set and not stale, or the member holds a live grant of the connector's kind (an API key, or
  an OAuth token that is not expired or can be refreshed).

Otherwise the app is absent from the rail, and cards render as text (MA10). A connector whose app is missing only because the member has no key
shows an "Add your key" hint linking to My connector keys.

**MA9. Template size and type.** At most 512 KiB, `mimeType` exactly `text/html;profile=mcp-app`,
and valid UTF-8. Anything else fails to pin, with `ui_resource_invalid`. Catalyst's file is at
most 300 KB by its own CI (M19).

**MA10. Apps in the conversation: full results, stored with the thread (ticket MA-9).**

- **Capture.** Today the web gets only a text preview of at most 64 KiB (`tool.result.preview`,
  plus a `blob_ref` for larger output, D15), and Pi's MCP client keeps only the text. For a call
  to a pinned tool whose `_meta.ui` names a pinned, non-drifted template, **mcp-proxy** reports the
  upstream's full result to the server (`POST /internal/v1/mcp/connectors/{id}/results`,
  internal key and the sandbox's own token). This happens before the proxy returns the result to
  Pi. The result is untrusted upstream data and is never taken from the sandbox (T11).
  _As built (amended 2026-10-19, KOBE-438):_ Pi's MCP client sends no tool-call id, so the
  server's allow carries a **capture ticket** (an HMAC over team, user, sandbox, thread, run,
  connector, tool, the input's canonical digest and the template). The report sends the ticket,
  the input (its digest must match) and the result; it is stored **unclaimed**. When the run's
  `tool.result` arrives (always after its own report), it claims the row with the same run, tool
  and input digest **only if exactly one** is pending: two identical calls in parallel stay text,
  because the reports' order need not be Pi's. A run's unclaimed rows (and blobs) are dropped when
  the run ends, in any end state, and at most 20 may wait per run.
- **Storage.** A team table `thread_app_results (team_id, thread_id, tool_call_id | entry_id,
connector_id, tool, template_uri, template_sha256, result jsonb | blob_ref, bytes,
created_at)` with `team_id NOT NULL`, ENABLE and FORCE RLS, and a policy through `withTeam()`.
  Results of up to 256 KiB are stored inline; anything larger, up to the proxy's 4 MiB cap, goes
  to S3 under the team's prefix (`blob_ref`, D15); anything bigger is not stored and the card
  renders as text. Rows are written only for calls that ran (allowed by policy), are linked to
  the thread entry by `tool_call_id`, and are counted in the team storage quota (D26).
- **Protocol.** `tool.result` gains an optional `app: {connector_id, app_id, template_sha256,
result_ref}` marker, and `thread_entries` projections expose the same marker. This change goes
  to `packages/protocol` in **its own PR**, agreed before the feature PRs
  (`docs/parallel-work.md`). The web fetches the result with
  `GET /v1/threads/{threadId}/app-results/{ref}` (thread read permission; `no-store`; JSON) and
  the template with `GET /v1/team/apps/{appId}/template?sha256=…`.
- **Retention, legal hold, export, fork (D18).** Rows and blobs are purged with their thread
  (retention period, Trash purge, the nightly job counts them in the audited purge) and are held
  by legal hold like entries. A **fork** copies the rows of the copied entries into the new
  thread (same team). **Exports** (Pi JSONL and Markdown) carry only the text result: never the
  structured result, never the template.
- **Rendering.** The tool card renders the template with the stored result in the MA-5 frame.
  The host sends `ui/notifications/tool-input` and `tool-result` from the stored data, so a
  reload **rebuilds** the app from the record without calling the upstream. The app's own later
  calls go through §6 under the **viewer's** browser principal, read-only.
- **Text fallback.** The card shows Pi's text result (today's tool card) instead of the app when
  any of these holds:
  - the template drifted or was removed, or its pinned hash differs from the result's
    `template_sha256`;
  - the viewer cannot call the connector (MA8), or is reading through break-glass;
  - the tool's visibility lacks `"app"` (MA6);
  - the result was too large to store;
  - the frame cap (below) is reached and the card has not been asked to load.

  The card says which of these applies in one line ("This app changed and is waiting for review",
  "Connect Catalyst to use this app", and so on).

- **Shared threads and forks.** A viewer of a shared thread (KOBE-163) sees the app if they can
  call the connector in the thread's team, acting as themselves (T12); otherwise they see the text.
- **Performance.**
  - A fixed default height of 360 px, which the app may grow to at most 720 px inline through
    `size-changed` (beyond that it scrolls or offers Expand).
  - Frames are created only when the card is within one viewport of the visible area
    (IntersectionObserver) and are torn down when they leave it by more than three viewports. A
    torn-down card keeps a static snapshot: the last height and a "Loading app" placeholder.
  - At most **3 live frames per thread**. Further cards show "Show app" and load on click, which
    retires the frame least recently in view.

**MA11. Rail launch inserts an app card: a thread entry with no model turn.** (Chris,
2026-10-19.)

- **What happens.** Clicking an app in the rail calls its opening tool under the member's browser
  principal (§6) with no arguments, stores the result (MA10, keyed by `entry_id`) and appends an
  **`app_card` thread entry** to the current thread. Its parent is the thread's leaf, and it
  becomes the new leaf. It carries `{connector_id, app_id, tool, template_sha256, result_ref,
opened_by: user_id}` and the text result. It is not a run: no run row, no `run_events`, no
  model call, no budget spend.
- **Pi and the model.** The entry is mirrored into Pi's session as a `custom_message` entry
  (custom type `kobe.app_card`), so the **model sees it in the next run's history**. Its content
  is the opening tool's text result, capped at 8 KiB, fenced as
  `<app-card source="connector:<name>" tool="<tool>" opened_by_member="true" untrusted="true">…</app-card>`
  after one fixed sentence saying it is data a member opened, not instructions. This mirrors how a
  model-initiated tool result reads. The structured result stays out of context (T14). The
  sandbox agent appends the entry while the thread's Pi is stopped, as it already does for branch
  markers (`appendBranchMarker`). The server writes the Postgres entry at once and the agent
  catches the session file up at the next run start, so a launch never wakes a sandbox (D14).
  _Verify in the ticket:_ the exact Pi 1.0.x `custom_message` shape, and that it enters the
  model's context (the branch marker's `custom` type does not). _Verified (KOBE-440):_ Pi 1.0.0
  `{type: "custom_message", id, parentId, timestamp, customType, content, display, details}`;
  `convertToLlm` gives the model a user message of `content`, `details` never
  (`app-cards.real-pi.test.ts` against the pinned Pi). Card ids are `ka-` and 24 hex characters,
  server-only like `ks-`/`ku-`; the next `run.start` carries the cards Pi lacks
  (`app_cards`, capability `app_cards`; an older agent starts below them), and a new thread's
  session is started from its first card.
- **No current thread** (the new-thread view): Kobe **starts a new thread** in the active team
  with the team's default agent, titled after the app ("Lakehouse Explorer"). The app card is its
  first entry. The member's first message then continues that thread.
- **During an active run: queue (chosen).** A launch while the thread has an active run joins the
  thread's queue (D17), shown as a chip "App: _name_ (waits for the run)". It is inserted when the
  run ends, under the same one-active-run advisory lock, before the next queued message starts its
  run, and the opening tool is called at insertion time, so the data is current. The chip can be
  removed like a queued message, and while it waits the member may **Expand** it into the
  artifact column (a transient view, not an entry).

  _Amended 2026-10-19 (KOBE-440, for review):_ the opening tool is called **at the click**,
  through the MA-4 path, and the waiting row keeps the result and the card's text; the run's end
  only inserts the entry (`promoteInTx`, under the thread lock, never an upstream call while the
  lock is held). That is what lets a waiting chip expand; its data is from the click. A launch
  from a thread shared read-only or in Trash starts a new thread, like the new-thread view.
  At insertion each waiting card is re-checked (connector active and enabled, the same pinned
  and approved template, the member's grant or site key) and dropped, audited
  `mcp.app_card_dropped` and announced in the chat, when that fails or it waited more than 10
  minutes. Waiting cards go in whenever no run is active (also during Stop's abort hold, and
  before a later launch's card).

- **No app card may leave a thread unable to run** (coordinator rule, KOBE-440 review): its
  content is capped after escaping and validated before it is written; its parent is never an
  unsent prompt (`ku-`) Pi never had; at most 20 cards follow each other (a 21st launch is
  refused, 409 `too_many_cards`; a waiting one is dropped), so one `run.start` carries the whole
  chain. Launches have their own rate limit (a burst of 5, then one every 2 s per member).

  _Why queue:_ it is what Enter does during a run (D17), so the member's click is never lost. It
  also keeps the entry tree linear: inserting mid-run would add a sibling under a leaf Pi is still
  writing to and fork the thread.

  _Rejected:_ refusing while a run is active, which forces the member to wait and click again for
  no safety gain, since the queue gives the same ordering guarantee.

- **Removing.** An app card is deleted like other member content: hidden from the model's next
  run by a `context_edit` entry (D15), so history keeps the record.

## 5. Pinning `ui://` resources (§8.1)

- **Probe.** The pin probe and the periodic refresh (KOBE-102, KOBE-431) call mcp-proxy
  `POST /internal/v1/probe` with `{url, api_key?, ui_resources: [uri…]}`. The URIs are the
  distinct `_meta.ui.resourceUri` values of the live tools. The proxy runs `resources/list` and
  then `resources/read` for each URI that is listed (and only those; a URI must start with
  `ui://`). It applies the same address policy and the same size and time caps, and returns
  `{tools, ui_resources: [{uri, mimeType, text, meta}]}`. Pi's `/v1/mcp` path is unchanged:
  `resources/*` stays "method not found".
- **Pin.** Kobe computes `sha256` over the template bytes **itself**. The server-provided
  `_meta["io.splittingatom/contentHash"]` (Catalyst M6) is only cross-checked: if it differs, the
  pin fails with `ui_resource_hash_mismatch`. The pinned hash covers the canonical JSON of
  `{uri, mimeType, sha256(text), meta.ui}` (csp, permissions, domain, prefersBorder), so changing
  the declared CSP or permissions is drift too.
- **Storage.** A site-wide table `connector_ui_resources (connector_id, uri, mime_type, html,
sha256, pinned_hash, status pinned|drifted, proposed jsonb, pinned_by, pinned_at)`. It holds no
  team data, has the `ALL_PRIVILEGES` grant in `tenancy/connectors.ts` and cascades with its
  connector. A drifted entry keeps the approved bytes and carries the live ones as `proposed`,
  like tools.
- **Drift (D27 rules).** A changed template is `drifted` and is not rendered: the rail hides the
  app and open tabs show "This app changed and is waiting for a site admin's review". A new
  template is `drifted` until approved. A template the server no longer lists is removed. Drift is
  in the same `mcp.connector.drift` event (new field `templates: {changed, added, removed}`), the
  same email and the same in-app notice.
- **Review.** The site admin's tool review (KOBE-102) shows changed templates with the old and new
  hash, size, declared `_meta.ui`, a source diff (escaped text, never rendered), and an optional
  **preview** in the same kind of sandboxed frame (the admin frame route, MA4) with the bridge
  stubbed: calls fail and nothing reaches the upstream. The source response carries the hashes
  and meta of the same read, and approval sends that hash. Approval names the reviewed hash, and a stale hash is refused, like tools.
- **Credentials.** Probes use `chooseProbeCredential` (KOBE-431: the site key, else the key of the
  admin who pinned it). The template therefore drift-checks on the same schedule as the tools, and
  an `auth_required` skip is surfaced the same way.

## 6. The browser principal and app calls (§8.3, §8.4)

**Principal:** `{kind: "browser", userId, teamId}`, taken from the Better Auth session and the
active team (D9). The `x-kobe-team` header must match (the multi-tab guard). It has no sandbox,
thread or run. It needs the `team.chat` permission. A deactivated user's session is revoked
(D7), so their calls stop at once.

**API (web → server):**

- `GET /v1/team/apps` lists the member's apps:
  `[{appId, connectorId, connectorName, iconUrl, tool, title, uri, sha256}]`. `appId` is the
  SHA-256 of `connectorId:uri`.
- `GET /v1/team/apps/{appId}/template` returns `{html, sha256, connectorId, uri}`
  (JSON only, MA4).
- `POST /v1/team/apps/{appId}/calls {tool, arguments, thread_id?}` returns
  `{result} | {error: {code, message}}`. It serves the app's own `tools/call` from any card.
  Every frame names its thread as `thread_id` (KOBE-460): a card's frame (inline or expanded)
  its own thread, a rail picker (MA3 as amended 2026-10-20) the thread on screen.
- `POST /v1/threads/{threadId}/app-cards {appId}` (or `POST /v1/threads/app-cards {appId}`,
  which starts a new thread) performs the rail launch (MA11). It answers `{entryId}` when it
  inserted the card, or `{queued: true}` during a run.
- `GET /v1/threads/{threadId}/app-results/{ref}` returns the stored result (MA10).

**Server checks for each call**, in order (fail closed, one audit row each):

1. The app is visible to this member (MA8). The tool belongs to the app's connector. With
   `thread_id` (cards and pickers), the member may read that thread and the app's connector is
   not off in it.
2. The tool is pinned and not drifted, has `readOnlyHint: true`, a visibility that includes
   `"app"`, and is in the team's exposure. For `custom` exposure, the tool must be ticked.
3. `arguments` is a JSON object of at most 64 KiB, and validates against the pinned `inputSchema`
   (JSON Schema 2020-12, compiled once per pinned hash).
4. Policy (MA5) at `app_bridge` decides allow or deny.
5. The member's credential is revealed (`revealCredential`, which gives the grant or the site key
   with the full liveness chain, KOBE-303).
6. The server calls mcp-proxy's new internal endpoint
   `POST /internal/v1/app-calls {connector_id, url, tool, arguments, api_key|access_token}`
   (internal key only; same upstream client, address policy and caps as sandbox calls; the
   NetworkPolicy already admits the server). The proxy returns the `tools/call` result.
7. The server audits `mcp.app_call` (team scope: `{connectorId, userId, tool, decision, reason,
templateSha256}`) before forwarding, like `mcp.tool_call`, and returns the result.

**Not allowed in v1:** write, additive or destructive tools, even with an approval, a remembered
rule or `auto` mode. Approvals are bound to (run, tool call) and an app has no run. Calls that
take free SQL are excluded by the read-only and allowlist rules. For Catalyst, the app allowlist
in its §5 (`list_catalog_namespaces`, `list_namespace_tables`, `describe_table`, `preview_table`,
`open_lakehouse_explorer`) is exactly what these rules produce, and `query_sql_readonly` is not in
it because Catalyst does not mark it `"app"`-visible. Kobe does not hard-code the list.

## 7. Bridge methods (§8.6)

| App → host                                                                                                           | v1 behaviour                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui/initialize`                                                                                                      | Answered with `hostInfo`, `hostCapabilities` (no `openLinks`, no `downloadFile`, no `serverResources`) and `hostContext`: the theme CSS variables of Kobe's current theme, `displayMode` `inline`, `availableDisplayModes` `["inline", "fullscreen"]`, the locale and the container size. No user or team identifiers. |
| `tools/call`                                                                                                         | §6. The result goes back unchanged, apart from a size cap.                                                                                                                                                                                                                                                             |
| `tools/list`                                                                                                         | Only the tools the app may call (§6 rules 1–2).                                                                                                                                                                                                                                                                        |
| `ui/message`                                                                                                         | §8: inserted into the composer draft, never sent.                                                                                                                                                                                                                                                                      |
| `ui/update-model-context`                                                                                            | §8: a context chip, last write wins per app.                                                                                                                                                                                                                                                                           |
| `ui/request-display-mode`                                                                                            | `inline` (the card) or `fullscreen` (Expand into the artifact column); anything else is refused.                                                                                                                                                                                                                       |
| `ui/notifications/size-changed`                                                                                      | Honoured within the column; height capped at 4,000 px.                                                                                                                                                                                                                                                                 |
| `notifications/message` (logging)                                                                                    | Dropped. A debug counter only.                                                                                                                                                                                                                                                                                         |
| `ui/open-link`, `ui/download-file`, `resources/read`, `resources/list`, `sampling/*`, `elicitation/*`, anything else | **Denied** (JSON-RPC error `-32601`, with a Kobe-specific `data.reason: "not_allowed_in_kobe"`).                                                                                                                                                                                                                       |

| Host → app                                                       | When                                                                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `ui/notifications/tool-input` and `ui/notifications/tool-result` | When a frame loads: the card's stored arguments and result (a model's tool call, or a rail launch with `{}`).                    |
| `ui/notifications/host-context-changed`                          | On a theme change or resize.                                                                                                     |
| `ui/resource-teardown`                                           | When the card scrolls far out of view, the expanded tab closes, or on team switch, sign-out or drift. The frame is then removed. |

## 8. `ui/message` and `ui/update-model-context` (§8.6)

- **`ui/message`** with role `user` and text content inserts the text **at the caret of the
  composer draft of the card's own thread** (always the thread on screen, since frames run only
  for visible cards; a rail picker's, the conversation on screen or the new-conversation draft,
  MA3 as amended 2026-10-20). It **never sends and never moves the focus** (amended 2026-10-19,
  coordinator decision on the KOBE-439 review): the text carries a visible "From _app_" marker,
  and Enter and Send do nothing until the member edits it or confirms it, so an Enter pressed in
  the app cannot send it. Text is capped at 4 KiB, other content types are ignored, and text that
  imitates app context is refused. Catalyst's "Use in chat" therefore inserts `` Use table `c.n.t` ``
  for the member to edit or confirm, then send.
- **Items in `ui/message`** (KOBE-490, agreed with Chris 2026-10-23): a message may add MCP
  `resource_link` blocks `{uri, name, title?, mimeType?, _meta: {"io.kobe/item-kind": kind}}`
  (name 1–512 characters without backticks or control characters, uri at most 2048 and not
  `javascript:`/`data:`/`vbscript:`, at most 20 per message; any app and uri scheme otherwise).
  Each valid link becomes a removable chip in the composer's chip row of that thread (icon per
  kind, generic for unknown kinds, de-duplicated by uri), and the message's text is then not
  inserted; invalid links are dropped (a note in the chip row when nothing was usable). Chips
  never send anything themselves: the member's next message names those still shown
  (`references: [{name, kind}]`) and the server appends one fixed line after the member's text,
  ``Referenced: `cat.ns.orders` (table), …``, which history shows as the same chips.
- **`ui/update-model-context`** stores the latest `{content, structuredContent}` per open app
  (capped at 8 KiB serialized; anything larger is refused with an error to the app). The composer
  shows a chip, "Context from _Lakehouse Explorer_: _one-line summary_", with a remove button and
  an expandable view of the exact JSON. On the member's **next send** in that thread, the chip goes
  with the message as a message part `{type: "app_context", connectorId, appId, templateSha256,
data}`. It is stored in the user's thread entry, so it is visible in history and replayable
  (D15). The server hands it to Pi as a fenced block in the user turn:
  `<app-context source="connector:<name>" untrusted="true">…JSON…</app-context>`. The block is
  preceded by one fixed sentence saying it is data from an app, not instructions. After the send
  the chip clears, and a later selection makes a new chip. The context goes only to the thread it
  was sent with, and never to schedules or other threads.
- **Untrusted everywhere else** (amended 2026-10-19, KOBE-439 review): app context reaches only
  Pi's fenced prompt, the thread's history (as chips) and exports (escaped). Titles, thread cards,
  follow-up suggestions and eval-case copies read only the member's own text. Only the server
  writes the preamble and fences: member text that imitates them is refused. A queued message's
  context is checked at submit (not again at dequeue), and a retry resends the stored input
  unchanged; both accepted for v1. An edit of a queued message changes only the member's text.
- Neither path runs a model turn by itself. That is the point of the Kobe Explorer Gate: the app
  in the conversation, then a member action, then a run.

## 9. Licences (D3, `docs/licensing.md`)

| Component                                                                            | Version checked   | Licence            | Use                                                 |
| ------------------------------------------------------------------------------------ | ----------------- | ------------------ | --------------------------------------------------- |
| `@modelcontextprotocol/ext-apps`                                                     | 2.0.3             | MIT                | `AppBridge`, if MA-5 adopts it                      |
| `@modelcontextprotocol/core`, `@modelcontextprotocol/client` (its peer dependencies) | 2.3.1             | Apache-2.0         | types and JSON-RPC helpers that come with AppBridge |
| `@standard-schema/spec` (ext-apps dependency)                                        | 1.1.0             | MIT                | types                                               |
| `@assistant-ui/react` (already a dependency)                                         | 0.15.26 pinned    | MIT                | composer and chip UI                                |
| a JSON Schema 2020-12 validator for §6 rule 3 (for example `ajv` 8, MIT)             | at implementation | MIT, to be checked | server-side argument validation                     |

All are within the MIT, Apache, BSD and MPL family. The implementing ticket runs `pnpm
licenses:update` and commits `THIRD_PARTY_LICENSES.md` and `NOTICE`. If anything outside the
family appears, it is marked `pending: gate review`, as `CLAUDE.md` describes. Catalyst's
template is content, not a Kobe dependency: Kobe neither ships nor builds it.

## 10. Proposed implementation tickets (not filed; the coordinator files them after approval)

**Order:**

1. MA-1 pin templates.
2. MA-2 template review.
3. MA-3 visibility.
4. MA-4 browser principal.
5. MA-5 frame and bridge.
6. **MA-9 apps in the conversation.**
7. MA-7 composer and model context.
8. MA-6 rail launcher and app cards.
9. MA-8 the gate.

The conversation path (MA-9, MA-7) lands before the rail launcher (MA-6). The `packages/protocol`
changes of MA-9 and MA-6 go in their own PRs, ahead of the feature PRs. There is one migration per
schema ticket, with generated and custom SQL kept separate, and upgrade tests. The cross-team
probe suite must stay green.

**MA-1. Pin `ui://` templates (server, proxy, db).** The proxy probe gains `ui_resources`.
`connector_ui_resources` is added (a generated migration; site-wide). The pin, refresh and drift
logic covers templates, using the KOBE-431 credential. `mcp.connector.drift` gains a `templates`
field.

- ac-1: registering or pinning a connector whose tools reference `ui://` URIs stores each
  template with Kobe's own SHA-256. A mismatching `contentHash` or a size, type or encoding
  violation fails the pin with a clear code.
- ac-2: a changed template drifts and is not served. A new one stays drifted until approved. A
  removed one is removed. The drift event, email and notice name the templates.
- ac-3: Pi's `/v1/mcp` still answers `resources/*` with "method not found" (test).
- ac-4: the refresh uses `chooseProbeCredential`. An `auth_required` skip covers the templates too.

**MA-2. Template review for site admins (web, server).** The tool review gains templates: hash,
size, declared `_meta.ui`, an escaped source diff, a stubbed preview, and approval by the
reviewed hash.

- ac-1: approving with a stale hash is refused.
- ac-2: the preview's bridge reaches no upstream (test).
- ac-3: the review is audited (`mcp.connector.reapproved` gains `templates`).

**MA-3. Visibility (server, proxy).** `_meta.ui.visibility` is pinned. Tools that are app-only are
hidden from Pi's catalog and from the proxy's `tools/list`, and refused at `/calls`.

- ac-1: an app-only tool is never offered to or callable by Pi.
- ac-2: a visibility change drifts.

**MA-4. Browser principal and app calls (server, proxy).** It covers `GET /v1/team/apps`,
`GET …/template` (JSON, MA4 headers), `POST …/calls`, the `app_bridge` decision, mcp-proxy
`POST /internal/v1/app-calls`, the `mcp.app_call` audit event, rate limits and argument validation.

- ac-1: a member with a grant or a site key calls a pinned, read-only, app-visible tool. Write
  tools, drifted tools, tools of another connector, tools of a team that has not enabled the
  connector, and tools outside a custom exposure are all denied, and each denial is audited.
- ac-2: no key reaches the browser, a log line, an audit row or an event (tests over responses
  and captured logs).
- ac-3: a deactivated member and a member removed from the team are refused at once.
- ac-4: a team deny rule denies, and a user allow-rule does not widen.
- ac-5: the template endpoint never answers `text/html`.

**MA-5. Host bridge and app frame (web).** A spike decides between AppBridge and Kobe's own
bridge (MA2) and records the result in the ticket ledger. Then: `AppFrame` (Kobe's member
frame route with the T3 header CSP, as amended in MA4; `sandbox="allow-scripts"`, a host header, no `allow`
permissions, inline and expanded placement), the bridge (source and origin check, zod per method,
the §7 table, per-frame limits) and the licence inventory.

- ac-1: from inside the frame, `fetch`, `XMLHttpRequest`, `WebSocket`, `img` to a remote host,
  form submission, `window.open`, top navigation and reading `document.cookie` all fail
  (browser test).
- ac-2: messages from any other window are ignored.
- ac-3: `ui/open-link`, `ui/download-file` and `resources/read` are denied.
- ac-4: `pnpm license:check` is green.

**MA-9. Apps in the conversation (proxy, server, db, protocol, web).** MA10:

- result capture at mcp-proxy;
- the `thread_app_results` team table (generated migration; RLS policy in a separate custom
  migration; probe fixtures) and S3 offload;
- the `tool.result` `app` marker (protocol PR first);
- the result endpoint;
- retention, legal hold, fork and export handling;
- the tool card rendering the app in the MA-5 frame, the reload rebuild, the text fallbacks,
  Expand, lazy loading and the live-frame cap.

- ac-1: a model call to a UI tool stores the upstream's full `structuredContent` and `content`
  (inline up to 256 KiB, S3 up to 4 MiB, above that text only). The stored result comes from
  mcp-proxy, and a sandbox cannot write or change it (test with a forged report).
- ac-2: the tool card renders the pinned template with that result. The app's own calls go
  through MA-4 under the viewer, read-only, and are audited as the viewer.
- ac-3: a reload rebuilds the app from the stored result with no upstream call. A drifted or
  removed template, a viewer who cannot call the connector, a break-glass reader and a tool whose
  visibility lacks `"app"` each get the text card with the right one-line reason.
- ac-4: a viewer of a shared thread without access gets text. A fork copies the results. An
  export contains text only. Retention purge and legal hold cover the rows and blobs, and the
  cross-team probe suite covers the table.
- ac-5: the card's height defaults to 360 px and is capped at 720 px inline. Frames load only near
  the viewport. At most 3 are live per thread. Expand moves the frame to the artifact column and
  back.

**MA-7. `ui/message` and model context (web, server, protocol).** Composer insertion, the context
chip, the `app_context` message part (a protocol type in `packages/protocol`, agreed in its own
PR, as `docs/parallel-work.md` requires), its storage in the thread entry, and its rendering as a
fenced untrusted block for Pi.

- ac-1: `ui/message` never sends, and it targets the card's own thread.
- ac-2: the chip is visible and removable, and only what it shows is sent.
- ac-3: the block reaches Pi fenced and marked untrusted, and is in thread history and exports.
- ac-4: sizes are capped.

**MA-6. Rail launcher and app cards (web, server, protocol, sandbox-agent).** The rail section
(MA3, MA8) with icons and tooltips (CE13); `POST …/app-cards`; the `app_card` thread entry
(protocol PR first) and its Pi `custom_message` mirror; the new-thread case; queueing during a
run (D17 queue, removable chip, Expand while waiting).

- ac-1: an app appears in the rail only under the MA8 conditions, and the "Add your key" hint
  shows when a key is missing.
- ac-2: a click inserts an app card into the current thread with no run, no model call and no
  spend. The card renders the app. From the new-thread view, a new thread starts with the card as
  its first entry.
- ac-3: the next run's model context contains the card's text result, fenced and marked
  untrusted, and opened by the member. The structured result and the template are absent.
- ac-4: during an active run the launch is queued and inserted when the run ends, before the next
  queued message. Removing the chip cancels it. A launch never wakes a sandbox.
- ac-5: a team switch tears down every frame.

**MA-8. Gate: the Kobe Explorer Gate.** See §11.

## 11. The Kobe Explorer Gate

Two runs, both required. Each proves the **in-conversation path first**, then the rail launcher.

**(a) In CI on k3d** (`e2e/run.sh` and a Playwright spec in `e2e/browser`). The fake MCP server
(`e2e/lib/fake-mcp.js`) gains `tools/list`, an opening tool with `_meta.ui` and no required
arguments, two read-only app-visible tools, a write tool, and one `ui://` template (a small test
app). The fake LLM gains a scripted turn that calls the opening tool.

**In the conversation:**

1. Pin.
2. The member asks for the explorer and the model calls the opening tool. The tool card renders
   the app.
3. Expanding a node makes exactly one app call, audited as `mcp.app_call` with the member's id.
4. Selecting an item shows the context chip.
5. "Use in chat" inserts the exact text into the composer and does not send.
6. The member sends. The run's prompt contains the fenced context block, and the answer is
   streamed.
7. A reload rebuilds the app with no upstream call.
8. Expand moves it to the artifact column and back.

**From the rail:**

9. Clicking the app inserts an app card and creates no run. The next run's prompt contains the
   fenced card text.
10. A launch during a run is queued and inserted after it.

**Negative checks:**

- The app's attempts to `fetch` out, `ui/open-link` and call the write tool fail.
- A forged result report from the sandbox is refused.
- A changed template drifts: cards fall back to text and the rail hides the app.
- A member without a key sees text cards and no rail app.
- No key appears in the browser's network log or in the frame.
- An export of the thread contains text only.

**(b) On the gate install against Catalyst** (the usual gate browser check, run from the
coordinator's local notes; no host names here):

1. The Catalyst connector (site-wide key or the member's key) is pinned with
   `ui://catalyst/lakehouse-explorer`.
2. **In the conversation:** "Open the lakehouse explorer". The model calls
   `open_lakehouse_explorer`, and the card shows the tree.
3. Select a table: the schema and preview show, and the chip appears.
4. "Use in chat" inserts `` Use table `c.n.t` ``.
5. Send: the run answers using the table.
6. Reload: the tree is rebuilt.
7. **From the rail:** launch Lakehouse Explorer in another thread. An app card appears with no
   run, and the next question can refer to it.

Evidence: screenshots, audit rows and the thread's entries. This closes KOBE-432 ac-2 together
with Catalyst M24.

## 12. Decisions (approved 2026-10-19 by Chris)

- **Q1. Yes.** D27 is amended for `ui://` templates rendered as apps only (MA1). Every other
  resource and prompt UI stays "later".
- **Q2. Apps render in the conversation.** The rail inserts an app card into the current thread,
  and the artifact column is only "expand" (MA3, MA11).
  - **Q2a. Yes:** the model sees an app card as fenced untrusted text in the next run.
  - **Q2b. Queue:** a launch during an active run is queued (D17) and inserted when the run ends.
  - **Q2c.** At most 3 live frames per thread, with a 360 px default height.
- **Q3.** Model context goes with the next message as a visible, removable chip (MA7).
- **Q4.** A KOBE-303 site key counts as "the member holds a grant" (MA8).
- **Q5.** The browser principal is read-only in v1, even for remembered rules (MA5).
- **Q6.** No network for apps in v1: declared `_meta.ui.csp` domains are ignored (T3).
- **Q7. Yes:** a viewer of a shared thread who can call the connector gets the live app, acting as
  themselves (MA10, T12).

MCP Apps is the next gate (MA-8, the Kobe Explorer Gate).

**Filed 2026-10-19** (spec order): MA-1 KOBE-433 · MA-2 KOBE-434 · MA-3 KOBE-435 · MA-4 KOBE-436 ·
MA-5 KOBE-437 · MA-9 KOBE-438 · MA-7 KOBE-439 · MA-6 KOBE-440 · **MA-8 KOBE-441 (gate)**. All have
priority high, are linked "related" to KOBE-432, and are in the backlog.
