# Kobe — File Editor (KOBE-462 server and protocol, KOBE-463 web)

Status: **decisions by Chris, 2026-10-21** (FE1–FE3 binding; FE4–FE12 settled in KOBE-462 within
them). Contract: `packages/protocol/src/file-editor.ts`. Ledger: `docs/ledger/KOBE-462.md`.

## 1. Summary

Text files of the member's workspace, opened in the artifact column, become editable. The
conversation agent knows which file the member is looking at and can **propose** an edit, which
the member reviews as an inline diff (green added, red deleted), accepts or rejects per change,
and commits. Nothing is written until the member commits. The web editor is CodeMirror 6 with
`@codemirror/merge` `unifiedMergeView` (KOBE-463).

Three server parts (KOBE-462): the save route, the viewed-file context of a message, and the
built-in tool `propose_file_edit`.

## 2. Decisions

**FE1. The agent proposes; the member commits.** (Chris) `propose_file_edit` never writes the
file, in the synced copy or the sandbox. Only the member's save (FE4) writes, from the web.

**FE2. Workspace files only.** (Chris) The member's own workspace area, plus their drops directly
in `uploads/` (KOBE-199), exactly what the browser upload may write. Project mounts
(`projects/`) and thread uploads (`uploads/<thread>/`) stay read-only (`read_only`), agent-made
artifacts stay read-only and versioned (D25), and agent-internal `.kobe/` paths are not found.

**FE3. Per-change accept/reject in the web.** (Chris) The server deals in whole contents only;
the web diffs the proposal against the base version and builds the committed content from the
accepted changes (KOBE-463).

**FE4. Save route: replace at a version.** `PUT /v1/workspace/file?path=&base_sha256=`, body =
the new bytes. The version is the SHA-256 of the synced copy, which the listing, the search and
the proposals already carry; the editor sends the version it loaded. Under the workspace lock the
server checks the live row still has `base_sha256` and writes a new revision (`putServerFile`,
origin `server`); otherwise **409 `version_conflict`** with `current` = the version it found
(null when the file was deleted). Unchanged content answers 200 with no new revision. The upload's
rules apply unchanged: path rules (`workspacePathSchema`), the size limit (the smaller of the
site's workspace file limit and the upload limit), the workspace quota and the team storage quota
under the team's storage lock (judged on the size change: a shrinking save always passes), the
content-addressed blob path with its reservation, and the audit event `workspace.file_saved`
(`userId`, `bytes`; never the name or content). Only existing files are saved; a new file is
uploaded.

**FE5. Who may save.** Whoever may upload to that workspace: the member, into their own
workspace (`team.chat`). The owner always comes from the session, never the request, so no path
names another member's file (a teammate's path answers 409 with no current version).

**FE6. Reaching the sandbox, hibernation and agent edits.** A save reaches the sandbox the way an
upload does: the new revision is in the manifest and the sandbox pulls it before its next run,
on its periodic sync, or on wake. A hibernated sandbox therefore gets it on wake, before the run
that follows. If the agent changed the file and pushed first, the member's save is based on an
older version and gets 409 (the editor reloads and reapplies). If the agent changes its local
copy after the save but before pulling it, its push is based on an older revision and becomes a
conflict copy on the sandbox side (workspace-sync rule): the member's save is never lost. A legal
hold does not block saves; the collector never frees content under a hold.

