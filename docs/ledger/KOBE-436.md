# KOBE-436: MA-4 Browser principal and app calls (server, proxy)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## HANDOFF for MA-5 onward (2026-10-19, written for a fresh agent)

**Branch** `group-ma-apps` in worktree `../Kobe-ma`, built on G10 (`group-10-connectors`
c2d7f110, PR #317, not yet on main). MA-1..MA-4 are done and reviewed, nothing is pushed, and
Hadron is untouched. Next in order: MA-5 KOBE-437, MA-9 KOBE-438, MA-7 KOBE-439, MA-6 KOBE-440,
MA-8 KOBE-441 (gate). The spec `docs/specs/mcp-apps-host.md` was amended for MA4/T2/T3 (frame
route). Ledgers: `docs/ledger/KOBE-433.md` .. `KOBE-436.md`.

**Migrations (all site-wide, no RLS, one release; 0152 never shipped):** 0152
`connector_ui_resources` (generated); 0153 `approved` column, printable-ASCII URI check, meta
≤ 16 KiB (generated); 0154 approved backfill (custom); 0155 CHECK `approved OR status =
'drifted'` (generated); 0156 `connectors.pin_version` (1 = pre-433, adopts `ui` once) and
`templates_skipped` (generated). The next free number is 0157. MA-9's `thread_app_results` is a
**team** table: a generated migration, then the RLS policy in a separate custom migration, probe
fixtures, an upgrade test, and FORCE-RLS backfills wrapped in NO FORCE/FORCE.

**Decisions so far (do not re-open):**

- Templates are pinned by Kobe's own SHA-256. The pinned hash is canonical `{uri, mimeType,
sha256, ui}`; `contentHash` is only cross-checked. Only `status = pinned AND approved` rows
  are ever served (`servedTemplate`, `memberApps`).
- Probe: `ui_resources: true`; the proxy derives URIs from live tools. Template trouble never
  fails the tool probe (`ui_resources_skipped`); skips are shown to site admins.
- Tool `ui` = `{resource_uri?, visibility?}` is part of the tool hash. Visibility is normalized
  (the default is omitted; a malformed value pins as `["model"]`). App-only tools never reach Pi
  (catalog, proxy `tools/list`, `decideMcpCall`, and the proxy's own check for allows from older
  servers: `tool.model_visible: true`).
- **Frames (coordinator decision, spec MA4 as amended):** an app frame loads from a **Kobe frame
  route** that sends the template as `text/html` with a **header CSP** (`APP_FRAME_HEADERS` in
  `services/server/src/connectors/app-frame.ts`): `sandbox allow-scripts; default-src 'none';
script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;
media-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none';
base-uri 'none'; form-action 'none'; frame-ancestors 'self'`, plus XFO SAMEORIGIN,
  no-referrer, no-store and nosniff. No `srcdoc` and no meta CSP (srcdoc inherits Kobe's nonce
  CSP and blocks inline scripts). The iframe has `sandbox="allow-scripts"`
  (`apps/web/lib/apps/app-frame.ts`). Require `isSameSiteFrameRequest`, and
  `Sec-Fetch-Dest: iframe` when sent. The admin preview route
  `GET /v1/site/connectors/:id/templates/frame?uri&version&sha256` exists; **MA-5 adds a
  separate member route** (team, `team.chat`, `x-kobe-team` as `?team=` like D25, only
  `memberApp` + `servedTemplate`). Never one route with a flag.
- App-bridge policy reuses the engine's `matchingRules`/`describePinnedTool` in MA5 order, with
  no `PolicyInput` (it needs a run). Accepted by the coordinator. The policy engine ignores
  visibility (L3 accepted).
- Rate limit: burst 30 then 5/s **per user per server pod**. Denial audits are throttled per
  user and reason.

**What later tickets get from MA-1..4:**

- **MA-5 (frame + bridge):** the stub bridge pattern (`apps/web/lib/apps/preview-bridge.ts`:
  answer only `event.source === frame.contentWindow`, reply with `"*"`), `APP_FRAME_SANDBOX`,
  and the header CSP. The real bridge calls `POST /v1/team/apps/:appId/calls {tool, arguments}`
  → `{result}` | `{error:{code,message}}` and `GET /v1/team/apps` (list: `appId, connectorId,
