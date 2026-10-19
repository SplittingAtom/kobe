# Kobe — MCP Apps Host (companion to Catalyst spec 0612ef17)

Status: **in review, pending Chris's approval** (Hadron project `kobe`, spec
`7119888c-0058-419c-b6df-37ae09687433`, KOBE-432). Version 0.1,
2026-10-19.

Contract: Catalyst spec `0612ef17-bc24-40e4-a40d-c1bba08ca2ce` ("Catalyst MCP Server — Go Rebuild &
MCP Apps", v1.0 agreed 2026-10-18), §8 "Requirements on the Kobe Host", plus M6, M10–M13 and the
§5 app allowlist. Catalyst's own gates do not depend on Kobe (M24). This spec owns the **Kobe
Explorer Gate**.

Depends on KOBE-431 (probe credentials, done in G10) and KOBE-303 (site-wide keys, done in G10).

## 1. Summary

Kobe becomes a host for MCP Apps (the `io.modelcontextprotocol/ui` extension of MCP 2026-07-28).
A connector's `ui://` templates are pinned like its tools. A member opens an app from the Workspace
Rail. Kobe renders it in a sandboxed, network-less iframe and answers its `tools/call` requests
through the same server-side decision as every other MCP call. The first app is Catalyst's
**Lakehouse Explorer**. Kobe carries no Catalyst-specific code: any connector that follows the
same rules gets the same treatment.

The app runs with exactly the member's own authority over **read-only** tools of **its own
connector**. It cannot reach the network, Kobe's origin, other connectors, the sandbox or the
model directly. Anything it wants to put in front of the model goes through the member: either
as text in the composer that the member sends themselves, or as a context chip they can see and
remove before sending.

## 2. Where this sits among the Kobe decisions (D1–D32)

| Decision                       | How this spec relates to it                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D27** MCP                    | It extends D27. D27 lists "MCP resources/prompts UI" as _later_. This spec brings forward **only `ui://` templates rendered as apps**, and keeps everything else D27 says. Resources stay unavailable to Pi, and data is never read through `resources/read` (Catalyst M13 agrees). Templates are pinned and drift exactly like tools. **Chris must approve this amendment (Q1).** |
| **D29** Policy                 | Unchanged. App calls go through the same decision, at a new enforcement point `app_bridge`, in a mode stricter than `auto`: allowed only if read-only and not denied. Nothing is ever prompted.                                                                                                                                                                                    |
| **D25** Artifacts              | The same isolation pattern: an opaque-origin `srcdoc` iframe with a strict CSP injected into it. It is stricter here: `allow-scripts` only, without `allow-forms`.                                                                                                                                                                                                                 |
| **D9** One active team         | An app belongs to the active team. Switching team destroys every open app frame.                                                                                                                                                                                                                                                                                                   |
| **D10** Break-glass            | Break-glass grants are never used to call connectors, so they never open apps.                                                                                                                                                                                                                                                                                                     |
| **D32** Schedules, skill evals | Not involved. Apps run only in a member's browser session.                                                                                                                                                                                                                                                                                                                         |
| **D31** Audit                  | Every app call is audited. So are pins, drift and approvals of templates.                                                                                                                                                                                                                                                                                                          |
| **D3** Licences                | Only MIT and Apache-2.0 libraries are used (§9).                                                                                                                                                                                                                                                                                                                                   |
| CE2/CE5/CE6/CE13               | The rail gets an "Apps" section. Apps open as a tab in the artifact column. Icons have tooltips.                                                                                                                                                                                                                                                                                   |

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
- **T2. Iframe isolation.** The frame is `<iframe sandbox="allow-scripts" srcdoc=…>`. Without
  `allow-same-origin` its origin is opaque: no Kobe cookies, storage or DOM. Without
  `allow-top-navigation*`, `allow-popups`, `allow-forms`, `allow-modals` or
  `allow-downloads`, it cannot navigate, open windows, submit forms or download. No `allow`
  permission policy is granted (no camera, microphone, geolocation or clipboard-write).
  `referrerpolicy="no-referrer"`.
- **T3. CSP.** A `<meta http-equiv="Content-Security-Policy">` is injected as the first element of
  `<head>`, and Kobe's own page CSP is inherited by the `srcdoc` document. The policy is the
  ext-apps restrictive default: `default-src 'none'; script-src 'unsafe-inline'; style-src
'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none'; connect-src 'none';
frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`.
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
  cover Kobe's chrome: its "fullscreen" display mode means the artifact column at full width,
  never the window. This means the frame can never pass for a Kobe sign-in or approval dialog.
- **T10. Limits and audit.** Tool arguments are capped at 64 KiB and results at 4 MiB (the
  proxy's existing cap). App calls are rate-limited per member: a burst of 30, then 5 per second.
  Each one is audited as `mcp.app_call` (team scope: connector, tool, user, decision, reason,
  template hash; never arguments or results).

**What remains (accepted):**

- An app can show the member misleading content about their own data. This is no worse than the
  connector's own text results.
- An app can put misleading text in the composer. The member reads it before sending.
- The upstream sees each call under the member's credential (or the shared site key, KOBE-303).
  The upstream's own authorization applies, as it does for model-initiated calls.

## 4. Decisions

**MA1. Scope: `ui://` templates rendered as apps; no other resources.** Kobe probes
`resources/list` and reads only the `ui://` resources that pinned tools reference through
`_meta.ui.resourceUri`. Resources stay "method not found" for Pi at the proxy. Prompts, other
resource schemes and `resources/templates/list` are out of scope. _Rejected:_ a general resources
UI (D27 "later"; data would bypass tools, against Catalyst M13).

**MA2. Rendering stack.** The web app hosts frames with the ext-apps **`AppBridge`**
(`@modelcontextprotocol/ext-apps` v2.x, MIT) **if** a spike (ticket MA-5) confirms three things:
it can be driven without a live MCP client in the browser (Kobe proxies `tools/call` through its
own API); every method handler can be overridden or denied; and its peer dependencies
(`@modelcontextprotocol/core`/`client`, Apache-2.0) do not ship transport code that the CSP or
bundle budget rejects. Otherwise Kobe writes a thin host bridge of its own (about 300 lines, zod,
against the ext-apps specification text). Kobe's own code does the iframe creation, the CSP
injection (shared with D25's injector) and the source checks either way. No assistant-ui MCP Apps
renderer was found in the published `@assistant-ui/*` packages as of 2026-10-19
(`@assistant-ui/react` 0.15.29). If one ships, it is weighed in the same spike. _Rejected:_ the
ext-apps "sandbox proxy" double-iframe on a second origin, because it needs a second hostname and
TLS certificate (D25 removed the artifact hostname for this reason), and a single opaque-origin
iframe with a meta CSP gives the same isolation for templates that need no network.

**MA3. Rail placement and rendering location.** The rail gets an **Apps** section (CE5 order:
Threads, Apps, Files; collapsed by default when empty, hidden when the team has no app). In the
collapsed rail (48 px) Apps gets an icon. Clicking an app opens it as a **tab in the artifact
column** (CE6), of a new tab kind `app`. The tab is transient: it is not an artifact, has no
versions and is not saved to S3. It is remembered per thread in the browser like the other tabs,
and it survives switching threads in the same team as an "app" tab. Below 768 px it opens as the
artifact full-screen sheet (CE8). _Rejected:_ rendering inside the 280 px rail, which is too narrow
for a tree and a preview (Catalyst's own breakpoint is 480 px).

**MA4. Server-mediated `resources/read`, never the sandbox.** Templates are fetched only by the
server's pin and refresh probes, through mcp-proxy's internal probe endpoint (server key only,
with the KOBE-431 probe credential), and stored in Postgres. The browser gets them from
`GET /v1/team/apps/{appId}/template`, which returns **JSON** (`{html, sha256, connectorId,
uri}`), never `text/html` on Kobe's origin. That response is `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'`. A template
document therefore never runs as a top-level page on Kobe's origin.

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

**MA8. Who sees an app (§8.7).** An app shows in the rail for a member only when all of these
hold:

- the connector is active and enabled for the active team, with an exposure that includes the
  opening tool;
- the opening tool and its template are pinned and not drifted;
- the member **can call the connector**: it is `none` auth, or it uses a KOBE-303 site key that
  is set and not stale, or the member holds a live grant of the connector's kind (an API key, or
  an OAuth token that is not expired or can be refreshed).

Otherwise the app is absent. A connector whose app is missing only because the member has no key
shows an "Add your key" hint linking to My connector keys.

**MA9. Template size and type.** At most 512 KiB, `mimeType` exactly `text/html;profile=mcp-app`,
and valid UTF-8. Anything else fails to pin, with `ui_resource_invalid`. Catalyst's file is at
most 300 KB by its own CI (M19).

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
  **preview** in the same sandboxed frame with the bridge stubbed: calls fail and nothing reaches
  the upstream. Approval names the reviewed hash, and a stale hash is refused, like tools.
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
- `POST /v1/team/apps/{appId}/calls {tool, arguments}` returns
  `{result} | {error: {code, message}}`. It serves both the rail launch and the app's
  `tools/call`.

**Server checks for each call**, in order (fail closed, one audit row each):

1. The app is visible to this member (MA8). The tool belongs to the app's connector.
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
| `ui/request-display-mode`                                                                                            | `inline` or `fullscreen` (the artifact column at full width); anything else is refused.                                                                                                                                                                                                                                |
| `ui/notifications/size-changed`                                                                                      | Honoured within the column; height capped at 4,000 px.                                                                                                                                                                                                                                                                 |
| `notifications/message` (logging)                                                                                    | Dropped. A debug counter only.                                                                                                                                                                                                                                                                                         |
| `ui/open-link`, `ui/download-file`, `resources/read`, `resources/list`, `sampling/*`, `elicitation/*`, anything else | **Denied** (JSON-RPC error `-32601`, with a Kobe-specific `data.reason: "not_allowed_in_kobe"`).                                                                                                                                                                                                                       |

| Host → app                                                       | When                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `ui/notifications/tool-input` and `ui/notifications/tool-result` | After a rail launch: the opening tool's arguments (`{}`) and result.     |
| `ui/notifications/host-context-changed`                          | On a theme change or resize.                                             |
| `ui/resource-teardown`                                           | On tab close, team switch, sign-out or drift. The frame is then removed. |

## 8. `ui/message` and `ui/update-model-context` (§8.6)

- **`ui/message`** with role `user` and text content inserts the text **at the cursor of the
  composer draft** of the thread on screen, or of the new-thread composer if no thread is open.
  It **never sends**. Text is capped at 4 KiB, other content types are ignored, and the composer
  flashes and receives focus. Catalyst's "Use in chat" therefore inserts `` Use table `c.n.t` ``
  for the member to send or edit.
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
- Neither path runs a model turn by itself. That is the point of the Kobe Explorer Gate: rail
  click, then a member action, then a run.

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

Group order: MA-1 → MA-2 → MA-3 → MA-4 → MA-5 → MA-6 → MA-7 → MA-8 (gate). One migration per
schema ticket, generated and custom SQL kept separate, with upgrade tests. The cross-team probe
suite must stay green.

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
bridge (MA2) and records the result in the ticket ledger. Then: `AppFrame` (srcdoc,
`sandbox="allow-scripts"`, the injected CSP shared with D25, a host header, no `allow`
permissions), the bridge (source and origin check, zod per method, the §7 table, per-frame limits)
and the licence inventory.

- ac-1: from inside the frame, `fetch`, `XMLHttpRequest`, `WebSocket`, `img` to a remote host,
  form submission, `window.open`, top navigation and reading `document.cookie` all fail
  (browser test).
- ac-2: messages from any other window are ignored.
- ac-3: `ui/open-link`, `ui/download-file` and `resources/read` are denied.
- ac-4: `pnpm license:check` is green.

**MA-6. Rail "Apps" and the artifact-column app tab (web).** The rail section (MA3, MA8) with icons
and tooltips (CE13), the launch (calls the opening tool through `POST …/calls`, then renders the
result with the template), the app tab kind, the fullscreen mode and the narrow-screen sheet.

- ac-1: an app appears only under the MA8 conditions, and the "Add your key" hint shows when a
  key is missing.
- ac-2: clicking it renders the app with the opening tool's result and runs no model turn
  (no run is created).
- ac-3: a team switch tears down the frames.

**MA-7. `ui/message` and model context (web, server, protocol).** Composer insertion, the context
chip, the `app_context` message part (a protocol type in `packages/protocol`, agreed in its own
PR, as `docs/parallel-work.md` requires), its storage in the thread entry, and its rendering as a
fenced untrusted block for Pi.

- ac-1: `ui/message` never sends.
- ac-2: the chip is visible and removable, and only what it shows is sent.
- ac-3: the block reaches Pi fenced and marked untrusted, and is in thread history and exports.
- ac-4: sizes are capped.

**MA-8. Gate: the Kobe Explorer Gate.** See §11.

## 11. The Kobe Explorer Gate

Two runs, both required.

**(a) In CI on k3d** (`e2e/run.sh` and a Playwright spec in `e2e/browser`). The fake MCP server
(`e2e/lib/fake-mcp.js`) gains `tools/list`, an opening tool with `_meta.ui` and no required
arguments, two read-only app-visible tools, a write tool, and one `ui://` template (a small test
app). Then:

1. Pin.
2. A member opens the app from the rail. The tree renders and no run is created.
3. Expanding a node makes exactly one app call, audited as `mcp.app_call` with the member's id.
4. Selecting an item shows the context chip.
5. "Use in chat" inserts the exact text into the composer and does not send.
6. The member sends. The run's prompt contains the fenced context block, and the answer is
   streamed.

Negative checks:

- The app's attempts to `fetch` out, `ui/open-link` and call the write tool fail.
- A changed template drifts and the app disappears.
- A member without a key sees no app.
- No key appears in the browser's network log or in the frame.

**(b) On the gate install against Catalyst** (the usual gate browser check, run from the
coordinator's local notes; no host names here):

1. The Catalyst connector (site-wide key or the member's key) is pinned with
   `ui://catalyst/lakehouse-explorer`.
2. In the rail, open Lakehouse Explorer. The tree loads.
3. Select a table: the schema and preview show, and the chip appears.
4. "Use in chat" inserts `` Use table `c.n.t` ``.
5. Send: the run answers using the table.

Evidence: screenshots, audit rows and the run's thread entry. This closes KOBE-432 ac-2 together
with Catalyst M24.

## 12. Questions for Chris

- **Q1.** Do you approve amending D27 ("MCP resources/prompts UI later") to allow `ui://`
  templates rendered as apps now, and only those (MA1)?
- **Q2.** Should apps render as a tab in the artifact column (MA3, proposed), or somewhere else?
- **Q3.** Should model context go with the next message as a visible, removable chip (MA7,
  proposed), or be added silently (the Catalyst spec allows either)?
- **Q4.** Should "the member holds a grant" (§8.7) also count a KOBE-303 site key (MA8, proposed:
  yes)?
- **Q5.** Should the browser principal stay read-only even for tools a member has "approved and
  remembered" (MA5, proposed: yes, in v1)?
- **Q6.** Declared `_meta.ui.csp` domains are ignored in v1, so no app gets network access. Is
  that acceptable until a later spec (proposed: yes)?
