# KOBE-436: MA-4 Browser principal and app calls (server, proxy)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

Group MCP Apps (`group-ma-apps`), after KOBE-433..435. Spec `docs/specs/mcp-apps-host.md` §6,
MA5, MA8, T6, T7, T10.

## What changed

- **Browser principal**: `routes/team-apps.ts` (`/v1/team/apps`) runs under `requireTeam` (the
  session, the active team, `X-Kobe-Team` must match, membership re-verified per request) and
  `team.chat`. `{kind: "browser", userId, teamId}`: no thread, no run, so no approvals ever.
  All answers are `no-store` and `nosniff`.
- **Apps a member has (MA8)**, `apps/catalog.ts`: the connector is active and enabled for the
  team; a pinned and **approved** template; an opening tool (pinned, names the URI, in the team's
  exposure; one apps can call without arguments is preferred); and the member can call the
  connector (`none`; a site key that is set and bound to the URL; their own live grant of the
  connector's kind). `appId` = SHA-256 of `connectorId:uri` (`apps/app-id.ts`).
- `GET /v1/team/apps` → `{apps: [{appId, connectorId, connectorName, iconUrl, tool, title, uri,
sha256}]}`.
- `GET /v1/team/apps/:appId/template` → `{html, sha256, connectorId, uri}`, **JSON only** (ac-5),
  with `Content-Security-Policy: default-src 'none'`. Frames use MA-5's member frame route (MA4 as
  amended); this JSON read stays for the bridge and tests.
- `POST /v1/team/apps/:appId/calls {tool, arguments}` → `{result}` | `{error: {code, message}}`
  (`apps/call.ts`). In order, failing closed, one `mcp.app_call` audit row per decision (allowed
  rows before forwarding): 0. a per-member rate limit, burst 30 then 5 per second (429, audited at most once a minute);
  1. the app is live for the member (else 404 `app_not_available`, audited against the
     connector when the id names a real app); the tool is of the app's connector;
  2. `apps/decide.ts` `checkAppTool`: pinned (not drifted), `readOnlyHint: true`, app-visible,
     in the team's exposure (`custom`: ticked). Model visibility does not matter here;
  3. arguments: a JSON object (`toolInputSchema`), ≤ 64 KiB, valid against the pinned
     `inputSchema` with `@cfworker/json-schema` 4.1.1 (MIT, draft 2020-12). It is an interpreter
     with no generated code, so an upstream schema is never compiled to JS. One validator is kept
     per tool hash (LRU 256);
  4. `appBridgeDecision` (MA5): site deny → team deny → site/team ask (→ `app_no_prompt`) → risk
     ≠ read (→ `app_read_only`) → allow. User rules are never read, so no allow rule widens it;
  5. `McpService.revealForMember` (grant with the full liveness chain and OAuth refresh, or the
     site key); `none` connectors skip it;
  6. `AppCaller` (`apps/app-caller.ts`) → mcp-proxy `POST /internal/v1/app-calls` (internal
     key), answer read with a 5 MiB cap.
- **mcp-proxy** `app-calls.ts`: internal key only (shared `internal-key.ts` with the probe),
  strict body (`connector_id, url, tool, arguments, api_key? | access_token?`, never both, 96 KiB
  body cap), same upstream client (address policy, caps, timeout). The credential goes only into
  the upstream bearer header and never into the answer.
- **Audit** `mcp.app_call` (team scope): `connectorId, userId, tool, decision, reason,
templateSha256?`; reasons are `APP_CALL_REASONS` in `packages/db` (documented in
  `docs/audit-log.md`). Never arguments, results or credentials.
- **Licences**: `@cfworker/json-schema` (MIT) added; `THIRD_PARTY_LICENSES.md` regenerated
  (NOTICE unchanged).

## Decision to review

- MA5 says "reuses the policy engine with `enforcement_point: app_bridge`, `mode: app`". The
  engine's `PolicyInput` (packages/protocol) requires a run, and its reason codes and
  enforcement points are a protocol enum. Instead, `appBridgeDecision` reuses the engine's own
  rule matching (`matchingRules`) and descriptor (`describePinnedTool`) in MA5's order. That
  needs no protocol PR, and user rules are structurally unreachable. If the coordinator wants
  the enum (`app_bridge`) in the protocol, it can follow in MA-9's protocol PR.

## Tests

- server unit `apps/decide.test.ts` (8): rule 1-2 outcomes, custom exposure, schema validation
  and the 64 KiB cap, MA5 order (site/team deny, ask → `app_no_prompt`, a user or team allow
  rule never widens a write).
- server DB `team-apps.db.test.ts` (7): the list, template JSON headers (ac-5), allowed call with
  audit (no credential for `none`); write, model-only, other-connector, bad arguments and
  drifted are denied and audited; custom exposure and team disable (ac-1); deny, ask and user
  allow rules (ac-4); the site key and the member's own key reach only the caller, never a
  response, audit row, event or log line (ac-2, logger captured); removed member 403,
  deactivated 401 at once (ac-3); the rate limit.
- proxy `app-calls.test.ts` (5): bearer for api key and OAuth, none, failures as data, internal
  key only, strict body, size cap.
