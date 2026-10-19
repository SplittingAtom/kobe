# KOBE-433: MA-1 Pin `ui://` templates (server, proxy, db)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

**Renumbered by db:rebase (2026-10-19, on main 05a92778):** the generated migrations are one, 0153_mcp_apps (old 0152, 0153, 0155, 0156, 0157, 0159, 0162); the custom ones keep their SQL: 0154 approved backfill (old 0154), 0155 RLS and legal hold (old 0158), 0156 run-end discard (old 0160), 0157 hold lock first (old 0161). Numbers below are the new ones.

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
- new (`approved = false`): drifted, follows the live bytes, never pinned by a refresh; invalid
  ones are placeholders reported in `invalid` (see review fixes);
- not listed or no longer named by any live tool: removed.

## Deviations from the spec text (for review)

1. Spec §5 has the server send `ui_resources: [uri…]`. The proxy derives the URIs from the
   `tools/list` it just ran, so the request carries `ui_resources: true`. Same URIs, one probe
   instead of two, and the server re-filters to what live tools name.
2. Extra column `meta` (the declared `_meta.ui`, needed by MA-2's review) and `updated_at`.
3. Invalid live templates at refresh drift (above) rather than skipping the whole refresh, so a
   broken upstream template stops the old one from being served (coordinator decision 2).

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

## Review fixes (2026-10-19, review-ma1: 2 HIGH, 3 MEDIUM, 3 LOW)

- **Migrations** 0153 (generated: `approved boolean DEFAULT false`, URI check printable ASCII
  `^ui://[!-~]+$`, `octet_length(meta::text) <= 16384`), 0154 (custom backfill: pinned or with a
  proposal = approved), 0153 (generated CHECK `approved OR status = 'drifted'`: nothing a site
  admin never approved can be pinned). Upgrade test
  `connector-ui-resources-approved-upgrade.db.test.ts`.
- **HIGH-1:** `applyDrift` adopts a pre-433 pin (no `ui`) whose live tool equals it except for
  `ui` (approved fields kept, `ui` and the new hash taken); no event. The template still arrives
  as new and unapproved. DB test from G10's stored state (hash = G10 formula).
- **HIGH-2 (decision 3):** "new" is now `approved = false`, not "no proposal". An invalid new
  template becomes an empty unapproved placeholder with `proposed {invalid}`; reports go in
  `mcp.connector.drift.templates.invalid [{uri, reason}]`, once per reason. An approved or new
  template that turns invalid is reported invalid (not changed or removed). A placeholder that
  gets valid bytes is `added`. Notices gain `invalidTemplates`; the email lists them with the
  reason text.
- **MEDIUM-1:** NUL in html or `_meta.ui` is `ui_resource_invalid` (server); URIs printable ASCII
  everywhere (db pattern, proxy, CHECK). Template drift runs in a savepoint: a failed write logs,
  reports `templatesSkipped: write_failed` and tools still refresh.
- **MEDIUM-2:** proxy keeps `_meta` only of wanted list entries and only `ui` + contentHash,
  16 KiB per template; server caps `_meta.ui` at 8 KiB serialized (half the CHECK, jsonb text
  adds spaces) and reads the probe answer up to 16 MiB (`too_large` above).
- **MEDIUM-3:** proxy: a `resources/list` failure (not -32601), the page cap or a transport
  failure → `ui_resources_skipped: <reason>`, tools unaffected; > 16 named → first 16 read, the
  rest `invalid`; a read over the response cap → that template's `too_large`. Server: skipped →
  templates untouched, outcome `templatesSkipped`. A pin whose template part was skipped pins
  the tools alone (the next refresh finds the templates as new).
- **LOW-1:** server retries a 400 without `ui_resources` (old proxy): templates left alone.
  **LOW-2:** blob decode keeps the BOM; strict base64.
- **LOW-3 contracts** (for the MA-2 and MA-4 briefs):
  - MA-4: `servedTemplate` checks only row and connector state; also require a pinned (not
    drifted) tool with app visibility naming the URI (join on the tool snapshot).
  - MA-2 approval: refuse `proposed {invalid}` and placeholders; require the reviewed
    `pinned_hash` (a new row: its own); re-validate MIME, size and NUL; set `approved = true`.

## Re-review fixes (NEW-1..3)

- **Migration 0153** (generated): `connectors.pin_version` (1 = pinned before 433, the upgrade
  default; 2 since) and `templates_skipped`. Upgrade test `connector-pin-version-upgrade.db.test.ts`.
- **NEW-1:** `applyDrift(..., {adoptLegacyUi})` adopts a `ui` reference only for a version-1
  snapshot; every pin and checked refresh sets version 2. Afterwards a tool that starts naming a
  template (even an approved one) drifts.
- **NEW-2:** the old-proxy fallback reports `uiSkipped: proxy_outdated`. A checked pass stores
  `templates_skipped` (cleared by a pass that checks templates, a URL change); its start (or a
  new reason) is warned and audited `mcp.connector.templates_skipped`, emailed to site admins
  (kind `templates_skipped`), in their notices and on the registry page.
- **NEW-3:** `servedTemplate` also requires `approved`.

## Open questions

- None open. (Invalid new templates: reported, per coordinator decision 3.)
