# Kobe — Notebooks (KOBE-464 server, sandbox and protocol; KOBE-465 web)

Status: **decisions by Chris, 2026-10-21** (NB1–NB5 and NB17 binding; NB6–NB16 and NB18 settled
in KOBE-464 within them). Contract: `packages/protocol/src/notebooks.ts` and
`packages/protocol/src/sandbox-wire/notebook-frames.ts`. Ledger: `docs/ledger/KOBE-464.md`. Builds
on the file editor (`docs/specs/file-editor.md`, FE1–FE12).

## 1. Summary

Jupyter notebooks (`.ipynb`) and Python files (`.py`) in the member's workspace can be run. Each
thread has a live Python kernel in the member's sandbox; state carries from one cell to the next.
The member runs a cell (or a whole `.py` file) from the web; the agent runs code with the built-in
tool `run_python` under the team's tool policy, like the sandbox shell. Outputs (text, errors,
DataFrame tables, PNG/SVG images, HTML) stream through the run's event stream, bounded, and are
saved into the `.ipynb` through the file editor's save path. Code runs only in the sandbox.

Parts: the kernel in `kobe-sandbox-agent` (`services/sandbox-agent/src/notebook/`, the bridge
`images/sandbox/kernel/kobe-kernel-bridge.py`), three sandbox commands and two frame pairs on the
existing wire, the server's run/interrupt/restart routes and output intake
(`services/server/src/notebooks/`), and the tool.

## 2. Decisions

**NB1. Jupyter `.ipynb`.** (Chris) nbformat 4 JSON, read and written by the server (the
synced copy is the record). Cells keep their ids (nbformat 4.5 `id`); a cell without one cannot be
run by id (the web adds ids when it saves; KOBE-465).

**NB2. One live kernel per thread.** (Chris) State carries between cells of the same thread. The
kernel starts on the thread's first execution and stops after 30 idle minutes
(`KOBE_KERNEL_IDLE_MS`), on restart, and when the sandbox stops or hibernates (it is never
persisted: a woken sandbox starts a fresh kernel). The member's and the agent's executions share
it; one runs at a time (NB6).

**NB3. Agent runs follow the team's tool policy.** (Chris) `run_python` is a built-in like `bash`:
risk `destructive`, scope `sandbox`, primary argument `/code`. Site and team deny/ask rules,
`ask-all` and the agent's tool list apply; no new approval path and no bypass. The server decides
every call (`policy.check`), and the `notebook.run` frame is served only for a call the connection
allowed with the same canonical input, taken once (as `propose_file_edit`). Accepted (review,
2026-10-21): a `path`/`cell_id` call is matched by `/code` rules only on its (absent) `code`, so
deny rules on code do not see a file's contents, the same as `bash` running a script.

**NB4. Outputs.** (Chris) `stream` text, `error` (name, value, traceback), `execute_result` and
`display_data` with an allow-listed MIME bundle: `text/plain`, `text/markdown`, `text/latex`,
`text/html` (DataFrames render as HTML tables), `image/png`, `image/jpeg`, `image/svg+xml`,
`application/json`. Anything else is dropped by the agent and refused by the server. The web shows
HTML and SVG only in the existing sandboxed, network-less artifact frame, never in the page
(KOBE-465). Accepted (coordinator, 2026-10-21): a pandas DataFrame's `text/html` table is read
with `DOMParser` (an inert document) and only its cells' text is rendered, as a table; any other
HTML goes to the frame. Matplotlib uses the inline backend (`MPLBACKEND`), which emits PNG display data.

**NB5. Code runs only in the sandbox.** (Chris) Never on the server or in the browser. The server
reads and writes notebook JSON; it never evaluates it.

