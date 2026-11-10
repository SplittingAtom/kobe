# Kobe — Projects in conversations (Workspaces follow-up)

Status: **in progress** (§11: every question answered by Chris on 2026-11-09; tickets KOBE-587..593
and KOBE-586, gate KOBE-594, filed 2026-11-09).
Requested by Chris, 2026-11-09; items marked _(Chris)_ are his, the rest are proposals within them. Written against main `3a893e08` (gate1
`local-3a893e08156a`), on top of [`workspaces.md`](workspaces.md) (gate KOBE-583). Tickets in §12.

Request (Chris, 2026-11-09): when a new conversation starts with a project selected, the top of the
conversation pane says **New conversation in &lt;ProjectName&gt;**, with an icon to unmount the
project or switch to a different one. Once the conversation starts, its name area says
**&lt;ProjectName&gt; / &lt;conversation name&gt;**. In the Files panel, **every project of the
workspace shows under Projects**; projects not in the current conversation are greyed out, and the
project in the current conversation is not greyed and has a **green dot** to show it is active. A
member whose role lets them edit a project can have an **agent propose edits** to a file in the
project, and accepting a proposal **commits** it. Answers to the questions (2026-11-09): every
member of a workspace reads every project, so the **restricted** option is removed; until the
conversation starts the member picks its project; agents propose edits to the conversation's
project **and to the member's My files**. Chris then folded **KOBE-586** (promote a My files folder
to a project) into this work (§8).

## 1. Summary

| Area                    | Change                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New conversation header | "New conversation in &lt;Project&gt;" plus a project control (switch, remove) in place of the `DraftProjectNote` banner                                                          |
| Conversation title      | "&lt;Project&gt; / &lt;conversation name&gt;" for a conversation in a project; the slash is the separator _(Chris)_                                                              |
| Files panel, Projects   | Every project the member may view; greyed unless it is the current conversation's; the current one has a green dot; role chip and "editing" mark stay                            |
| Agent edits             | `propose_file_edit` accepts files of the conversation's project when the member can edit it; **Accept commits** the change as a new project commit _(Chris)_, no checkout needed |
| Visibility              | **Restricted projects are removed** _(Chris)_: every workspace member is at least a reader of every project; existing restricted projects become workspace-visible (§7)          |
| Promote a folder        | KOBE-586 joins this work _(Chris)_: ⋯ → Promote to project… on a My files folder moves it into a new project as one commit and mounts it for the creator (§8)                    |
| Mounting                | Unchanged (workspaces MT1): a project mounts when the member has a conversation in it or a checkout; listing a project in the panel does not mount it                            |

Nothing here changes team or project roles (workspaces PR1, PR3–PR6), the commit model
(CM1–CM10) or the one-project-per-conversation rule (SS2). It **replaces workspaces PR2** (the
`restricted` visibility, §7).

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
share it.") moves to the project control's tooltip _(Chris)_.

**NC2. Project control.** An icon button next to the title (`FolderKanban`-style project icon,
command `draft-project`, label "Project for this conversation") opens a menu _(Chris: unmount or
switch)_:

- every project of the workspace that is not archived (every member reads and so converses in
  every project, §7 and workspace PR3), the selected one checked, filtered by typing when there are
  more than 8;
- **Remove project** (when one is selected): the conversation will be a My files conversation.

Shown on every new conversation until it starts, including one with no project (then it reads
"Add to a project") _(Chris: until the conversation starts the member can pick its project)_. Read-only and keyboard reachable like the other header actions; the command is in the
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
including "Move out of the project" _(Chris)_. Shared readers and Trash see the title without menus.

**TT4. Elsewhere.** The browser tab title follows TT1. The Threads panel keeps project groups as
today (the project is already the group header there, so rows keep the bare name).

## 5. Files panel: all projects, current one active

