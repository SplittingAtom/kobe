# Kobe — Projects in conversations (Workspaces follow-up)

Status: **draft, questions open** (§9). Requested by Chris, 2026-11-09; items marked _(Chris)_ are
his, the rest are proposals within them. Written against main `3a893e08` (gate1
`local-3a893e08156a`), on top of [`workspaces.md`](workspaces.md) (gate KOBE-583). No tickets
filed yet (§10).

Request (Chris, 2026-11-09): when a new conversation starts with a project selected, the top of the
conversation pane says **New conversation in &lt;ProjectName&gt;**, with an icon to unmount the
project or switch to a different one. Once the conversation starts, its name area says
**&lt;ProjectName&gt; / &lt;conversation name&gt;**. In the Files panel, **every project of the
workspace shows under Projects**; projects not in the current conversation are greyed out, and the
project in the current conversation is not greyed and has a **green dot** to show it is active. A
member whose role lets them edit a project can have an **agent propose edits** to a file in the
project, and accepting a proposal **commits** it.

## 1. Summary

| Area                    | Change                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New conversation header | "New conversation in &lt;Project&gt;" plus a project control (switch, remove) in place of the `DraftProjectNote` banner                                                          |
| Conversation title      | "&lt;Project&gt; / &lt;conversation name&gt;" for a conversation in a project; the slash is the separator _(Chris)_                                                              |
| Files panel, Projects   | Every project the member may view; greyed unless it is the current conversation's; the current one has a green dot; role chip and "editing" mark stay                            |
| Agent edits             | `propose_file_edit` accepts files of the conversation's project when the member can edit it; **Accept commits** the change as a new project commit _(Chris)_, no checkout needed |
| Mounting                | Unchanged (workspaces MT1): a project mounts when the member has a conversation in it or a checkout; listing a project in the panel does not mount it                            |

Nothing here changes roles (workspaces PR1–PR6), the commit model (CM1–CM10) or the
one-project-per-conversation rule (SS2).

## 2. Today (verified on main `3a893e08`)

- **Header.** `apps/web/components/chat/thread-title.tsx:46` (`ThreadTitle`, rendered at
  `thread-view.tsx:304`) shows "New conversation" for a conversation not created yet (line 65),
  else the title or "Untitled conversation"; clicking the name renames it (`PATCH /v1/threads/{id}`).
  The project does not appear in the title.
- **New conversation in a project.** `?project=<id>` (Open to mount, Open in a conversation) sets
  `session.draftProjectId` (`chat-app.tsx:293-304`, `lib/chat/session.ts:349-362`);
  `DraftProjectNote` (`project-bar.tsx:105`, rendered at `thread-view.tsx:315`) says "This
  conversation will be in the project X. It stays private until you share it." There is **no way
  to remove or change the project** before sending, and the draft project is only cleared when a
  conversation is created (`thread-list-adapter.ts:160` `takeNextProject`), so **New conversation
  keeps it** (bug, fixed by NC4).
- **Files panel.** `components/files/workspace-tree.tsx` (`useProjectsInTree`, line 36) lists only
  **mounted** projects under Projects, with the role chip and "editing ●" (lines 64-75) and
  "All projects (N) →" (line 137). Data: `components/projects/workspace-projects.tsx` loads
  `GET /v1/projects` and the member's checkouts already (line 78), so the full readable list is in
  the client.
- **Moving a conversation.** `POST /v1/threads/{id}/move` (`routes/threads.ts:602`); the thread
  menu's "Move to project" (`lib/shell/commands.ts:366`, `use-organize-menu.ts:145-168`).
