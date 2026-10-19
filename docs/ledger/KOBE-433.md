# KOBE-433: MA-1 Pin `ui://` templates (server, proxy, db)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

Group MCP Apps (`group-ma-apps`, on top of G10 `group-10-connectors` c2d7f110). Spec
`docs/specs/mcp-apps-host.md` §5, MA1, MA9. Stopped after MA-1 for an Opus review.

## What changed

- **Schema** (`0152_connector_ui_resources`, generated, alone in its commit): site-wide
  `connector_ui_resources (connector_id FK cascade, uri, mime_type, html, sha256, meta jsonb,
pinned_hash, status pinned|drifted, proposed jsonb, pinned_by FK users set null, pinned_at,
updated_at)`, PK `(connector_id, uri)`. Checks: `^ui://`, ≤ 2048; MIME exactly
  `text/html;profile=mcp-app` (written `'text/html' || chr(59) || ...` because drizzle-kit splits
  generated SQL on a literal `;`); `octet_length(html) ≤ 512 KiB`; hex hashes; `proposed` only on a
  drifted row. `ALL_PRIVILEGES` in `tenancy/connectors.ts`. No team data, so no RLS and no
  custom migration. Upgrade test: `packages/db/src/connector-ui-resources-upgrade.db.test.ts`.
- **Pinned tools** gain optional `ui: {resource_uri}` (`_meta.ui.resourceUri`, `ui://` only). It
  is part of the tool hash **only when present**, so tools without a template keep their hash
  (no drift on upgrade). `approveTools` now drops optional fields (`title`, `output_schema`, `ui`)
  that the approved live definition no longer has (it used to keep the old ones).
- **mcp-proxy** `POST /internal/v1/probe` accepts `ui_resources: true`: after `tools/list` (same
  session) it collects the distinct `ui://` `resourceUri`s of the live tools (max 16, else
  `too_large`), runs `resources/list` (paginated; `-32601` = no resources = none), and reads only
  named **and** listed URIs. Per template: `{uri, mimeType, text, meta}` (meta = list entry,
  result and content `_meta` merged) or `{uri, error: too_large|invalid}` (> 512 KiB, not text,
  bad UTF-8 / lone surrogate, refused read). Code: `services/mcp-proxy/src/ui-resources.ts`.
- **Server** (`services/server/src/connectors/`):
  - `templates.ts` (pure): `liveTemplates` validates (MIME, UTF-8, 512 KiB), hashes the bytes
    itself, cross-checks `_meta["io.splittingatom/contentHash"]` (hex, case-insensitive,
    optional `sha256:` prefix) → `ui_resource_hash_mismatch`; else `ui_resource_invalid`.
    `pinned_hash` = SHA-256 of canonical `{uri, mimeType, sha256, ui}` where `ui` keeps only
    `csp, permissions, domain, prefersBorder`. `pinTemplates` is all-or-nothing;
    `applyTemplateDrift` mirrors `applyDrift`.
  - `template-store.ts`: load/write/replace/drop, `servedTemplate` (pinned only, connector
    active and not deleted: the one read MA-4 should use), `driftedTemplateUris`.
  - `probe.ts` always sends `ui_resources: true`; `pinning.ts` pins templates in the same
    transaction as the tools (`pinned_by` = acting admin), audit `mcp.connector.pinned` gains
    `templates: [{uri, sha256}]` (only when any); the pin response gains `templates: n` (only
    when > 0, so the old shape stays). New messages for the two failure codes.
  - `refresh.ts`: the same `chooseProbeCredential` probe; template drift under the connector row
    lock in the same transaction; a skip (auth_required or any failure) touches no template.
    `mcp.connector.drift` gains `templates: {changed, added, removed}` (URIs); the outcome gains
    `templates` counts. A prober that reports no `uiResources` leaves templates alone.
  - URL change (`registry.ts`) drops the templates with the pins.
  - Notices (`drift-recipients.ts`) gain `templates: [uri]`; the drift email lists templates
    (subject "app templates changed" when only templates changed); `stillDrifted` counts them.

## Drift rules for templates

- unchanged pinned hash: pinned (a drifted one whose live bytes equal the approved again:
  pinned, proposal cleared);
- changed: drifted, approved bytes kept, live in `proposed {mime_type, html, sha256, meta,
pinned_hash}`; the same proposal again is no new event;
- approved template whose live one is invalid: drifted with `proposed {invalid: code}` (not
  approvable; recovers by itself when the live one is valid and equal again);
- new: drifted with live bytes and no `proposed`, follows the live bytes; never added when
  invalid; a new one that turns invalid is removed;
- not listed or no longer named by any live tool: removed.

## Deviations from the spec text (for review)

1. Spec §5 has the server send `ui_resources: [uri…]`. The proxy derives the URIs from the
   `tools/list` it just ran, so the request carries `ui_resources: true`. Same URIs, one probe
   instead of two, and the server re-filters to what live tools name.
2. Extra column `meta` (the declared `_meta.ui`, needed by MA-2's review) and `updated_at`.
3. Invalid live templates at refresh drift (above) rather than skipping the whole refresh, so a
   broken upstream template stops the old one from being served.

## Tests

- db: `ui-resources.test.ts` (unit); upgrade test above; probe suite, privileges, migrate green.
- proxy: `ui-resources.test.ts` (7), `probe.test.ts` (+1), `mcp.test.ts` ac-3:
  `resources/list|read|templates/list|subscribe` → -32601 for Pi, nothing sent upstream.
- server: `templates.test.ts` (13), `pin.test.ts` (+3), `drift.test.ts` (+2), `probe.test.ts`
  (+1), `connector-templates.db.test.ts` (6: ac-1 pin + 4 failure codes + URL change; ac-2 drift,
  add, remove, event, notice, email, not served, invalid then recover; ac-4 admin key + skip
  leaves templates). Two existing refresh-outcome assertions gained `templates`.
- Full unit suite green (chart backup-secrets and model-gateway budget-gate flaked once under
  turbo load, pass alone); typecheck, lint, format, `license:check`, `db:check` green.

## Open questions

- A new template that is invalid on its first refresh is silently not added (no event). Should
  the drift event carry an `invalid` list for site admins?
- MA-2 approval must refuse a row whose `proposed` is `{invalid}`.
