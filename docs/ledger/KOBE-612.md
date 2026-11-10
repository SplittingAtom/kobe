# KOBE-612: TFM-3: Threads panel with three rails and thread-file lines (web)

- **Status:** ready for review (agent done; not pushed)
- **Branch / worktree:** `kobe-612-three-rails` (from group branch `thread-file-map`) in `../Kobe-wt612`
- **Depends on:** KOBE-611 (server reads, built in parallel; web uses the contract in BRIEF.md)

## Plan

Spec `docs/specs/thread-file-map.md` §5, TFM1–TFM7. Pure line model + batched reads + panel layer.

## Decisions

- **Threshold:** three rails at the shell's `wide` band (window ≥ 1,100 px, `BREAKPOINTS.wide`),
  and only when the panel is given the workspace `FilesApi` (chat-app passes it). `medium` keeps
  two rails; under 820 px the dropdown. No new band.
- **Data:** `apps/web/lib/threads/file-links.ts` holds the three routes' shapes (local zod, TODO
  naming KOBE-611's `@kobe/protocol` schemas) and `createFileLinksApi`, spread into `ChatApi`.
  Ids/paths are comma-joined, each `encodeURIComponent`-ed (a comma in a path is `%2C`).
- **Reads:** thread links for the rows in the thread column (found in the DOM, so search hits,
  Archived and Trash count), 50 per request; file threads for the rail's visible files, 100 per
  request; each key read once per panel mount, a failed batch retried when rows change.
- **Line model** `lib/threads/line-model.ts`: boxes + links → segments (thread right edge → file
  left edge), closed-folder aggregation to the nearest visible ancestor with a count (write wins),
  off-screen targets → "N more above/below" markers per rail edge, sources off-screen draw nothing,
  cap 30 with "+N", hovered row first so pins never crowd it out.
- **Folder hover:** threads whose loaded links fall inside the folder (only visible threads can
  get lines anyway). Threads with no row are named in a status line ("Also used in threads not
  shown: 1 in Archived") rather than as a count on the tree's folder node.
- **Lists:** every thread row with links shows "Files (N)" (N includes `hidden_count`), a
  disclosure listing files as buttons (open in the artifact column, panel closes), deleted ones
  named, unseen ones counted. Shown at every width (the keyboard/screen-reader path); the pin
  (`aria-pressed`, "Keep lines shown for …") only at three rails. The SVG overlay is aria-hidden.
- **"Used in (N threads)":** a `file-used-in` file-menu command (submenu of threads), in the
  Threads panel's rail and in the Files panel (`FileBrowser` `fileLinks` prop, wired in
  workspace-rail; choosing a thread switches to it).
- **Rail:** `FileTreeView` reused with a new `dragRows={false}` (TFM6) and a `trailing` slot for the
  pin; its own expanded-folders key; header is not a heading (thread group tests count h4s).

## Open questions (for Chris or the coordinator)

1. `GET /v1/threads/{id}/files` already exists (KOBE-488: `{files: FileEntry[]}`, used by the
   artifact column's "files the agent wrote"). The new contract reuses the path with another
   shape. `threadFileList` targets the new shape but the panel does not use it; the coordinator
   should pick a path (e.g. `/v1/threads/{id}/file-links`) when reconciling with KOBE-611.
2. Links are cached per panel mount; a run that touches files while the panel is open shows on the
   next opening. Live refresh could follow KOBE-599's workspace events later.

## Evidence

- ac-1: `components/shell/threads-file-map.test.tsx` (three rails, batch reads, hover/focus lines
  with solid/dashed, folder aggregation + count, file hover, pin, Used in, open file);
  `lib/threads/line-model.test.ts` (segments, aggregation, markers, cap, off-screen source).
- ac-2: same file, "the lists" (Files (N) disclosure + aria, narrow two rails without rail/lines/
  pin); `rail-files.test.tsx` Used in on the Files panel.
- ac-3: web unit tests for shell, files, lib (198 files) and chat (77 files) pass; web typecheck,
  lint, build, format:check, public hygiene and site wording pass.
