# KOBE-434: MA-2 Template review for site admins (web, server)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

Group MCP Apps (`group-ma-apps`), after KOBE-433. Spec `docs/specs/mcp-apps-host.md` §5.

## What changed

- **Server** `services/server/src/connectors/template-review.ts`, routes in
  `routes/site-connectors.ts` (site permission `site.connectors.manage`):
  - `GET /v1/site/connectors/:id/templates`: per template `{uri, status, change:
changed|added|invalid|null, approved?, live?, invalid?}`; a version is `{sha256,
pinnedHash, bytes, mimeType, meta}`: never the bytes.
  - `GET …/templates/source?uri=`: `{source: {uri, approved?, live?}}` as JSON with
    `Cache-Control: no-store`, `nosniff`, `Content-Security-Policy: default-src 'none'` (MA4:
    never text/html). No `live` for an invalid template.
  - `POST …/templates/approve {templates: [{uri, pinnedHash}]}` (1-64), all or nothing under the
    connector row lock: `not_pending` (not drifted), `invalid` (proposal `{invalid}`, a
    placeholder, or the bytes fail `revalidate` again: MIME, size, NUL, surrogates, recomputed
    hash), `stale` (hash ≠ the live version's: a changed row's proposal, a new row's own). On
    success: status pinned, approved, proposal cleared, `pinned_by` = admin, `pinned_at` now.
  - Audit `mcp.connector.reapproved` gains `templates: [{uri, sha256}]` (tools `[]` here).
  - Registry view gains `templatesDriftedCount`.
- **Web**:
  - `lib/apps/app-frame.ts`: `APP_FRAME_SANDBOX = "allow-scripts"`, the spec T3 CSP, and
    `withAppCsp` (meta CSP as the first element of `<head>`); shared with MA-5.
  - `lib/apps/preview-bridge.ts`: the stub bridge. It answers only the preview frame's own
    `contentWindow`, gives `ui/initialize` a minimal answer, and errors on every other request
    (-32601, `reason: preview`). It never calls `fetch`.
  - `lib/apps/line-diff.ts`: line diff (common head/tail, LCS up to 4M cells, else blocks).
  - `components/admin/site/connector-template-review.tsx`: the "App templates" section of the
    review panel: hashes, size, declared `_meta.ui`, "Show source" (escaped diff, text only),
    "Preview" (sandboxed `srcdoc` iframe + stub bridge), approve one at a time. Invalid ones
    say why and have no Approve button. The registry row shows "N app templates awaiting
    approval" and the Review button.

## Tests

- server unit `template-review.test.ts` (4): review shapes without bytes; approve changed and
  new; stale, not pending, invalid (placeholder and turned-invalid); re-validation of stored
  bytes.
- server DB `connector-template-review.db.test.ts`: review, source headers, ac-1 stale refused,
  invalid refused, members get 403, approval serves the new bytes, ac-3 audit with
  templates, next refresh unchanged.
- web `lib/apps/preview-bridge.test.ts` (ac-2: tools/call, resources/read, open-link all
  refused, `fetch` never called; other windows ignored; CSP injection), `line-diff.test.ts`,
  `connectors-page.test.tsx` "app template review" (escaped diff, sandbox, CSP, approve body).

## Question for MA-5 (spec T3)

Kobe's page CSP (`lib/security/csp.ts`) allows scripts only with a nonce and `'strict-dynamic'`.
A `srcdoc` iframe inherits the parent's CSP, so a template's inline scripts are blocked in
the preview (and would be in MA-5's frame) whatever meta CSP is injected. D25 artifacts avoid
this with a server frame route whose response CSP carries `sandbox`. MA-5's spike must choose:
(a) a frame route with `Content-Security-Policy: sandbox allow-scripts; …` (opaque origin
even when opened top-level, like D25), which needs MA4 ("never text/html on Kobe's origin")
amended; (b) a separate frame origin. The preview here follows the spec as written (srcdoc).
It is safe, and still shows static markup and CSS, but the app's scripts will not run until
MA-5 settles this.
