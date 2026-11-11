# KOBE-613: TFM-4: browser spec and user docs for the thread-file map

- **Status:** ready for review (agent done; not pushed)
- **Branch / worktree:** `kobe-613-thread-file-spec` in `../Kobe-wt613` (from main `7587063e`)
- **Depends on:** KOBE-610, KOBE-611, KOBE-612 (PR #522)

## Plan

Spec `docs/specs/thread-file-map.md` §5–§6, TFM1, TFM4, TFM5, TFM7. One Playwright spec against a
deployment, a member guide for the Threads panel, spec status shipped.

## Decisions

- **Test data from a real run.** The agent calls `read` on an uploaded `kobe-613-*/source.txt` and
  `write` on `kobe-613-*/written.txt` (two `toolTurn`s, so the fake model drives them too). Links
  are recorded at the server's policy decision; the written file's link stays "deleted" until the
  sandbox pushes it, so the spec polls `GET /v1/threads/{id}/file-links` until both are live, then
  reloads and opens the panel (it reads a row's links and the rail's tree once per mount).
- **Selectors:** existing hooks only, no web changes: `[data-kobe-threads-body]` (`three-rails`),
  `[data-kobe-file-rail]`, rail rows `[role=treeitem][data-path]`, the overlay's
  `[data-kobe-file-lines] [data-kobe-line=<anchor>][data-access]` (anchor = file path for a thread
  source, thread id for a file source), the read line's `stroke-dasharray`, the pin
  "Keep lines shown for …" (`aria-pressed`), "Files (N)".
- **The rail folder is opened** before hovering, so lines end on the files rather than on the
  closed folder (one aggregated line).
- **"Files (N)"** is compared with the API's `files.length + hidden_count`, not a literal 2, so a
  real model's extra file tool call does not fail the count; the two named lines are still asserted.
- **Shared (TFM7):** a project via `POST /v1/projects` with `notes.md`, a conversation at
  `/?project=<id>`; the agent reads `/workspace/projects/<slug>/notes.md` and writes
  `kobe-613-*/own.txt` in the owner's workspace; shared with `visibility: "team"`. member2: API
  names the project file, not `own.txt`, `hidden_count ≥ 1`; the row's list shows `notes.md`
  (title = tree path) and "N files you can't see"; no line to `own.txt`.
- **User guide:** no member doc for the Threads panel existed; added `docs/threads-panel.md`
  (folders in brief, file lines, pin, narrow widths, shared threads).

## Open questions (for Chris or the coordinator)

- Not run against gate1 here (coordinator runs it after the deploy):
  `npx playwright test thread-file-map` with `KOBE_USER2`/`KOBE_PW2` for the shared test.
- Whether member2's workspace rail lists the owner's project (`projects/<slug>`) is not asserted.

## Evidence (acceptance criteria → test or command output)

- `e2e/browser`: `npx tsc -p .` clean; prettier 3.9.9 `--check` clean on changed files. The
  browser suite is not a pnpm workspace package, so `pnpm lint` does not cover it.
- gate1 run: pending (coordinator).
