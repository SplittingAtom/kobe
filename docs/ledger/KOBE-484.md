# KOBE-484: Agent open_file: asking the agent to open a file opens it in the editor

- **Status:** in review (group branch `group-44-agent-open-file`, not pushed)
- **Branch / worktree:** `group-44-agent-open-file` in `../Kobe-wt484`
- **Depends on:** KOBE-462/463 (file editor, `file_edits`), KOBE-464 (eval isolation).
- **Spec:** [docs/specs/file-editor.md](../specs/file-editor.md) FE13.

## Plan

1. Protocol: `file-open.ts` (tool, input, answer, `file.opened`), `file.open` frames, built-in.
2. Server: `sandbox-wire/file-open.ts`, bound tool, eval isolation, policy path tool.
3. sandbox-agent: `open_file` tool (with `propose_file_edit`), `FileOpenBroker`, guidance.
4. Web: `file.opened` on the tool activity, live-only open request, `OpenFileCard`.
5. Browser spec `e2e/browser/tests/open-file.spec.ts`.

## Decisions

- No new capability: `open_file` rides `file_edits` (same feature, same agent build); the server
  refuses `file.open` from a connection without it.
- Push-then-open (as `share_file`): the agent confines the path locally (missing file, symlink,
  `.kobe/` are tool errors before anything is sent), pushes the file so the member sees what the
  agent just wrote, then the server checks a live synced row of the **run owner's** workspace.
  A failed push (sync off, too large, read-only area that differs) still asks the server, which
  opens its synced copy or answers `not_found`. No size limit (the viewers handle big files).
- Read-only areas (project files, thread uploads) may be opened; internal paths never.
- Risk `read`, bound to its allowed check and consumed once (as `propose_file_edit`); denied in
  skill evals (`eval_run_isolated`) and refused on an eval connection.
- Event `file.opened {tool_call_id, path}` only, never content; not audited (no read or write).
- Web (Opus review): live vs history by the stream's seq, no timing. Run snapshots carry
  `last_seq` (`runs.last_seq`). When the controller first opens a run's stream, history ends at 0
  for a run this tab started, else at max(resume point, the run's `last_seq` from the run list;
  unknown = everything sent so far). Only a `file.opened` above that, and new to this client,
  becomes `fileOpenRequest`; a reconnect (Last-Event-ID) keeps the bound, so events that arrive
  after it still open. The card opens that tab once per page (`<run>:<tool call>`); after a
  reload it is built from the call's own path and offers Open again; a shared reader gets no
  Open again (the file tab reads the viewer's own workspace anyway).
- Guidance lives in the tools' `promptGuidelines` (Pi's system prompt for built-ins): `open_file`
  "when the user asks to open, show or view a workspace file ... not share_file, create_artifact
  or pasted text"; `share_file` "only when the user wants to download a file or keep a copy".

## Open questions (for Chris or the coordinator)

- The browser spec needs a deployment with this build; it was not run against gate1 here (no
  deploy from this worktree).
- No real-Pi suite for `open_file` (Pi not installed locally; `propose_file_edit`'s covers the
  extension path).

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/file-open.db.test.ts` (5: event recorded with path only, read-only
  allowed / missing / internal / outside refused, other member's file not found, capability +
  allowance + single use, skill eval denied and refused); `policy/evaluate.test.ts` (3 cases);
  protocol `file-open.test.ts`; sandbox-agent `tools/file-open-broker.test.ts`,
  `kobe-tools/open-file-tool.test.ts`.
- ac-2: `apps/web/components/files/open-file.test.tsx` (live open in the editor with Rendered/Raw,
  reload opens nothing and Open again works, replayed backlog does not open, resume mid-run opens
  only later events, also after a reconnect, a finished run's replay opens nothing, shared reader
  has no Open again, failed call has no card); `lib/chat/live.test.ts`.
- ac-3: guidance asserted in `open-file-tool.test.ts`; `e2e/browser/tests/open-file.spec.ts`.
- verify: all steps green; `@kobe/server test:db` 186 files / 2244 tests; sandbox-agent 1000 tests; web 271 files / 2463 tests.