**NB6. A member's execution is a `notebook` run.** `POST /v1/threads/{id}/notebook/run` creates a
run of kind `notebook` (no input, no model, never queued: the shape of a compaction, KOBE-213)
under the thread lock, so it shares the one-active-run rule: a thread with an active run answers
409 `thread_busy` (the kernel would serialise the two anyway). It answers 202 with `run_id` and
`exec_id` at once; the web follows `GET /v1/runs/{run_id}/events`. The requesting replica sends
`notebook.execute` (waking the sandbox like a `run.start`), then saves the outputs (NB11), appends
`notebook.finished` and ends the run (`completed`; `failed` when the sandbox could not run it).
A replica that dies meanwhile leaves a run with no command in flight: the run sweeper fails it
(`start_lost`). Only the thread's owner may run (the kernel is in their sandbox); a shared thread's
viewers watch the events.

**NB7. Interrupt and restart.** `POST /v1/threads/{id}/notebook/interrupt` sends SIGINT to the
kernel (the running cell ends `interrupted`, state kept). `POST .../restart` kills the kernel and
starts none (the next execution starts a fresh one; state lost; a running cell ends
`restarted`). Owner only. Neither wakes a sandbox: a sandbox that is not connected has no kernel
(`no_kernel`). An interrupt also drops every execution still waiting for that kernel (they end
`interrupted` without running). Stop on a `notebook` run (`POST /v1/runs/{id}/cancel`) ends the
run `cancelled`, frees the thread at once and sends `notebook.interrupt` (no `run.stop`: there is
no Pi); the cell's late answer saves its outputs but adds nothing to the ended run.

**NB8. Hung cells cannot wedge a run.** Every execution has a timeout (member: 10 min default,
`timeout_s` up to 60 min; agent: `timeout_s`, same bounds). At the timeout the agent interrupts;
if the kernel has not finished 5 s later it kills the kernel (state lost) and answers `timeout`.
The timeout counts from the command's arrival in the sandbox, waiting for the kernel included,
and an execution whose deadline passed while it waited is not run (`timeout`). An agent run that
ends (Stop, failure, its Pi exiting) interrupts its own execution and drops its waiting ones. So
no execution runs after the server stopped waiting for it. The server command deadline is the
timeout plus a margin (and the wake budget), so the requester always gets an answer.

**NB9. Caps.** Per output at most `NOTEBOOK_OUTPUT_MAX_BYTES` (192 KiB as JSON: one run event,
one small wire frame); a larger text is cut, a larger image or HTML is replaced by a note. Per
execution at most `NOTEBOOK_EXEC_OUTPUTS_MAX` (200) outputs and `NOTEBOOK_EXEC_OUTPUT_MAX_BYTES`
(2 MiB). The agent coalesces stream text (100 ms, 32 KiB) before sending. Past a cap the
agent stops forwarding and ends the outputs with one marker (`stream`/`stderr`, text starting
`[Kobe: output truncated`); `notebook.finished.truncated` is true. The server enforces the same caps
on what it accepts (a frame over them is dropped and counted, not stored) and the run's event cap.

**NB10. Kernel transport and identity.** No port: `kobe-sandbox-agent` starts
`kobe-kernel-bridge.py` (root-owned, in the image) over stdio (JSON lines), and the bridge starts
`ipykernel` through `jupyter_client` with the ZeroMQ `ipc` transport: unix sockets in a fresh
0700 directory of the bridge's uid, with the connection file and an HMAC key there. Nothing listens
on TCP, and nothing reaches the kernel from outside it; its way out is egress-proxy (NB17).
ipykernel's IOPub "pipe" (a 127.0.0.1 listener forwarding forked children's output) is switched
off, so a forked child's Python-level prints are not shown (accepted). Under Pi identities (KOBE-71) each
kernel takes an identity of its own from the pool and runs as that identity's partner (tool)
uid through `kobe-runas` (groups: its own and the workspace group; no capabilities;
`no_new_privs`), like the tool executor: it reads and writes `/workspace` as the tools do, and
cannot signal or read the agent, Pi, or another thread's tools or kernel. On stop the identity is
killed, reclaimed and released like a Pi identity. At most `KOBE_MAX_KERNELS` (4) kernels per
sandbox (the pool has 16 identities, Pi takes at most 8); a ninth thread waits for the
least-recently-used idle kernel to be stopped, or gets `kernel_unavailable`. The bridge sets
`IPYTHONDIR`, `JUPYTER_*` dirs to its private directory, so no IPython or Jupyter profile or
startup script from the shared `$HOME` runs. Python's user site stays on (so `pip install --user`
packages import): `.pth` files under the shared `~/.local` run at kernel start, which is the same
trust domain as the member's own workspace and tools (accepted, review 2026-10-21). ipykernel's
debugger is absent (debugpy is not installed).

