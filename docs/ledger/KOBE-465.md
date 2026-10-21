# KOBE-465: Notebooks: notebook and Python IDE in the artifact column (web)

- **Status:** in review (group branch `group-21-notebook-web`, not pushed)
- **Branch / worktree:** `group-21-notebook-web` in `../Kobe-wt465`
- **Depends on:** KOBE-464 (kernel, routes, events; merged #343), KOBE-463 (file editor, review).
- **Spec:** [docs/specs/notebooks.md](../specs/notebooks.md) §3 (output frame) and §4 (the web).

## Plan

1. Server: `GET /v1/workspace/output-frame` (fixed shell for HTML outputs) + db test.
2. `lib/notebooks/`: nbformat read/edit/write (`ipynb.ts`), output rendering decisions
   (`outputs.ts`), kernel API (`api.ts`), per-tab execution store (`executions.ts`).
3. `components/notebooks/`: notebook view, cell, outputs, output frame, kernel bar, `.py` Run
   pane, `use-kernel`; wired from the file tab (lazy) and the artifact panel (thread, stores).
4. Thread controller hands its run events to the store (agent `run_python` live).
5. Unit tests; gate1 browser spec `e2e/browser/tests/notebook.spec.ts`.

## Decisions

- **HTML outputs never touch the page.** A new server route serves a fixed shell document with
  the artifact frame's `FRAME_HEADERS` (CSP `sandbox allow-scripts allow-forms`, no
  `allow-same-origin`, `connect-src 'none'`) plus the app frame's WebRTC guard; the iframe
  (`ARTIFACT_FRAME_SANDBOX`, no `srcdoc`) loads it and the page posts the HTML once on its first
  load (`postMessage(…, "*")`: an opaque origin cannot be named). The shell accepts only a
  message from `window.parent`, once, then `document.write`s it (CSP and sandbox stay). Chosen
  over a frame route per output because live outputs, `.py` outputs and agent code outputs are
  in no file; the route is static, needs the active team, and refuses non-frame and cross-site
  loads (`mayLoadAppFrame`).
- **DataFrames as real tables without kernel HTML in the page:** NB4 allows no
  `vnd.dataresource+json`, and pandas sends `text/html` + `text/plain`. The view parses the HTML
  with `DOMParser` (inert document: no scripts run, nothing loads) only when it holds
  `<table class="dataframe">`, and renders `textContent` of th/td cells as React text (capped
  500 rows / 100 columns). A Table Schema in `application/json` renders the same way. Otherwise
  HTML goes to the frame. Confirmed by the coordinator (2026-10-21), recorded in NB4.
- **Other kinds:** stream/traceback text with ANSI stripped (regex, never mapped to markup) and
  carriage-return overwrites applied; PNG/JPEG `data:` URLs; SVG re-encoded to a base64 `data:`
  URL for `<img>`; Markdown via the chat's `Markdown`; JSON pretty text; saved outputs pass the
  protocol's `notebookOutputSchema` (non-NB4 MIME types dropped) or show "cannot be shown".
- **Edits are file editor drafts** (serialized notebook), so the unsaved guard, tab-close confirm
  and conflict notice are reused. A run saves edits and missing cell ids first (server reads the
  saved copy, NB1/NB6). After `notebook.finished.saved` the view reads that version and merges:
  member's sources, server's outputs and counts (`withSavedResults`).
- **One execution store per tab** (`session.notebookRuns`): member runs follow their own run
  stream (opened on the 202; a synthetic `notebook.started` shows `[*]` at once); agent runs
  come from the thread controller's new `onRunEvents` hook. Run ends without `notebook.finished`
  end executions as `failed`/`interrupted`.
- Run all: sequential, stops at the first cell not `ok`; a `thread_busy` right after a cell is
  retried for up to 3 s (the previous run ends just after its finished event).
- `.ipynb` reads go to `NOTEBOOK_FILE_MAX_BYTES` (8 MiB) instead of the 1 MB text cap.
- Proposals on an `.ipynb` show the KOBE-463 inline diff of the JSON in place of the notebook.
- `CodeEditor` gained `compact` and `onRun` (Shift+Enter, `Prec.highest`); the nonce is set for
  every view as before (unit test covers a compact cell).

## Bundle

Notebook view, cells, outputs, kernel bar and `.py` pane are lazy chunks (~10.6 KB + ~19.7 KB
minified); the chat chunk gains only the API module and the execution store (~3 KB). No new
dependencies (`@codemirror/lang-python` was present).

## Open questions

- None.

## Security review follow-ups (Opus, 2026-10-21; no blocking issues)

- Shared readers (`useThreadReadOnly`, wiring `readOnly`) get no Run, Run all, Interrupt,
  Restart or `.py` Run; a note says only the owner runs code. Outputs still show.
- The output frame is keyed by a hash of its HTML (FNV-1a + length): changed HTML remounts a
  fresh shell, which is posted to once.
- Images over 10 MiB decoded (PNG/JPEG from base64 length, SVG UTF-8 bytes) show "Image too
  large to show (size)" instead.

## Evidence (acceptance criteria → test or command output)

- **review** `notebook-view.test.tsx` (shared reader, frame remount), `python-run.test.tsx`
  (shared reader), `outputs.test.ts` (image cap).
- **ac-1** `components/notebooks/notebook-view.test.tsx` (editing: edit/add/move/delete,
  Markdown edit, save at version, conflict notice; running: ids saved first, live outputs,
  `[*]`→`[n]`, read-back after save, edits kept during a run, Run all order and stop, Interrupt,
  Restart with confirm, refused run, no thread), `notebook-tab.test.tsx` (file tab opens it),
  `code-editor.test.tsx` (compact cell nonce, Shift+Enter), `lib/notebooks/ipynb.test.ts`.
- **ac-2** `lib/notebooks/outputs.test.ts`; `notebook-view.test.tsx` "every output kind, HTML
  only in the sandboxed frame" (no kernel HTML in the DOM, no `srcdoc`) and "posts the HTML to
  the frame once"; `services/server/src/notebook-output-frame.db.test.ts` (4: headers, guard,
  origin/dest/team checks, signed out).
- **ac-3** `components/notebooks/python-run.test.tsx`, `notebook-tab.test.tsx`.
- **ac-4** `notebook-view.test.tsx` "the agent" (live cell run, code runs below, proposal diff),
  `lib/notebooks/executions.test.ts`, `thread-controller.test.ts` (onRunEvents);
  `e2e/browser/tests/notebook.spec.ts` (gate1, KOBE_TEAM=team1; not run here).
- **verify:** `npx pnpm@12.8.1 verify` passes (one web flake, connectors-page, passed on rerun);
  db test run directly against the dev Postgres.

## Gate1 follow-up (2026-10-21, branch `group-22-notebook-csp`)

- gate1 spec reported 12 `style-src-elem inline` violations. Cause: the DataFrame table reader
  passed pandas' `<style scoped>` to `DOMParser`; Chrome checks inline `<style>` in a DOMParser
  document against the page CSP and reports to the page (happy-dom does not, so a unit test
  can only assert the parser input). Fix: whole `<style>` elements are stripped before parsing,
  and HTML with any `<style>` left is not parsed (frame). CSP unchanged.
- `e2e/browser/tests/support/csp.ts` now reports sample, source location and the latest
  un-nonced `<style>` added to the document.
- Evidence: `lib/notebooks/outputs.test.ts` "never hands the parser a <style> element".
