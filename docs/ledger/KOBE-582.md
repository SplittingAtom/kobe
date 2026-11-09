# KOBE-582: Workspaces WS-7: remove propose_project_file, browser spec, docs

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (coordinator pushes and opens the PR)
- **Branch / worktree:** `kobe-582-removal-spec-docs` in `../Kobe-wt582`
- **Depends on:** KOBE-576..581 (merge of main with PR #501 before the PR)

## What changed

- **Removed `propose_project_file`** (Chris, spec section 14 question 2): kobe-tools tool and
  `project-tool.ts`, the agent's `ProjectFileBroker` (`tools/project-broker.ts`) and its wiring in
  `agent.ts`, the `project.file_propose` kobe-tools op and `project_file_propose` answer parser;
  the server's `projects/proposals.ts`, the frame handler in `sandbox-wire/connection.ts`, its
  context deps, the policy tool-input entry, the bound-tool entry, `isProjectWrite`; the protocol's
  tool input, error codes, kobe-tools request/response and the frames `project.file_propose` and
  `project.file_propose_result` (a note in `projects.ts` and `sandbox-wire/project-frames.ts`).
  Tests: `project-propose.db.test.ts` deleted; a protocol test now pins that the old shapes no
  longer decode.
- **Kept on purpose:** `project_files.source = 'proposal'` stays a valid historical value (no
  migration; the web still labels old rows "Proposed by an agent, approved"); the audit event
  `sandbox.project_file_refused` stays in the registry so old rows still read, but nothing writes
  it; `docs/audit-log.md` marks it removed.
- **Browser spec** `e2e/browser/tests/workspaces.spec.ts` (needs gate1; one model turn):
  1. owner creates a restricted project with `notes.md` and adds member2 as reader;
  2. member2 converses in it (`/?project=<id>`): Projects tree lists it, the file opens with "You
     can read this project, not change it.", no Check out, no Save;
  3. member2's upload answers 403/404 and the project page has no Upload file control;
  4. owner promotes member2 to editor;
  5. member2 checks out, edits in Raw, saves, commits "What changed?" with a message;
  6. owner sees the commit under History and the edit in their own mount (a thread in the project).
     Cleanup in `afterEach`: threads, project archived then deleted, member2's context closed. Skips
     without the checkout API or without `KOBE_USER2`/`KOBE_PW2`. Not run here (no gate1).
- **Older specs** moved to the 581 labels: tree "Files in your workspace" -> "My files", rail
  navigation "Teams" -> "Workspace", "no longer in your workspace" -> "no longer in your files";
  `add-to-project.spec.ts` reads the project in the Projects tree.
- **Docs:** `docs/file-editing.md` (overview bullet, 3f mounts, new 3g checkout and commit),
  `docs/audit-log.md`, `docs/approvals.md`, a glossary section in `docs/development.md` (there is
  no separate API reference; Workspace = team row, routes unchanged). GV4 audit rows were already
  complete from 577..579.

## Open questions

- The glossary line lives in `docs/development.md` because no API reference exists; move it if one
  is added.

## Evidence

See the commands in the final report of this ticket's run; the browser spec result is the gate's.