**NB11. Outputs into the `.ipynb` through the save path.** When an execution of an `.ipynb` cell
ends, the requesting replica reads its outputs back from the run's `notebook.output` events (the
record; never from the sandbox's answer), replaces that cell's `outputs` and `execution_count`
and saves with `saveWorkspaceFile` (FE4) at the version it read the source from (`base_sha256`).
On 409 it re-reads once and merges into the current version if the cell (same id) still exists;
otherwise nothing is saved and `notebook.finished.saved` is null with `save_error`. The member's
editor then sees a newer version (FE6: reload). The new revision reaches the sandbox like any
save. `.py` and ad-hoc code are not saved anywhere but the events. The notebook's size limit is
`NOTEBOOK_FILE_MAX_BYTES` (8 MiB).

**NB12. Agent edits to cells are proposals.** The agent changes a notebook only through
`propose_file_edit` (FE8: whole new content, reviewed and committed by the member) or its own
file tools on its local copy (FE6 conflict rules). `run_python` never changes cell sources.

**NB13. `run_python {code} | {path, cell_id?}`.** `code`: run it as is (at most
`NOTEBOOK_CODE_MAX_BYTES`, 256 KiB). `path` of a `.py`: the agent pushes the file first (as
`share_file`), the server runs the synced copy. `path` of an `.ipynb` with `cell_id`: the agent
pushes the notebook, the server runs that code cell's source and saves the outputs (NB11). The
outputs stream as the agent run's `notebook.*` events; the model gets a text summary (stdout and
stderr, results as `text/plain`, the error and traceback without ANSI codes; images and HTML as a
one-line note), at most 16 KiB. Behind capability `notebooks`. In a skill eval's run (KOBE-325)
only `code` is allowed, in the eval sandbox's own kernel like `bash`: a `path` call is denied by
policy (`eval_run_isolated`) and refused on the wire, so an eval never reads or writes the
member's synced files (`propose_file_edit` is eval-isolated for the same reason).

**NB14. Where outputs are accepted.** A `notebook.output` frame names the wire `command_id` of a
`notebook.execute` this connection delivered and has not answered; the run, thread and exec id
come from that command, never from the frame. Anything else is a lease violation. The holding
replica appends outputs in order and drains them before it records the command's answer, so the
requester reads every output it will save.

**NB15. Events.** `notebook.started {exec_id, origin, tool_call_id?, path?, cell_id?}`,
`notebook.output {exec_id, index, output}`, `notebook.finished {exec_id, status,
execution_count, outputs, truncated, saved, save_error?}`; `status` is `ok`, `error`,
`interrupted`, `timeout`, `restarted` or `failed` (the sandbox could not run it). Compacted with
the run's events after 7 days (D18); the `.ipynb` keeps the saved outputs.

**NB16. Compatibility and what v1 leaves out.** Additive: an agent without `notebooks` never
registers `run_python`, and the server refuses kernel commands to it (`notebooks_unsupported`).
No migration beyond the run kind and command kinds (`0169_notebook_kinds`). Left out: `input()`
(stdin is refused), widgets (`application/vnd.jupyter.widget-*` is dropped), other kernels than
Python, and persisting kernel state across hibernation.

