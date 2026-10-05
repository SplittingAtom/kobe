# KOBE-55: Artifacts on assistant-ui with-artifacts (coordinator design)

<!-- Binding for KOBE-127..131. Change it only through the coordinator. -->

- **Status:** in progress, split into KOBE-127 (55a) → KOBE-128 (55b) ∥ KOBE-129 (55c) ∥ KOBE-130 (55d) → KOBE-131 (55e)
- **Spec:** D25 (artifacts), D13 (kobe-tools), D15 (blobs in S3), D18 (retention/export)
- **Out of scope:** share to project (needs KOBE-57), `share_file` (KOBE-54), `remember`/`recall`
  (KOBE-56), React/TSX artifacts, running code. A Python script is a `code` artifact: shown, not run.

## Flow

1. The model calls `create_artifact` / `update_artifact` (Pi tools registered by the new `kobe-tools`
   extension, 55b).
2. `kobe-policy` sends `policy.check` as for any tool; the server allows, denies or asks for approval.
3. Once allowed, `kobe-tools` sends the call to kobe-sandbox-agent on its own fd channel; the agent
   sends `artifact.put` to the server and waits for `artifact.result`.
4. The server (55c) verifies, stores the content in S3, writes the rows, emits `artifact.created` /
   `artifact.updated` on the run's event stream and answers. The tool result is the answer.
5. The web (55d) opens the panel from the event or the tool card and loads content through the API.

## Decisions (binding)

**D-1 Tool inputs (55a, `packages/protocol`).** Strict zod objects:

- `create_artifact`: `kind` ∈ `html | svg | markdown | mermaid | code | csv`; `title` 1–200 chars;
  `content` string, at most **512 KiB UTF-8**; `language` optional, only for `kind: code`,
  `^[a-z0-9][a-z0-9+#.-]{0,31}$` (e.g. `python`).
- `update_artifact`: `artifact_id` uuid; `content` (same cap); `title` optional (1–200).
- The server's policy input validation (`services/server/src/policy/tool-inputs.ts`) uses these
  schemas (55c). The serialized input must fit `policy.check` (1 MiB): `kobe-tools` refuses a call
  whose input would not fit, with a clear tool error, before anything is sent.

**D-2 Wire (55a).** Hello capability `artifacts`. Frames:

- sandbox → server `artifact.put`: `request_id`, `run_id`, `thread_id`, `tool_call_id`, `tool`
  (`create_artifact | update_artifact`), `input` (as allowed). Listed in
  `SANDBOX_FRAME_MAX_BYTES_BY_TYPE` at 1 MiB.
- server → sandbox `artifact.result`: `request_id` and either `ok: true, artifact_id, version` or
  `ok: false, error: { code, message }`. Codes (open enum on the sandbox side): `not_allowed`,
  `not_found`, `invalid_input`, `too_large`, `storage_failed`.
- An agent without the capability never registers the tools (old images keep working). The server
  refuses `artifact.put` from a connection that did not announce the capability.

**D-3 Server checks for `artifact.put` (55c, security-critical).** Accept only if all hold:
the run is active and leased to this connection; the server **allowed this `tool_call_id` for this
tool in this run** and the input's canonical JSON (`canonicalJson`) hashes to the same SHA-256 as
the input it allowed (record the hash at allow time); the call was not already applied (a repeat
returns the first result: idempotent on `(team_id, tool_call_id)`); for `update_artifact`, the
artifact exists in the same team **and the same thread**. Refusals are audited (no content in the
audit row). Object keys are derived server-side; the sandbox never names a key.

**D-4 kobe-tools channel (55a shapes, 55b implementation).** fd **4** (`KOBE_TOOLS_FD`), JSON lines,
same framing and fail-closed rules as the policy channel. Request `{ id, op: "artifact.put",
tool_call_id, tool, input }`; response `{ id, ok: true, artifact_id, version }` or
`{ id, ok: false, error: { code, message } }`. 30 s timeout → tool error. Leave room for later ops
(`share_file`, `remember`) without implementing them.

**D-5 Storage (55c).** Tenancy area `workspace` (`packages/db/src/tenancy/workspace.ts`).

- `artifacts`: `team_id`, `id` uuid, `thread_id`, `created_by` (user), `kind`, `title`, `language`
  null, `current_version`, `created_at`, `updated_at`.
- `artifact_versions`: `team_id`, `artifact_id`, `version`, `blob_ref` (S3, `blob-refs.ts`),
  `size_bytes`, `sha256`, `run_id`, `tool_call_id`, `created_at`; unique `(artifact_id, version)`
  and `(team_id, tool_call_id)`.
- Both: `team_id NOT NULL`, ENABLE + FORCE RLS, probe fixtures. Register with retention purge (blobs
  too), break-glass, legal hold and export (export writes `artifacts/<id>/v<n>.<ext>`). Deleting or
  purging a thread removes its artifacts.

**D-6 API (types in 55a, routes in 55c, one route module).** Same auth, team and thread visibility as
reading the thread.

- `GET /v1/artifacts?thread_id=` → `{ artifacts: ArtifactSummary[] }`
  (`id, thread_id, kind, title, language, current_version, created_at, updated_at`).
- `GET /v1/artifacts/:id` → `ArtifactSummary & { versions: { version, size_bytes, created_at }[] }`.
- `GET /v1/artifacts/:id/versions/:n/content` → the bytes as `text/plain; charset=utf-8`,
  `X-Content-Type-Options: nosniff`, `Content-Disposition: attachment; filename=…` (download and the
  panel's Markdown/code/CSV/Mermaid renderers both use it).
- `GET /v1/artifacts/:id/versions/:n/frame?team=` (kinds `html`, `svg` only) → the document to show
  in the panel's iframe. A frame can't send `X-Kobe-Team`, so the team goes in the query, checked like
  `threadExportUrl`. Headers: `Content-Type: text/html; charset=utf-8`;
  `Content-Security-Policy: sandbox allow-scripts allow-forms; default-src 'none'; script-src
  'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:
  blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'`;
  `X-Frame-Options: SAMEORIGIN` (this route only); `Referrer-Policy: no-referrer`;
  `Cache-Control: private, no-store`; nosniff. SVG is wrapped in a minimal HTML document.

**D-7 Web (55d).** Why not `srcdoc`: a `srcdoc` document inherits the page's CSP (nonce +
`strict-dynamic`), which blocks an artifact's inline scripts, and loosening the page CSP is not an
option. The frame route (D-6) keeps D25's properties: opaque origin (CSP `sandbox` plus the iframe's
`sandbox="allow-scripts allow-forms"`, never `allow-same-origin`), strict CSP, no network, no
separate hostname. The page CSP already allows `frame-src 'self'`. Markdown and code use the existing
components; CSV renders as a table; Mermaid renders in the panel with `securityLevel: "strict"`.

**D-8 Events.** The existing `artifact.created` / `artifact.updated` payloads (`events.ts`) are
unchanged.

## Open questions

## Evidence