**FP1. List.** Projects lists **every project of the active workspace** that is not archived,
sorted by name, with the current conversation's project first _(Chris: all projects show; every
member reads every project, §7)_. Members and team admins see the same list. "All projects (N) →" becomes "Manage projects →" (the page stays for
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
(`GET /v1/projects/{id}/files`, readers) without mounting _(Chris)_. Its menu: **New conversation in
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

**PE2. Which files.** _(Chris)_ Two places:

- the **conversation's own project**: paths under `/workspace/projects/<slug>/`, existing files
  and new files, within the project path rules, `PROJECT_FILES_MAX` and `PROJECT_FILE_MAX_BYTES`;
  accepting commits (PE4);
- the member's **My files** (their scratchspace outside `projects/` and `uploads/`), as
  `propose_file_edit` does today, extended to new files; accepting writes the file there (the
  existing accept path, FE8), no commit.

Other projects' paths keep the read-only refusal, and so do thread uploads.

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
  card before Accept _(Chris)_), and answers `committed { seq }`; audited `project.committed` with
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
for working in a checkout. The tool description says it works for the member's own files and the
conversation's project.

## 7. Every member reads every project

_(Chris, 2026-11-09: "All members of a Workspace have at least read access to a project.")_ This
replaces workspaces PR2's `restricted` option.

**RV1. Rule.** Every member of a workspace is at least a **reader** of every project in it.
Explicit rows name **owners and editors** only; the effective role is the explicit row, else
reader (workspaces PR3 without the visibility branch). Team admins act as owners as today.

**RV2. Migration.** One migration: every `restricted` project becomes readable by all (the
`visibility` column is dropped with its check), explicit `reader` rows are deleted (they no longer
change anything) and `project_members.role` is checked `IN ('owner','editor')`. Before it runs on
a site, a dry-run lists the restricted projects and their members so an admin sees what becomes
visible; on gate1 the list goes in the gate doc. The upgrade test proves it on a populated
database (restricted project with readers and editors → readable by all, readers gone, editors
kept), FORCE RLS kept, probe suite green.

**RV3. API and web.** `visibility` leaves the project create, update and read shapes;
`POST /members` and `PATCH /members/{user}` accept `owner | editor`; the visibility control, its
"Restricted" badge and the reader option in the members dialog go from the project page.
`project.visibility_changed` is no longer written (existing audit rows stay; the audit log doc
marks it retired). Checks that returned 404 for a restricted project now return the project to
every member. `workspaces.spec.ts` changes its restricted-project scenario to a project where
member2 is a reader by default.

**RV4. What it means.** Nothing in a project is hidden from a workspace member any more:
confidential work belongs in a separate workspace (the tenant boundary, workspaces WS1) or in a
member's My files. The help text says so where projects are created.

## 8. Promote a My files folder to a project (KOBE-586)

_(Chris, 2026-11-09: KOBE-586 is part of this work.)_ Its decisions of 2026-11-09 stand, with the
visibility choice gone (§7):

**PF1. Entry.** A folder row under **My files** (not `uploads/`, not under Projects) gets
**Promote to project…** in its ⋯ menu, for team admins and contributors (`team.projects.create`,
workspaces PR4); hidden for members.

**PF2. Dialog.** One field: the project **name**, prefilled with the folder's name. Description,
instructions, default agent and members are set later on the project page. Errors show in the
dialog.

**PF3. Move, atomically.** `POST /v1/projects/from-folder { path, name }` (strict schema): creates
the project (caller = owner), writes **one** commit "Imported from My files/&lt;path&gt;"
(`author_kind user`, sub-folders kept as paths, blobs copied server-side and verified), then removes
the folder from the member's My files (the same path as Delete) and **mounts the project for the
creator**. On any failure before the commit exists nothing changes; My files is only touched after
the project and its commit exist.

**PF4. Limits, refused up front.** `PROJECT_FILES_MAX` (500), `PROJECT_FILE_MAX_BYTES`, the team
object and byte budget (GV2), internal paths (`.kobe/`), names the project path rules refuse, and an
empty folder ("This folder is empty; create the project from Projects instead").

**PF5. Mount on create.** A project created from the Projects page also mounts for its creator at
once (KOBE-586 option 1), so a new project is never empty in the creator's Files panel; with FP1 it
is listed for everyone else (greyed) and mounts for them per MT1. _(KOBE-586, as built: the
creator keeps the mount while they have no thread of their own in the project, in Trash or not;
their first conversation hands it to the MT1 thread rule. Such a creator mount neither counts
toward nor exempts from the mount cap, MT3. No migration: `projects.created_by` decides.)_