**FE7. Viewed-file context.** A member's message may carry `viewing: {path}` (the file open in the
artifact column). At submit the server validates the path (protocol schema; 400 otherwise),
reads the sender's own synced copy (the sender is the thread's owner, whose sandbox runs it), and
keeps `{path, sha256, size, content?, truncated}` on the run (`runs.viewing`, server-written,
never in the message text, events or history). `content` is the first 32 KiB as text (valid
UTF-8 without NUL, a character split by the cut is dropped); a binary file has no content. An
agent-internal, missing or unreadable file adds nothing and the message still goes. The file is
read only after the server has checked the sender owns the thread. When the run ends (any
terminal state) the server clears the text and keeps only `{path, sha256}` for the record, so a
copy of the file never outlives the run, its event compaction or the file's deletion. A retry
reads the original's path again from the owner's workspace (current content, or nothing if the
file is gone). Edit and regenerate (KOBE-467, coordinator 2026-10-22): an edit sends the file
viewed now, like a new message (none once its chip was removed); a regenerate sends
`viewing_from_entry` (the prompt's entry id, never with `viewing`) and the server reuses the
path of the run that sent that prompt (`runs.viewing` keeps it after the run ends), reading the
file's current content at submit; nothing is added when that run viewed none or the file is
gone, and the run still goes. `run.start.viewing` carries it only to agents with the `file_edits`
capability; the agent puts it in **that run's system prompt only**, through the per-run memory
file (never the launch or the session), fenced between `<<<BEGIN VIEWED FILE nonce>>>` markers
with a random per-run nonce, verbatim inside (so proposals are not built on sanitised text), and
labelled as data, not instructions. **The context holds at most one viewed file, the current
run's** (KOBE-473): the per-run file is rewritten before every run (empty when the run views
nothing), Pi forces it into that run's requests only and never records it in the session, so a
later run carries its own file or none, a restarted Pi rebuilt from the session brings no older
one back, and the context viewer shows at most one `viewing_file` section. Steers and Pi's own
retries within a run see that run's file; a compaction's summary call gets none.

**FE8. `propose_file_edit {path, content, summary}`.** A Kobe built-in (`BUILTIN_TOOLS`): risk
`read`, scope `kobe`, primary argument `/path`. It writes nothing, so ask-on-write does not
prompt for it; site and team deny and ask rules, path rules and `ask-all` still apply, and the
server decides every call (`policy.check`). The wire frame `file.edit_propose` is accepted only
from a connection that announced `file_edits`, for an active leased run, and for a call the
connection allowed with the same canonical input, taken once. The server checks the path (under
`/workspace`, FE2) and that the run owner's synced copy has a live row there (else `not_found`:
the agent saves its file first), content at most 128 KiB UTF-8 without NUL, summary 1–500
characters. It records the proposal and answers `awaiting_user` with the path and the
`base_sha256`. The model is told (tool guidelines and the viewed-file section) to propose edits
to the viewed file rather than change it with write, edit or bash, and that nothing was written.

**FE9. The proposal record.** The server's record is the run's `file.edit_proposed` event:
`{tool_call_id, path, base_sha256, content, summary}`, live on the stream and readable after a
reload with `GET /v1/threads/{id}/file-edit-proposals` (the thread owner only; others 404),
oldest first, newest 200. The web builds the diff from this, never from the tool result the
sandbox relays. Run events are compacted 7 days after a run ended (D18), and its proposals with
them (Chris, 2026-10-21: accepted): the card then says the proposal expired; the tool call input
stays in the history.

Who sees a proposal's content: everyone who may stream the thread's run events
(`GET /v1/runs/{id}/events`, `canWatchThread`): the owner, and once the owner shares the thread,
the team (shared to the team) or the project's members (shared to its project). They see the same
content in the `propose_file_edit` tool call's input and in the thread's history, so the event
discloses nothing more; this is intended (a shared thread is shared whole). The list route is
owner-only because only the owner can commit a proposal to their workspace.

**FE10. Committing a proposal.** The web applies the accepted changes to the base content and
saves with `base_sha256` = the proposal's base. A 409 means the file moved on since the proposal:
the web offers to reload, and the agent can propose again against the current content.

**FE11. Whole contents, not patches.** The model sends the whole new content; it is easier to
validate, cannot misapply, and the web computes the diff it shows. 128 KiB keeps a proposal inside
one run event (256 KiB as JSON; a larger escaped payload is refused `too_large`).

**FE12. Compatibility.** Additive: an agent without `file_edits` never registers the tool and
never gets `run.start.viewing` (the server drops it); old clients never send `viewing` or call
the save route. One migration (`runs.viewing`, nullable).

## 3. Shapes the web needs (KOBE-463)

- Save: `workspaceSaveQuerySchema`, 200 `workspaceSaveResponseSchema` (a file entry), 409
  `workspaceSaveConflictSchema`; other errors `workspaceFileErrorSchema`.
- Message: `submitMessageBodySchema.viewing` (`messageViewingSchema`).
- Proposals: event `file.edit_proposed` (`fileEditProposedPayloadSchema`), list
  `fileEditProposalsResponseSchema`; the tool card is the `propose_file_edit` tool call
  (`PROPOSE_FILE_EDIT_TOOL`), matched by `tool_call_id`.