- **Proposed edits.** `propose_file_edit` (KOBE-462, spec FE8): the agent proposes new content for
  a file in the member's scratchspace; the server records a `file.edit_proposed` event against the
  synced copy and answers `awaiting_user`; the web shows a card (`components/files/file-edit-card.tsx`)
  whose Review opens the file with an inline diff; accepting or rejecting is the member's click.
  The server refuses project paths: `sandbox-wire/file-edit-propose.ts:118` ("Project files and
  thread uploads are read-only").
- **Agent commits.** `commit_project` (workspaces CM6) exists for runs with
  `run.start.project.access = "write"` and needs a policy rule or a signed approval
  (`sandbox-wire/policy-check.ts:64`, `sandbox-wire/project-commit.ts`). It commits a checkout.
- **Pickers.** No reusable project picker: `projects/project-picker.tsx` (memory page, member
  projects only) and the inline `<select>` in `projects/add-to-project.tsx` (KOBE-585).

## 3. New conversation header

**NC1. Title.** While the conversation is not created yet, the header reads **"New conversation in
&lt;ProjectName&gt;"** when a project is selected, else "New conversation" as today _(Chris)_. The
project name is truncated with an ellipsis before the leading words are (full name in the
tooltip). The `DraftProjectNote` banner goes; its privacy sentence ("It stays private until you
share it.") moves to the project control's tooltip and menu header (Q8).

**NC2. Project control.** An icon button next to the title (`FolderKanban`-style project icon,
command `draft-project`, label "Project for this conversation") opens a menu _(Chris: unmount or
switch)_:

- the projects the member may **converse in** (every project they may view: readers converse,
  workspace PR3), the selected one checked, filtered by typing when there are more than 8;
- **Remove project** (when one is selected): the conversation will be a My files conversation.

Shown on every new conversation, including one with no project (then it reads "Add to a project")
(Q2). Read-only and keyboard reachable like the other header actions; the command is in the
command palette ("Choose the project for this conversation").

**NC3. Mounting does not move.** Choosing or removing a project only changes `draftProjectId`;
nothing mounts until the first send creates the conversation (MT1). So "unmount" in the request is
**Remove project** in the product: before the first message nothing is mounted for this
conversation. A project that is mounted because of the member's other conversations stays mounted.
After the first send the project is fixed for the conversation; changing it is the existing
**Move to project** (NC5, TT3).

**NC4. The draft project's life.** The draft project is cleared by **New conversation**, by
switching workspace and by opening another conversation; it survives typing, attachments and the
model picker. Starting a conversation from a project (Open to mount, Open in a conversation, the
Files panel's "New conversation in this project", FP4) sets it.

**NC5. Errors.** A project the member can no longer converse in (removed, archived, access lost)
at send time: the send is refused as today (`thread create` checks), the header keeps the text and
the control says "You can no longer start conversations in &lt;Project&gt;" with Remove project
focused. `too_many_mounts` (MT3) is shown the same way with the limit.

## 4. Conversation title

**TT1. Format.** A created conversation in a project shows **"&lt;ProjectName&gt; /
&lt;conversation name&gt;"** _(Chris: slash separator)_; "Untitled conversation" stands in for a
missing name; a conversation without a project shows its name alone, as today. The separator is a
plain " / " with the project name in the muted foreground colour, so the conversation name stays
the main text.

**TT2. Behaviour of the two parts.** The conversation name keeps rename-on-click (`ThreadTitle`).
The project name is its own button: it opens a menu with **Open project** (`/me/projects/{id}`)
and **Move to project…** (TT3). Long names: the project part shrinks first (max 40% of the
header), then the conversation name; both have full-text tooltips. The accessible name of the
header is "&lt;ProjectName&gt; / &lt;conversation name&gt;"; the rename button keeps
"Rename &lt;title&gt;".

**TT3. Moving after the start.** "Move to project…" in the project menu is the existing move
(`POST /v1/threads/{id}/move`, same rules) offered from the header as well as the thread menu,
including "Move out of the project" (Q3). Shared readers and Trash see the title without menus.

**TT4. Elsewhere.** The browser tab title follows TT1. The Threads panel keeps project groups as
today (the project is already the group header there, so rows keep the bare name).

## 5. Files panel: all projects, current one active

**FP1. List.** Projects lists **every project the member may view** in the active workspace
(workspace-visible projects and restricted projects they hold a role in), not archived, sorted by
name, with the current conversation's project first _(Chris: all projects show)_. Team admins see
the projects they may view by the same rule plus restricted projects they are not in only on the
All projects page (Q1). "All projects (N) →" becomes "Manage projects →" (the page stays for
creating, archiving and members). Data: the provider's existing `GET /v1/projects` list; no new
route.

**FP2. Active and greyed.** The **current conversation** is the conversation on screen, or the new
conversation being drafted. Its project (the thread's `project_id`, or `draftProjectId`) is
**active**: normal text and a **green dot** before the name _(Chris)_. Every other project is
**greyed** _(Chris)_: the muted foreground token (not opacity), still at least 4.5:1 against the
rail. Not colour alone: the dot has the accessible label "Active in this conversation" and greyed
rows carry the description "Not in this conversation". A conversation with no project has no
active row. One active row at most (one project per conversation, SS2). The dot is a green status colour defined per theme preset (theming TH1-TH12; there is no success token yet, `--kobe-gauge-ok` is the nearest), checked for 3:1 against the rail in light and dark.

**FP3. Marks that stay.** The role chip (reader / editor / owner) and "editing ●" for a checkout
stay on every row, greyed or not. A greyed project that is checked out shows "editing" in its
normal colour so a pending working copy is never hidden.

**FP4. Opening a greyed project.** Expanding a greyed project shows its files read-only: from the
member's mount when it is mounted (another conversation), else from the project's head
(`GET /v1/projects/{id}/files`, readers) without mounting (Q4). Its menu: **New conversation in
this project** (sets the draft project, NC4), **Move this conversation here** (when the current
conversation is the member's own and the move rules allow it), **Open project**. Dragging a file
from a greyed, unmounted project onto the composer is refused with "Start a conversation in
&lt;Project&gt; to mention its files" (the file is not in the sandbox).

**FP5. Scale.** More than 50 projects: the list shows the active one, checked-out ones and the
50 most recently used, then "Show all (N)" which expands in place; a filter field appears above
the list at 20 or more. The tree stays virtualised as today.

**FP6. Refresh.** The list follows the provider: it reloads on workspace switch, after a project
create, archive or member change made in this tab, and when the conversation on screen changes
(only the active row moves; no fetch). Server-pushed tree changes stay the separate Files panel
refresh item (gate-workspaces open problem 2).

## 6. Agents propose edits to project files

**PE1. Who.** A run whose `run.start.project.access` is `"write"`: the conversation's owner is an
editor or owner of the conversation's project, or a team admin (workspace PR3) _(Chris: a role
that allows editing)_. Readers' runs: the tool refuses project paths with "You can read
&lt;Project&gt; but not change it." Scheduled and `auto` runs: as `propose_file_edit` today (the
proposal waits for the member).

**PE2. Which files.** Paths under `/workspace/projects/<slug>/` where `<slug>` is the
**conversation's own project** (Q5), existing files and new files (Q7), within the project path
rules, `PROJECT_FILES_MAX` and `PROJECT_FILE_MAX_BYTES`. Other projects' paths keep the read-only
refusal.

**PE3. The proposal.** `propose_file_edit { path, content, reason }` is unchanged for the agent;
`reason` (≤ 500 chars) becomes the commit message. For a project path the server
(`file-edit-propose.ts`) checks PE1/PE2 against the project and the member's current role, and
records the `file.edit_proposed` event with `project_id`, `base_commit_seq` (the head at proposal
time) and `base_sha256` (the file at that head, absent for a new file). Nothing is written. Limits
as today (`MAX_PENDING_PROPOSALS_PER_THREAD` 4).

**PE4. Accept commits.** _(Chris)_ The card (`file-edit-card.tsx`) names the project ("Proposed
edit to plan.md in Budget 2027") and shows the diff against the head. **Accept** is one click that
**commits**: `POST /v1/projects/{id}/commits/from-proposal { thread_id, proposal_id }` (editor+,
checked again at accept time) under the project row lock:

- if the file at the current head still has `base_sha256` (or is still absent, for a new file),
  the server writes a new commit whose tree is the head tree with that one file replaced or added
  (CM1 snapshot, blob copied into the project prefix, hashes verified), `author_kind user` (the
  member who accepted), `thread_id`, `run_id`, message = the proposal's `reason` (editable in the
  card before Accept, Q6), and answers `committed { seq }`; audited `project.committed` with
  `source: "proposal"`;
- if the file changed since the proposal, **409 `proposal_stale`** with the head's `seq`; the card
  says "This file changed after the agent proposed the edit. Ask it to propose again." Nothing is
  written;
- every mounted member is reconciled to the new head (CM5 Commit); a member with a checkout of the
  project gets the change on their next **Update** (CM5 rules: untouched files take the head,
  edited ones keep a `.conflict-` copy).

No checkout is needed and none is created. Accept needs no extra policy rule or signed approval:
the member's click on a proposal they can see the diff of is the decision, recorded with the
commit (PE6).

**PE5. Reject and expiry.** Reject is as today (the event is closed, nothing written). A proposal
whose run's conversation moved to another project, or whose member lost edit access, can no longer
be accepted (409 `proposal_not_allowed` with the reason).

**PE6. Security.** The accept route checks, inside `withTeam()`: the caller owns the thread, the
proposal belongs to that thread and is open, the thread is in the project, the caller's effective
role is editor or above now, the proposal's content hash matches the recorded event (no client
content is accepted: the server commits exactly the recorded bytes). One accept per proposal
(idempotent on `proposal_id`). Shared readers of the thread never see Accept (owner only, as
today). Legal holds do not block commits (only pruning, GV3).

**PE7. The agent's view.** The project access line (CM6) adds, for `write`: "To change a project
file, call propose_file_edit; the member accepts it and that commits it." `commit_project` stays
for working in a checkout.

## 7. Security and governance

No new tenant tables; the accept route and the proposal fields live in team tables already under
RLS (`run_events`, `project_commits`, `project_tree_entries`). The listing (FP1) returns only what
`GET /v1/projects` returns to the caller today; restricted projects stay invisible to non-members
(404). The probe suite covers the new route's queries.

## 8. Tests

- Web unit: header text and project control (select, switch, remove, New conversation clears),
  title format and menus, Files list greyed/active/dot states and accessible names, proposal card
  for project files (Accept → commit, stale, not allowed).
- Server: accept route (role at accept time, stale base, new file, limits, idempotency, audit
  row, reconcile), proposal checks for project paths (reader refused, other project refused).
- Browser spec on gate1 (`projects-in-conversations.spec.ts`): owner drafts a new conversation in a
  project, switches project, removes it, sends; title shows "Project / name"; Files shows every
  project with the active dot; the agent proposes an edit to a project file; Accept; History shows
  the commit; member2 (reader) gets the refusal.

## 9. Questions for Chris

1. **Admins and restricted projects (FP1).** Should team admins see every project of the workspace
   in the Files list, including restricted projects they are not a member of? Proposal: no, only
   on the All projects page, so the list matches what an admin actually works in.
2. **Project control on a plain new conversation (NC2).** Show it on every new conversation as
   "Add to a project"? Proposal: yes.
3. **Moving after the start (TT3).** Offer Move to project… and Move out of the project from the
   title's project menu? Proposal: yes (same rules as the thread menu).
4. **Browsing a greyed project (FP4).** Expand an unmounted project to its files read-only without
   mounting it? Proposal: yes.
5. **Which projects can be edited by proposal (PE2).** Only the conversation's own project?
   Proposal: yes; other mounted projects stay read-only to the agent.
6. **Commit message (PE4).** The agent's reason, editable in the card before Accept? Proposal: yes,
   prefilled and editable.
7. **New files (PE2).** May the agent propose a new file in the project? Proposal: yes.
8. **The privacy sentence (NC1).** Keep "It stays private until you share it." somewhere?
   Proposal: in the project control's tooltip and menu header.

## 10. Implementation tickets (proposed; filed after §9 is answered)

| Id   | Scope                                                                                                                                     | Areas                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| PC-1 | New conversation header: title, project control (switch, remove, add), NC4 draft lifetime, NC5 errors                                     | web                             |
| PC-2 | Conversation title "Project / name", project menu (Open project, Move to project…), tab title                                             | web                             |
| PC-3 | Files panel: all viewable projects, active dot, greyed rows, read-only browse of unmounted projects, scale and filter                     | web                             |
| PC-4 | Proposals for project files: protocol fields, server checks in `file-edit-propose.ts`, accept-commits route, audit, reconcile, agent line | protocol, server, sandbox-agent |
| PC-5 | Proposal card for project files: project label, diff vs head, editable message, Accept commits, stale and not-allowed states              | web                             |
| PC-6 | Browser spec, docs (`docs/files.md`, user help), gate                                                                                     | e2e, docs                       |

Order: PC-1 → PC-2 → PC-3 (web only, can run in parallel with PC-4), PC-4 → PC-5, then PC-6 and a
gate1 deploy.

## 11. Out of scope

- More than one project per conversation (SS2 stands).
- Mounting a project for its creator at once and promoting a folder to a project (KOBE-586). FP1
  makes a new, empty project visible in the panel (greyed) even before it is mounted, which covers
  the visibility half of KOBE-586's "mount on create".
- Server-pushed Files panel refresh (separate item).
- Multi-file proposals and proposals that delete or rename files.
