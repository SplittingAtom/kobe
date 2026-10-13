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

- **Server (coordinator's call):** `POST /v1/workspace/files` accepts `path` exactly `uploads`,
  a direct child `uploads/<name>`. This is a positive check in the route (`DROP_FOLDER`,
  `isDropPath` in `workspace-files/paths.ts`); the general prefix test is unchanged. A UUID-shaped
  name (the shape of a thread's attachment folder) is `400 invalid_path`. `uploads/<thread>/...`,
  deeper paths and `projects/` stay `403 read_only`. Writes go through the same
  `uploadToWorkspace` call, so the audit event, quotas and size limits are unchanged.
- **Clash:** the server never overwrites (`409 already_exists`, which also covers a folder
  `uploads/<name>/`). The client retries as `name (1).ext` … `name (9).ext`, re-sending the bytes.
  A rare clash costs one extra upload.
- **Delete:** `DELETE` accepts a direct-child drop path. Inside the transaction it is refused
  (`read_only`) if anything other than that one file is under it, so a non-UUID folder in uploads/
  is never deleted. The web shows Delete only on such files (`isDroppedUpload`).
- **Overlay:** enter/leave are counted on the rail. Dragover re-arms a count that drifted (Safari).
  The count clears on drop, dragend, a drop anywhere (window) and a dragleave with no
  `relatedTarget` outside the viewport, which is leaving the window. Only drags carrying `Files`
  count. The overlay has `pointer-events: none`. When the rail is collapsed, the overlay text is
  vertical.
- **Composer:** the rail's handlers sit on the `<aside>` only. The window listeners only clear
  state and never `preventDefault`. The composer's own drop handlers are untouched.
- **Touch:** `(hover: none), (pointer: coarse)` → no handlers at all. This is decided after mount,
  so the server render and the first client render have no zone.
- **After a drop:** if something was added, `rail.reveal("files")` runs. It expands the rail,
  focuses Files and wakes and lists, which counts as first use. Files opens uploads/ through the
  new `FileBrowser showFolder`. If nothing was added, the rail only expands so the notice shows.
  It never touches a message or the composer draft.
- **Errors:** they show at the top of Files (`RailDropNotice`, the same `ErrorNotice`), one per
  file, prefixed with the file name. A full workspace stops the remaining files. Folders are
  refused by name (`webkitGetAsEntry`). `quota_exceeded` was added to the client's shown-5xx codes
  (507): before this, its message never reached the member, in the file browser too.
- `packages/protocol/src/files.ts`: doc comment only (the exception). No schema change.

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

- None blocking. A dropped file keeps its name only up to 9 copies; after that the drop fails
  with "Too many files with this name".

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/shell/rail-drop-zone.test.tsx`:
  - "overlay": show/hide with no flicker over children, non-file drags, dragend, drop elsewhere,
    leaving the window, the collapsed rail.
  - "upload": POST `path=uploads`, first use wakes and lists, uploads/ shown, no thread/run
    request, no attachment; the clash name; folders refused.
  - `lib/files/drop.test.ts` (helpers).
  - Server: `services/server/src/workspace-files.db.test.ts` "rail drop into uploads/ (KOBE-199)":
    direct child allowed and audited; nested/thread-dir/UUID refused; clash; delete scope;
    another team and a teammate refused.
- ac-2: `rail-drop-zone.test.tsx` "composer drop": attaches, no workspace upload, no overlay
  (`components/chat/attachments.test.tsx` unchanged and green).
- ac-3: same file "errors and touch": quota (stops the rest, no wake), size (others still added,
  collapsed rail opens), touch → no zone and default not prevented.
- `pnpm verify` (with `KOBE_TEST_DATABASE_URL`): see PR.
