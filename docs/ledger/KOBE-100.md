# KOBE-100: connector registry (tables and install admin CRUD)

Status: PR open (branch `kobe-100-connector-registry`). Migration `0065_connector_registry`
(extends the KOBE-58 `connectors` table; no new table).

## Decisions

- **Schema (extends 0037/0038):** `connectors` gains `icon_url` (nullable, CHECK https, no spaces,
  at most 2048), `created_by` (FK users, null for older rows) and `deleted_at` (soft delete). Grants
  were already ALL for the app role; `connectors` stays install-wide (no RLS), the wall is the route.
- **API** `/v1/install/connectors`, permission `install.connectors.manage` (install admin and
  owner; team admins and members get 403): `GET /`, `GET /:id`, `POST /`, `PATCH /:id`
  (partial: name, url, iconUrl, authKind, status), `DELETE /:id`. Strict bodies; unknown keys are 400,
  so `toolsSnapshot` and `toolsHash` cannot be set here (KOBE-101 owns them).
- **URL policy** (`connectors/url-policy.ts`): https only unless `KOBE_MCP_ALLOW_INSECURE_HTTP=true`
  (the proxy's dev flag); no userinfo, query or fragment; port in `KOBE_MCP_ALLOWED_PORTS` (default 443);
  literal IPs, and every address a name resolves to, must pass `@kobe/address-policy` with the
  operator's `KOBE_MCP_ALLOWED_INTERNAL_CIDRS` / `KOBE_MCP_DENIED_CIDRS` (private, loopback,
  link-local, metadata, CGNAT and the rest of the shared list are refused). 422 with a code
  (`https_required`, `address_not_allowed`, ...); messages never echo the URL. The server reads the
  proxy's env names; the chart now passes the same four values to the server (`_mcp.tpl`), so there
  is one source. This is a registration-time check; the proxy re-checks at connect time (rebinding).
- **Edit:** changing the URL clears `tools_snapshot` / `tools_hash` (a different server's tools were
  never reviewed; fail closed until KOBE-101 re-pins). Name uniqueness is checked also across `-`/`_`
  (existing unique indexes back it up).
- **Delete:** always a soft delete (`status=disabled`, `deleted_at`), never a hard delete: a hard
  delete cascades into `team_connectors`, and a concurrent team enablement (KOBE-104) would lose its
  row (Opus review of #98). Hidden from list/get/patch; `team_connectors` rows kept; the message
  names how many teams had it (counted per team with `withTeam`, informational) and that calls are
  refused (existing `status != active` check in `mcp/catalog.ts`). The name stays reserved (409
  `name_removed`). Race test in `connectors.db.test.ts`.
- **Audit** (install scope, `docs/audit-log.md`): `mcp.connector.registered` (id, name, authKind),
  `.updated` (id, name, changed field names), `.removed` (id, name, soft, teams). Never URL or icon
  (a URL may carry a key in its query), never credentials.
- **Icon:** https URL only. No upload pattern for small images exists in the repo yet, so none is
  added here (see open questions).
- **UI:** nav entry `connectors` is READY; `components/admin/install/connectors-page.tsx` (form for
  register/edit, table with Edit, Disable/Enable, Remove with confirm and the server's message).
  Placeholder tests that used this entry now use `web-search` (still coming in KOBE-63).

## Evidence

- `services/server/src/connectors.db.test.ts`: access (403 team admin/member, 401 anonymous), CRUD,
  validation, duplicates across `-`/`_`, URL policy (private/metadata/credentials/rebinding on create
  and edit), URL change resets pins, soft vs hard delete, audit without URLs, no audit on refusal.
- `services/server/src/connectors/{url-policy,config}.test.ts`, `apps/web/components/admin/connectors-page.test.tsx`,
  `charts/kobe/tests/mcp-proxy.test.ts` (server gets the policy env).

## Open questions

- Small-image upload for icons (spec says "validated URL or uploaded image"): needs an asset store;
  propose a follow-up once an upload pattern exists.
- Query strings and fragments are refused (coordinator, #98); KOBE-108 places API keys as query parameters from per-user grants.