**PF6. After.** The Files tree reloads, reveals the new project under Projects and, when the
current conversation is a new one with no project, offers it in the project control (NC2). Audit:
`project.created` and `project.committed` (plus the workspace delete rows as today).

## 9. Security and governance

No new tenant tables; the accept route and the proposal fields live in team tables already under
RLS (`run_events`, `project_commits`, `project_tree_entries`). The listing (FP1) returns only what
`GET /v1/projects` returns, which after RV1 is every project of the caller's workspace; other
workspaces' projects stay invisible (RLS, 404). The probe suite covers the new route's queries and
the RV2 migration. The promote route runs inside `withTeam()` on the caller's own workspace rows
only (the path is resolved against their manifest, never a path from another member).

## 10. Tests

- Web unit: header text and project control (select, switch, remove, New conversation clears),
  title format and menus, Files list greyed/active/dot states and accessible names, proposal card
  for project files (Accept → commit, stale, not allowed).
- Server: accept route (role at accept time, stale base, new file, limits, idempotency, audit
  row, reconcile), proposal checks for project paths (reader refused, other project refused), My files proposals for new files; the RV2 upgrade test
  and the RV3 route shapes; the promote route (permission matrix, limits, failure leaves My files
  intact, one commit, mount for the creator) and mount on create.
- Browser spec on gate1 (`projects-in-conversations.spec.ts`): owner drafts a new conversation in a
  project, switches project, removes it, sends; title shows "Project / name"; Files shows every
  project with the active dot; the agent proposes an edit to a project file; Accept; History shows
  the commit; a My files folder is promoted to a project and shows under Projects; member2 (a reader by default, RV1) sees every project and gets the refusal.

## 11. Decisions (Chris, 2026-11-09)

1. **Every workspace member reads every project**, so the restricted option is removed (§7).
2. **The project control shows on every new conversation until it starts**, including as
   "Add to a project" (NC2).
3. **Move to project… and Move out of the project from the title's project menu**: yes (TT3).
4. **Browse a greyed project's files read-only without mounting**: yes (FP4).
5. **Proposals go to the conversation's own project and to the member's My files** (PE2).
6. **The commit message is the agent's reason, editable before Accept** (PE4).
7. **New files may be proposed** (PE2).
8. **The privacy sentence goes in the project control's tooltip** (NC1).
9. **KOBE-586 (promote a folder) is part of this work**, without the visibility choice (§8).

## 12. Implementation tickets (filed 2026-11-09; gate KOBE-594)

| Id            | Scope                                                                                                                                                            | Areas                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| PC-1 KOBE-588 | New conversation header: title, project control (switch, remove, add), NC4 draft lifetime, NC5 errors                                                            | web                             |
| PC-2 KOBE-589 | Conversation title "Project / name", project menu (Open project, Move to project…), tab title                                                                    | web                             |
| PC-3 KOBE-590 | Files panel: all viewable projects, active dot, greyed rows, read-only browse of unmounted projects, scale and filter                                            | web                             |
| PC-0 KOBE-587 | Remove restricted visibility: RV2 migration with dry-run list, upgrade test, RV3 API, project page and members dialog, audit doc, `workspaces.spec.ts`           | db, protocol, server, web, e2e  |
| KOBE-586      | Promote a My files folder to a project (PF1-PF6), mount on create (PF5)                                                                                          | server, protocol, web           |
| PC-4 KOBE-591 | Proposals for project files and new My files files: protocol fields, server checks in `file-edit-propose.ts`, accept-commits route, audit, reconcile, agent line | protocol, server, sandbox-agent |
| PC-5 KOBE-592 | Proposal card for project files: project label, diff vs head, editable message, Accept commits, stale and not-allowed states                                     | web                             |
| PC-6 KOBE-593 | Browser spec, docs (`docs/files.md`, user help), gate                                                                                                            | e2e, docs                       |

Order: PC-0 first (it changes the list rules the others read), then KOBE-586 and PC-1 → PC-2 → PC-3 (web) in
parallel with PC-4 → PC-5, then PC-6 and a gate1 deploy.

## 13. Out of scope

- More than one project per conversation (SS2 stands).
- Server-pushed Files panel refresh (separate item).
- Multi-file proposals and proposals that delete or rename files.
