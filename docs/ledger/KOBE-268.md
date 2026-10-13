# KOBE-268: Open workspace files in the artifact column

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-268-file-viewer` in `../Kobe-wt268`
- **Depends on:** KOBE-198 (rail Files), KOBE-200 (artifact tabs), KOBE-201 (sheets)

## Plan

1. Server (own commit, for the security review): `GET /v1/workspace/frame?path=&team=` in
   `services/server/src/routes/workspace-frame.ts`, registered by the workspace files router.
2. Web: file tabs share the artifact column's open set (`file:<path>` ids), a viewer per type
   (`apps/web/components/files/file-tab.tsx`, pure helpers in `apps/web/lib/files/preview.ts`),
   Files rows open them, a notice when a remembered file is gone.

## Decisions

- **Frame route** = artifact frame rules: `FRAME_HEADERS` unchanged (CSP `sandbox allow-scripts
allow-forms` without `allow-same-origin`, `connect-src 'none'`, `frame-ancestors 'self'`,
  `X-Frame-Options: SAMEORIGIN`), same `Sec-Fetch-Site`/`Origin` check (now a shared helper,
  `isSameSiteFrameRequest` in `artifacts/serve.ts`, used by both routes). Stricter than the artifact
  frame: `team` is **required** (strict query, unknown params 400), only `.html`/`.htm` (checked
  before any read), 1 MiB cap (413 before reading), owner from the session only, `.kobe/` is 404.
  A frame view is audited as `workspace.file_downloaded` (content left the server), like `/file`.
- **No protocol change**: the frame route returns a document, not a JSON contract; its query
  schema lives in the route (reuses `workspacePathSchema`).
- **Reads** use the existing `/v1/workspace/file` (synced copy; works while hibernating). Previews
  therefore record `workspace.file_downloaded` audit rows, as downloads do.
- **Existence and size first**: a file tab looks its entry up in its folder's listing (`stat`, no
  audit row, follows pages up to 10). Gone → tab dropped (no focus move) + dismissible banner
  "<name> is no longer in your workspace". `source: live` (not synced yet) → message, tab kept.
- **Caps**: text read with a streaming cap (1 MiB, then cancelled; notice "Showing the first 1 MB
  of N"); images/SVG over 10 MiB are not fetched; HTML over 1 MiB is not framed.
- **Images and SVG** as `<img>` from `data:` URLs (page CSP `img-src 'self' data:`; no `blob:`), so
  SVG script never runs and there is no inline SVG markup.
- **PDF → Cannot preview + Download**: browser PDF viewers don't run inside a sandboxed,
  opaque-origin frame; nothing loosened for it.
- **Code/text** reuse the artifact view (fenced Markdown block with a `language-*` class); there is
  no syntax highlighter in the app today, so "highlighted" is the same as artifact code blocks.
- **Lazy**: a file tab reads its file when first shown, not while hidden behind other tabs.
- **Tab ids in the DOM** are escaped (`tabDomId`): paths may contain spaces.
- **Narrow screens**: opening a file from the rail drawer closes the drawer; the column opens as
  the sheet / full-screen sheet like an artifact.

## Open questions (for Chris or the coordinator)

- Previews audit as downloads (one row per preview). Fine, or should a quieter "viewed" action be
  added later (needs an audit catalogue change)?
- PR is ~680 lines of code + ~700 of tests; split proposal in the PR description.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `apps/web/components/files/file-viewer.test.tsx` "opening files (ac-1)" (click opens the
  active tab, re-open activates, folders navigate, Download in row and tab); "narrow screens".
- **ac-2** same file, "renderers (ac-2)": Markdown, CSV/TSV, JSON, code, text, PNG, SVG via `<img>`,
  HTML only as the sandboxed frame (no `srcdoc`, page never reads it), PDF/unknown/binary.
  Helpers: `apps/web/lib/files/preview.test.ts`, `apps/web/lib/files/api.test.ts`.
- **ac-3** same file, "memory, deleted files and caps (ac-3)"; storage rules in
  `apps/web/lib/chat/artifact-tabs.test.ts` (file ids kept, artifact list never prunes them).
- **ac-4** `services/server/src/workspace-frame.db.test.ts` (headers, cross-site/foreign origin
  403, missing/stale/other team, teammate's file 404, non-HTML 400 without audit, size cap,
  deleted/lost/internal 404, session required); artifact frame tests still green.
