# KOBE-151: 54e Web: workspace file browser panel

- **Status:** in review
- **Branch / worktree:** `kobe-151-file-browser-panel` in `../Kobe-wt151`
- **Depends on:** KOBE-148 (API, merged); KOBE-184 (paging, legal_hold: PR #150, not merged at start)

## Plan

apps/web only. `lib/files/` (API client, formatting, error wording), `components/files/` (provider +
toggle + panel, `FileBrowser`, `useFolder`), wired in `chat-app.tsx` (third column shared with the
artifact panel via `.sidePanels`) and a "Files" toggle in the thread header.

## Decisions

- Panel = list with breadcrumb (accessible, plain buttons), not an ARIA tree. Escape closes, focus returns to the opener.
- Opening calls `POST /v1/workspace/wake`; the synced listing shows at once with a "last synced" status line,
  and is read again `refreshAfterWakeMs` (4 s) after the wake answers (no wake-state signal exists yet).
- Download: fetch with `X-Kobe-Team`, then a blob link (a plain link cannot send the header).
- Upload: multipart through `apiRequest({form})` (new option), into the current folder; not in uploads/projects.
- Delete: inline `alertdialog` confirmation (focus on Cancel). `uploads/` and `projects/` show a Read-only badge, no delete/upload.
- Errors: `describeFileError` maps `legal_hold` and the current 409 `read_only` (held delete) to a legal-hold message,
  403 `read_only`, `file_too_large`, `quota_exceeded`; others show the server message.
- Paging: `nextCursor` and a "Load more" button are built in; `list(path, cursor)` sends `cursor` only when given.
  TODO(KOBE-184) in `lib/files/api.ts`: the server does not return it until #150 merges. Drag and drop: not done (optional).

## Open questions

- After #150 merges, check the `legal_hold` code and cursor field names match `describeFileError` / `FolderListing`.

## Evidence

- ac-1: `components/files/files-panel.test.tsx` (list, navigate, download, upload, delete + cancel), `lib/files/api.test.ts`.
- ac-2: "shows the last synced listing while waking, then refreshes".
- ac-3: same file (roles, labels, Escape and focus return, alertdialog); `files-app.test.tsx` for the wiring.
