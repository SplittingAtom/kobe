# KOBE-164: 57f: Web: projects UI and e2e

- **Status:** in review
- **Branch / worktree:** `kobe-164-projects-ui` in `../Kobe-wt164`
- **Depends on:** [KOBE-161](KOBE-161.md) (API, roles), [KOBE-162](KOBE-162.md) (files),
  [KOBE-163](KOBE-163.md) (share, read-only, fork), [KOBE-158](KOBE-158.md) (memory panel). No migration.

## Plan

`apps/web` and `e2e` only. No server or sandbox-agent change (no read-only API field was missing).

## Decisions

- **Pages** under the member area: `/me/projects` (list, archived toggle, create) and `/me/projects/<id>`
  (settings, members, files, conversations). Components in `components/projects/`, client in
  `lib/projects/api.ts` (camelized responses, snake_case bodies, `X-Kobe-Team` on every call). Linked from
  the chat header ("Projects").
- **Permissions:** `projectPermissions(teamRole, project.my_role)` from `@kobe/protocol` hides or disables
  controls (create: admin/builder; manage and members: owner or team admin; use: any member). The server
  stays the authority: refusals are shown with the server's message (a few reworded in `describeProjectError`).
  A team admin who is not a member manages the project but gets no memory link (the memory API 404s for them).
- **Archived** projects are read-only everywhere (form fields `readOnly`, no add/remove/upload/delete, no
  new-conversation link); managers keep Restore and Delete. Delete is the server's call (409 `project_in_use`
  explains itself).
- **Default agent:** the list is `GET /v1/agents/runnable` minus personal agents (the server rejects those).
  An agent the viewer cannot see stays selected as "Current agent (not available to you)".
- **Members:** names come from `GET /v1/team/members` (readable by every member); the add list offers team
  people not yet listed. In mode `team` the API lists owners only; the page says so.
- **Files:** upload is multipart with the folder field first (as the route reads it); the list marks
  `source: proposal` as "Proposed by an agent, approved" and the section text says a proposal is added only
  after the person in that conversation approves it. The API has no endpoint for pending proposals, so none
  are listed (approval happens on the conversation's approval card).
- **Plain text only:** names, descriptions, instructions, file names and thread titles are React text nodes,
  input values or a textarea value, never HTML or markdown (test "renders names, instructions and file names as
  plain text").
- **Thread UI** (`chat/project-bar.tsx`): for the owner of a thread in a project a "Share with the project"
  switch (`POST /threads/:id/share`); for a reader (`read_only: true` from `GET /threads/:id`) a banner with
  "Fork into my conversations" (`POST .../fork`, then opens the fork and reloads the list). Readers get no
  composer (a note instead), no Edit/Regenerate, and only the stream status in the run panel (no usage,
  queue, retry, budget). Types gained `visibility` and `readOnly`; `ThreadController.setVisibility/fork`.
- **New conversation in a project:** `/?project=<id>` sets the session's draft project; `createThread` sends
  `project_id`; a note names the project. The thread list itself stays the person's own threads (the API lists
  shared ones only with `?project_id=`), so shared threads are found on the project page, which lists the
  project's conversations with "shared by <name>, read-only". No project filter in the sidebar (not asked for
  by the acceptance criteria).
- **Memory picker** (`projects/project-picker.tsx`, `me/my-memory-page.tsx`): "Memory of" select (Me or a
  project the viewer is a member of, archived included); keeps `?project=` in the address; hidden when there is
  no project or the list fails. The panel is keyed by target so state never leaks between scopes.
- **FakeKobe** gained `project_id`, `visibility`, `read_only`, `POST /share` and `POST /fork`.
- **e2e** (`e2e/run.sh`, section "projects (KOBE-164)", API level like the other sections: the web has no
  browser suite): Owner creates a project and one the reader is not in, adds the reader, uploads a file,
  runs a conversation in the project, shares it; the member reads it read-only (post and rename 403
  `read_only`), sees it only in the project list, forks it (private, in the project, with the entries); the
  author never sees the fork; unsharing hides the thread (404); archiving refuses new files. `CHAT_JS` takes
  the project through `CHAT_PROJECT`.

## Open questions (for Chris or the coordinator)

- The sandbox does not yet apply `run.start.project` instructions to the prompt (KOBE-162 open question), so
  the brief's e2e "instructions applied" is not covered here; the instructions are stored and sent by the server.
- The e2e could not run locally (needs the k3d cluster); its script was syntax-checked only. CI is the proof.
- Unsharing/forking from the sidebar's search hits is not surfaced; hits open the thread, where the bar applies.

## Evidence

- ac-1: `components/projects/projects.test.tsx` (list, create, edit, archive, read-only archived, member and
  admin views, members add/role/remove/last owner, files upload/delete/proposal mark, plain text);
  `me/my-memory.test.tsx` "project picker".
- ac-2: `components/chat/project-sharing.test.tsx` (share toggle, refusal, read-only banner and controls, fork,
  plain-text title, new conversation in a project).
- ac-3: `e2e/run.sh` "projects (KOBE-164)".
