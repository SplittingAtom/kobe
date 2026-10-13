# KOBE-199: A3: Rail drop zone: drop a file into /workspace/uploads

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review
- **Branch / worktree:** `kobe-199-rail-drop-zone` in `../Kobe-wt199`
- **Depends on:** KOBE-198 (rail, merged PR #258)

## Plan

`components/shell/rail-drop-zone.tsx` (drag handlers, overlay, notice) on the rail's `<aside>`;
`lib/files/drop.ts` (split items, upload into uploads/, clash names). Files shows uploads/ after a
drop. A small server change opens one spot of uploads/ to the member (coordinator, 2026-10-12).

## Decisions

- **One rule, in `@kobe/protocol` (review round 1):** `WORKSPACE_DROP_FOLDER`,
  `isThreadFolderName` and `isMemberDropPath` sit next to `WORKSPACE_SERVER_OWNED_PREFIXES`. A
  drop is `uploads/<name>`, a direct child whose name is not a thread folder's. The UUID test runs
  after trim, NFKC and stripping zero-width characters, so lookalikes are refused too. The
  server's and the client's `isReadOnlyPath` both exempt it. The route (POST, DELETE), the
  FileBrowser rows and the uploads/ hint use only that rule. `areaOf` still says `uploads`.
- **Server (coordinator's call):** `POST /v1/workspace/files` with `path` `uploads` writes the
  drop. A thread-folder name gets `400 invalid_path`. `uploads/<thread>/...`, deeper paths and
  `projects/` stay `403 read_only`. Drops go through the same `uploadToWorkspace` call, so quotas,
  size limits and `workspace.file_uploaded` are the same as other uploads; the audit event adds
  `area: "drop"`. An early refusal destroys the request body.
- **Clash, server-side (review round 1):** a drop never fails on a clash. Under the workspace lock
  (the same transaction that made the 409 atomic), the server takes the first free
  `name (n).ext` (n ≤ 100). It trims the stem, never the extension, to fit 255 bytes per segment,
  and returns the final path. The client sends each file once and shows the server's name.
  Uploads outside uploads/ still answer 409.
- **Delete:** `DELETE` on a drop path deletes that one file only. A folder of the same name
  answers 404; no read_only branch is left.
- **Not scanned:** drops take the browser-upload path, which has no ClamAV or MIME sniffing. So
  `uploads/` is no longer all scanned content (noted in `packages/protocol/src/files.ts`).
- **Overlay:** enter/leave are counted on the rail. Dragover re-arms a count that drifted (Safari).
  The count clears on drop, dragend, a drop anywhere (window) and a dragleave with no
  `relatedTarget` outside the viewport, which is leaving the window. Only drags carrying `Files`
  count. The overlay has `pointer-events: none`. When the rail is collapsed, the overlay text is
  vertical.
- **Composer:** the rail's handlers sit on the `<aside>` only. The window listeners only clear
  state and never `preventDefault`. The composer's own drop handlers are untouched.
- **Touch:** `(hover: none), (pointer: coarse)` → no handlers at all. This is decided after mount,
  so the server render and the first client render have no zone.
- **After a drop:** drops that overlap form one batch, queued one after another, with one status
  ("Adding 2 files…", then "Added a, b to uploads."). When the batch ends with something added,
  `rail.reveal("files")` runs once. It expands the rail, focuses Files and wakes and lists, which
  counts as first use. Files opens uploads/ (`FileBrowser showFolder`). If nothing was added, the
  rail only expands so the notice shows. A drop never touches a message or the composer draft.
- **Errors:** they show at the top of Files (`RailDropNotice`, the same `ErrorNotice`), one per
  file, prefixed with the file name. A full workspace stops the remaining files. Folders are
  refused by name (`webkitGetAsEntry`). `quota_exceeded` was added to the client's shown-5xx codes
  (507): before this, its message never reached the member, in the file browser too. The success
  notice clears after 8 s. Errors clear on the next drop, Open files or Refresh.
- `packages/protocol`: the drop rule and a doc comment; no schema change. `packages/db`: the
  audit event's optional `area: "drop"`.

## KOBE-267 (same PR, separate commit; coordinator, 2026-10-12)

- gate1 (headless Chrome) showed the rail's sections grid at 587 px inside the 280 px rail. Its
  implicit `auto` column grew to a long title's max-content, so titles clipped, and the divider
  reached under the conversation. That would also have made the drop overlay too wide.
- Fix: `.sections` gets `grid-template-columns: minmax(0, 1fr)`; `min-width: 0` on the rail,
  `.expanded`, `.sections`, `.section`, `.sectionBody`, `.scroll`, `.divider`, `.threadList` and
  `.threadItem`; the rail gets `overflow-x: clip` (no scroll container). The trigger already
  ellipsizes.
- Tests: `layout-contract.test.tsx` "rail width (KOBE-267)": the CSS contract (happy-dom has no
  layout), plus a 200-character title rendered in the ellipsizing trigger inside the rail. The real
  widths still need the gate1 browser check.

## Open questions (for Chris or the coordinator)

- None blocking. After 100 copies of one name, a drop answers 409 `already_exists`.

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/shell/rail-drop-zone.test.tsx`:
  - "overlay": show/hide with no flicker over children, non-file drags, dragend, drop elsewhere,
    leaving the window, the collapsed rail.
  - "upload": POST `path=uploads`, first use wakes and lists, uploads/ shown, no thread/run
    request, no attachment; the server's clash name; overlapping drops in one batch; notices
    clearing; folders refused.
  - `lib/files/drop.test.ts` (helpers).
  - Server: `services/server/src/workspace-files.db.test.ts` "rail drop into uploads/ (KOBE-199)":
    direct child allowed and audited (`area: "drop"`); nested, thread-dir, UUID and lookalikes
    refused; clash copy names; two concurrent same-name drops both stored; delete scope; another
    team and a teammate refused. Rule and copy names: `protocol workspace-sync.test.ts`, server
    `workspace-files/paths.test.ts`.
- ac-2: `rail-drop-zone.test.tsx` "composer drop": attaches, no workspace upload, no overlay
  (`components/chat/attachments.test.tsx` unchanged and green).
- ac-3: same file "errors and touch": quota (stops the rest, no wake), size (others still added,
  collapsed rail opens), touch → no zone and default not prevented.
- `pnpm verify` (with `KOBE_TEST_DATABASE_URL`): see PR.
