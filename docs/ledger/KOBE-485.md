# KOBE-485: Text artifacts open in the file editor (read-only) with Edit as file

- **Status:** in review (group-45, not pushed)
- **Branch / worktree:** `group-45-artifact-editor` in `../Kobe-wt485`
- **Depends on:** KOBE-463 (file editor), KOBE-462 (workspace save), KOBE-148/199 (upload path)

## Decisions

- **Text kinds** are `markdown`, `code` and `csv` (`ARTIFACT_TEXT_KINDS` in
  `packages/protocol/src/artifacts.ts`); json, tsv and text are `code` artifacts with that
  language. They render through the file editor's renderers as a workspace file with the
  artifact's extension would (`artifactPreview` in `apps/web/lib/chat/artifacts.ts`; json is
  pretty-printed, tsv a table). A code language without an extension of its own keeps its
  language for highlighting. HTML, SVG and Mermaid keep their viewers.
- **Shared UI:** `apps/web/components/files/text-modes.tsx` (`TextModeToolbar`, `TextModeBody`, the
  lazy `CodeEditor`) is used by both the file editor and `components/chat/artifact-text-view.tsx`.
  Raw is CodeMirror read-only (the CSP nonce as before); `CodeEditor` now starts read-only instead
  of switching after mount. The tab keeps Rendered/Raw across versions; the version picker and
  download are unchanged. `CsvTable` moved to `components/chat/csv-table.tsx` (it closed an import
  cycle).
- **Edit as file** is `POST /v1/artifacts/:id/versions/:n/edit-as-file`
  (`services/server/src/routes/artifact-edit-as-file.ts`): the server reads the stored version and
  copies it; the browser sends no bytes. Thread owner only (`findVersionBlob` now returns the
  thread `access`): a shared reader gets 403 `read_only` before the content is read, anyone who
  can't read the thread 404, non-text kinds 400 `not_editable`.
- The copy goes through `uploadToWorkspace` (size limit, workspace quota, team storage quota,
  `putServerFile`) with a new `artifact` option: target `artifacts/<fileStem(title)>.<ext>`; a clash
  takes `-2`, `-3` … (`numberedPath`), chosen under the workspace lock, so racing copies get distinct
  names and nothing is overwritten. Audit: `workspace.file_uploaded` with
  `area: "artifact", artifactId, version` (ids and counts only; `docs/audit-log.md`).
- The extension map moved to protocol (`artifactFileExtension`, shared by downloads, exports, the
  web preview and Edit as file); it gained `tsv`, `toml`, `xml`, `markdown`, `csv`, `text`.
- The web hides Edit as file on read-only threads (`useThreadReadOnly`); on success it opens the
  new file's tab (`openFile`), which is the normal editable file tab (Viewing chip,
  `propose_file_edit` review). Artifacts stay immutable.

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/chat/artifact-editor.test.tsx` (Rendered, read-only Raw, version
  picker keeps Raw, csv/json renderers, html unchanged); existing `artifacts.test.tsx`,
  `artifact-tabs.test.tsx`, `file-editor.test.tsx` green.
- ac-2: `services/server/src/artifact-edit-as-file.db.test.ts` (copy + audit with ids, editable
  save, artifact unchanged, `-2`/`-3`, racing copies, reader 403 / non-reader 404 / other team 404,
  html/svg/mermaid 400, unknown version 404, quota 507 without a file); web: Edit as file opens the
  `-2` tab editable, refusal shown, no button for a shared reader.
- ac-3: unit tests above plus `packages/protocol` and `workspace-files/paths.test.ts`; browser spec
  `e2e/browser/tests/artifact-editor.spec.ts` (not yet run: gate1 needs this build deployed).
- `npx pnpm@12.8.1 verify` green; `@kobe/server test:db` run on lane `wt485`.