connectorName, iconUrl, tool, title, uri, sha256`). `tools/list` for the app = the connector's
  tools that pass `checkAppTool` (`services/server/src/apps/decide.ts`); add a server endpoint.
  The admin preview's ac-2 browser test (script runs, fetch fails) belongs in MA-5's e2e.
- **MA-9:** `appIdOf(connectorId, uri)` (`apps/app-id.ts`), `memberApp`/`memberApps`/`canCall`
  (`apps/catalog.ts`, MA8 visibility: also the text-fallback reasons), `servedTemplate` (pinned
  and approved, with its `sha256` for the result's `template_sha256` check), `appVisible`
  (`connectors/visibility.ts`). Result capture: the proxy's `tools/call` path is in
  `services/mcp-proxy/src/mcp.ts` `decideAndForward` (it already has `tool_call_id` and the
  thread). The proxy probe and app-calls share `internal-key.ts`. The protocol change goes in its
  own PR first.
- **MA-7:** none server-side yet; the composer is web-only. The `app_context` part is protocol.
- **MA-6:** the rail list is `GET /v1/team/apps`; a launch calls the opening tool through
  `callApp` (`apps/call.ts`) with `{}`. The "Add your key" hint uses `canCall` (no grant or
  site key).

**Gotchas:** drizzle-kit splits generated SQL on a literal `;` (use `chr(59)`). `ls` is aliased
to eza on this Mac. DB tests: `-c vitest.db.config.ts` with `KOBE_TEST_DATABASE_URL`
(CLAUDE.local.md). Build packages first (`turbo run build --filter='./packages/*'`). Under turbo
load, chart backup-secrets, model-gateway budget-gate and sandbox-agent tests can flake; rerun
them alone.

## MA-4 as built

- `routes/team-apps.ts` (`/v1/team/apps`) runs under `requireTeam` (membership re-verified per
  request, `X-Kobe-Team` must match) and `team.chat`. The principal is `{kind: "browser",
userId, teamId}`: no thread or run, so never an approval. Answers are `no-store` and `nosniff`.
- **MA8** (`apps/catalog.ts`): the connector is active and enabled; the template is pinned and
  approved; an opening tool exists (pinned, names the URI, in the exposure; app-callable with no
  arguments preferred); `canCall`: `none`, a site key bound to the URL, or the member's grant of
  the connector's kind (an OAuth grant counts even when expired, because the reveal refreshes or
  refuses).
- `GET …/:appId/template` returns JSON only (`default-src 'none'`); the bytes are read only
  there.
- `POST …/:appId/calls`, in order, each decision audited as `mcp.app_call`: 0. the rate-limit token, taken before the body is read; the body is capped at 96 KiB;
  1. the app is live (404 `app_not_available`, audited against the connector when the id is
     real);
  2. `checkAppTool`: pinned, `readOnlyHint`, app-visible, in the exposure;
  3. arguments: an object of at most 64 KiB, validated against the pinned schema in a
     **worker-thread pool** with a 100 ms deadline (`apps/validate-pool.ts`, using
     `@cfworker/json-schema` 4.1.1, MIT, an interpreter). A timeout terminates the worker →
     `invalid_arguments`;
  4. `appBridgeDecision`: site deny → team deny → ask (`app_no_prompt`) → risk ≠ read
     (`app_read_only`) → allow; user rules are never read;
  5. `McpService.revealForMember`;
  6. mcp-proxy `POST /internal/v1/app-calls` (internal key, strict body, bearer upstream).
- Pinning refuses abusive schemas as `invalid_tool` (`connectors/schema-limits.ts`: 5,000
  nodes, depth 32, 100 patterns of at most 1,024 characters, 200 refs). Regexes are not judged
  at pin time; the worker deadline bounds them.

## Review fixes (review-ma4: HIGH-1, MEDIUM-1, LOW-1..6)

All are in 496e83eb: the worker pool and schema caps; the body cap with the limiter first; the
admin frame needs `Sec-Fetch-Dest: iframe` and takes `sha256` (409 when stale); no template
bytes on calls, and an appId cache; OAuth expiry; per-user limiter and throttled denial audits;
the audit doc comment.

## Tests

- server unit: `apps/decide.test.ts`, `apps/validate-pool.test.ts` (the review's pattern on 51
  characters is refused within the deadline, and the next call works), `pin.test.ts` caps.
- server DB `team-apps.db.test.ts` (9): list, template headers (ac-5), allowed call and audit;
  denials (ac-1); exposure and team disable; rules (ac-4); site key and member key never in a
  response, audit, event or log (ac-2); removed 403 and deactivated 401 (ac-3); ReDoS via the
  endpoint; 413; the rate limit. `connector-template-review.db.test.ts` covers the frame route's
  409 and `Sec-Fetch-Dest`.
- proxy `app-calls.test.ts` (5).