**NB17. Network: as the sandbox shell.** (Chris, 2026-10-21) A kernel reaches the internet the
same way the agent's shell tool does: through egress-proxy, under the team's allowlist, and a
blocked domain gives the same `egress.blocked` notice with Request access. The agent keeps the
kernel's rotating egress token in a file only the kernel's uid may read (a fresh 2750 directory in
the agent's runtime directory) and passes the kernel the file's path, the proxy URL and the
thread id, never the token. Before each cell the bridge runs a silent snippet that reads the token
and sets `HTTPS_PROXY` and friends (the shell's `BASH_ENV` rules), so a rotated token is used from
the next cell on (one cell longer than the token's life needs a re-run, as a long shell command
does). The proxy names the thread, so a member's `notebook` run (which has no lease) gets its
kernel's blocked attempts. No secrets enter the kernel; nothing inbound.

**NB18. Eval isolation.** See NB13: skill evals run code only, never the member's files.

## 3. Shapes the web needs (KOBE-465)

- Run: `POST /v1/threads/{id}/notebook/run` body `notebookRunBodySchema`, 202
  `notebookRunResponseSchema`; errors `notebookErrorSchema` (`NOTEBOOK_ERROR_CODES`).
- Interrupt / restart: `POST /v1/threads/{id}/notebook/interrupt|restart`, 200
  `notebookKernelResponseSchema`.
- Events on `GET /v1/runs/{id}/events`: `notebook.started`, `notebook.output`
  (`notebookOutputSchema`, nbformat 4 output), `notebook.finished`; the agent's tool card is the
  `run_python` call (`RUN_PYTHON_TOOL`), matched by `tool_call_id`.
- After `notebook.finished.saved`, reload the file (its `sha256` is the new version).
- HTML outputs: `GET /v1/workspace/output-frame?team=` (KOBE-465), a fixed shell document with the
  artifact frame's headers (`FRAME_HEADERS`) and the WebRTC guard; the page posts the HTML to it
  once (`{type: "kobe.notebook.html", html}`) and it writes it into itself. Frame loads from Kobe's
  page only, for the active team; never `srcdoc`, never kernel HTML in the page.

## 4. The web (KOBE-465)

- `.ipynb` opens as a notebook in the artifact column (`components/notebooks/`, loaded lazily):
  code cells in CodeMirror (Shift+Enter runs), Markdown through the chat's safe Markdown
  component, add/move/delete, Run cell, Run all (in order, stops at the first cell not `ok`),
  Interrupt, Restart (asks first), kernel busy/idle, execution counts. Edits are file editor
  drafts (the notebook serialized) saved through FE4 with the conflict notice; a run saves unsaved
  edits and missing cell ids first (NB1), since the server reads the saved notebook. After
  `notebook.finished.saved` the view reads the new version and keeps edits typed meanwhile
  (sources stay the member's, outputs and counts come from the server).
- Outputs: stream text and tracebacks as text with ANSI codes stripped; PNG/JPEG and SVG as
  `<img>` from `data:` URLs (SVG re-encoded, never inline markup); a DataFrame's `text/html`
  table read into rows of plain text with `DOMParser` (an inert document: no script, no loads;
  only `textContent` is used) and a Table Schema in `application/json` likewise; Markdown as
  above; every other `text/html` only in the output frame. A saved output that fails the
  protocol's output schema (after dropping MIME types outside NB4) is "cannot be shown".
- `.py`: the file editor plus a Run pane (the saved file; unsaved changes block Run).
- Live: the member's runs follow their own event stream; the agent's `run_python` events arrive on
  the thread's stream; both feed one per-tab execution store. A cell's latest execution shows in
  that cell until its saved version is read back; the agent's `code` runs show below the cells.
  `egress.blocked` on the member's own runs shows the shell's egress notice.
- Agent edits: `propose_file_edit` on an `.ipynb` opens the file editor's inline diff (FE10) in
  place of the notebook until committed or discarded.
