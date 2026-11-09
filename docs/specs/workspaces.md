# Kobe — Workspaces (Team, Scratchspace, Projects)

Status: **shipped pending gate** (2026-11-09: KOBE-576..582 merged, gate1 reinstalled fresh; evidence in
[`docs/gates/gate-workspaces.md`](../gates/gate-workspaces.md), gate KOBE-583). Decisions by Chris, 2026-11-08 (§14: every question answered; items marked _(Chris)_
are his, the rest are proposals within them). Written against main `71443152`. Hadron spec
`b1e23088-8dcd-41fa-bee5-4335b9d82e0b`; tickets filed 2026-11-08: WS-1 KOBE-576, WS-2 KOBE-577,
WS-3 KOBE-578, WS-4 KOBE-579, WS-5 KOBE-580, WS-6 KOBE-581, WS-7 KOBE-582 (§15).

Request (Chris, 2026-11-08): put the whole concept under one name, **Workspaces**. A Workspace
holds a **Team** (everything a team is today), each member's **Scratchspace** (what the code calls
the workspace today: the member's own `/workspace` volume and its synced copy) and the
**Projects** (what projects are today). The Files panel shows the Workspace, with a Projects
section and a section for the member's scratchspace. A member's ordinary conversations are tied to
their scratchspace. Members create projects, upload files and code to them, and the creator
becomes the project's owner and adds people. Every member of the workspace can at least read a
project; owners and editors start conversations on it, edit its files and **commit** changes
back. Goal: a more flexible base for building data products, a better place to collaborate, and
something system admins can govern.

## 1. Summary

Nothing about the tenant boundary changes: a **Workspace is one team**, the same row, namespace
and row-level-security context as today, viewed as the place where a team works. The spec renames
in the product (switcher, consoles, Files panel, API docs) and leaves the internal identifiers,
the `/workspace` mount path and the S3 key layout alone (WS3).

The **Scratchspace** is the member's own volume in the workspace, today's "workspace": synced,
browsable, with the free area, `uploads/` and the project mounts. A conversation without a project
is a scratchspace conversation. Every conversation, project or not, runs in the member's own
sandbox on that volume; projects never get a sandbox of their own (WS4).

**Projects** gain three things. (1) A **visibility**: `workspace`, where every member of the
workspace is a reader, or `restricted`, where only listed people are (PR2). (2) A third role:
**owner**, **editor**, **reader**. Readers browse the files, read shared conversations and project
memory, and start conversations on the project; editors also edit and commit; owners also manage
the project and its people; team admins can do all of it in every project of their workspace
(PR1, PR3). (3) **Versioned commits**: a project's files form a tree with a history of commits.
An editor checks the project out into their scratchspace, which makes the mounted folder
writable; a commit is a server-side diff of that working copy against the version it was checked
out at, applied to the head only when the head has not moved, with Update and Discard for the
other cases. A person commits from the editor or the Files panel; the agent commits through a
tool call the server decides, with a signed approval like every project write today (CM1–CM9).
Git-backed projects come in a later phase (CM10).

A project is mounted into a member's scratchspace **only while they have a conversation in it**
or a checkout of it, not for every readable project (MT1). The Files panel becomes a tree:
Workspace → Projects (mounted ones, plus a link to all) and Scratchspace (uploads and the free
area) (FP1). The team role **builder is renamed contributor**; team admins and contributors create
projects (PR4). The last team admin of a workspace cannot be removed, as today (GV1).

## 2. Where this sits among the Kobe decisions

| Decision                             | How this spec relates to it                                                                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D5** Tenancy                       | Unchanged. Workspace = team: every new table is a team table (`team_id NOT NULL`, RLS, probe fixtures). No table spans workspaces.                                                     |
| **D8** Fixed roles                   | The team role `builder` is renamed `contributor` (same rank, same permissions). Project roles gain `reader` and `editor` replaces `member`. No custom roles.                           |
| **D9** One active team               | The switcher becomes the workspace switcher; one active workspace per session, the `x-kobe-team` header and the `team_mismatch` guard stay as they are.                                |
| **D11** One sandbox per (team, user) | Unchanged and restated: the scratchspace is that sandbox's volume; project conversations run there. No shared project sandboxes.                                                       |
| **D12** Offboarding                  | Unchanged. A removed member's checkouts are discarded and their mounts go (MT4).                                                                                                       |
| **D13** Workspace sync               | Extended: a checked-out project folder is pushable by the sandbox (CM4); the server-owned rule stays for everything else.                                                              |
| **D18** Retention, legal hold        | Commit history is team content under hold; the hold guard covers the new tables. A workspace setting bounds history (GV3).                                                             |
| **D23** Projects                     | Extended: visibility, three roles, commits, mount-on-conversation. One project per thread stays (Chris). Sharing a thread to the project and forking stay as they are.                 |
| **D24** Memory                       | Project memory is readable by every reader of the project; the agent writes it only in an editor's or owner's conversation (PR6).                                                      |
| **D26** Quotas                       | Project files and history count against the team storage quota, attributed to the project, not to the committer's scratchspace; storage is also counted and budgeted in objects (GV2). |
| **D31** Audit                        | New team events for visibility, role, checkout, commit, revert, discard and ownership transfer (GV4).                                                                                  |
| **D32** Runs that never wait         | Unchanged: an agent commit in an `auto` or scheduled run is refused and recorded as a skipped action, as `propose_project_file` is today.                                              |
| **FE1–FE4** File editor              | The editor's save route is reused inside a checkout (CM3). FE2's "project mounts stay read-only" becomes "read-only unless checked out by this member".                                |

## 3. Today (what the code does, verified 2026-11-08)

- **Team.** Site-wide `teams` row (slug names the namespace `kobe-team-<slug>`); `team_members`
  with `team_role` enum `team_admin | builder | member`; the permission matrix in
  `services/server/src/authz/permissions.ts` (`team.projects.create` needs `builder`). The active
  team hangs off the session (`session_active_teams`), `requireTeam` re-verifies membership per
  request. A team is created with its first admin in one transaction; `last_team_admin` refuses
  removing the last admin (`teams/members.ts`).
- **Workspace (the volume).** One sandbox per (team, user) in the team namespace, PVC
  `workspace-u-<user>`; `sandboxes` row (running / hibernated / destroyed). Durable copy:
  `workspace_sync` (head revision, totals), `workspace_files` (one row per path, tombstones,
  `origin sandbox|server`), `workspace_blobs`; S3 keys `teams/<t>/users/<u>/workspace/<sha256>`.
  The sandbox agent restores, pulls and pushes (`services/sandbox-agent/src/workspace/sync.ts`).
  Areas: free area, `uploads/` (server-owned, member drop folder excepted), `projects/`
  (server-owned, read-only by uid: files `0444`, dirs `0555`, KOBE-162). The Files tab of the rail
  browses the manifest (`workspace-files/browse.ts`, `components/files/file-browser.tsx`); the
  editor saves with `PUT /v1/workspace/file?path=&base_sha256=` (FE4) in the free area only.
- **Projects.** `projects` (slug, name, description, instructions ≤ 8 KiB, `default_agent_id`,
  `members_mode team|selected`, `archived_at`), `project_members` (`owner|member`),
  `project_files` (head only, no history; blob `teams/<t>/projects/<p>/files/<id>`). Permissions
  `projectPermissions(teamRole, projectRole)` in `packages/protocol/src/projects.ts`. Threads:
  `threads.project_id` (RESTRICT), `shared_to_project`, `shared_to_team`. Memory scope
  `project`. Mounts: `projects/mounts.ts` makes each member's `projects/` area equal to the files
  of **every** project they are a member of, at every run start. The only sandbox-side write is
  `propose_project_file` (push-then-propose, signed approval, `approvals/server-write.ts`).
  Audit: `project.created|updated|deleted|member_added|member_removed|member_role_changed|file_added|file_removed`.
- **Web.** `/me/projects` list and detail (form, members, files, conversations); the Threads panel
  groups threads under their project and supports drag onto a project header; `ProjectPicker`
  chooses whose memory to open; the rail has Files | Apps tabs (KOBE-448).

## 4. The model and its names

**WS1. Four nouns.** _(Chris)_

| Name             | What it is                                                                                                                                                        | In the code today                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **Workspace**    | The place a team works in and the tenant boundary: one row, one Kubernetes namespace, one RLS context. A member may belong to several; one is active per session. | `teams` row, `kobe-team-<slug>`, `kobe.team_id` |
| **Team**         | The people in the workspace and their roles, invitations and the governance settings an admin runs the place with.                                                | `team_members`, team consoles                   |
| **Scratchspace** | One member's own volume in the workspace: their sandbox's `/workspace`, its synced copy, their uploads and the project mounts. Private to the member.             | "workspace" (sync, files, browser)              |
| **Project**      | A shared unit of work inside the workspace: instructions, a versioned file tree, project memory, conversations, people and roles.                                 | `projects` and friends                          |

**WS2. Workspace is 1:1 with the team row.** No new table, id or namespace. "Workspace" and
"team" are the same object; the product says Workspace for the place and Team for the people. The
API keeps `/v1/team`, `/v1/me/teams` and `x-kobe-team`; the API reference gets a glossary line.
Permission names stay `team.*` (renaming them buys nothing and breaks nothing).

**WS3. Internal identifiers do not move.** The sandbox mount stays `/workspace` (Pi, skills,
tool docs and the agent prompt name it); S3 keys keep `users/<u>/workspace/`; tables keep their
names; protocol types keep theirs. Product strings, API documentation and this spec say
Scratchspace. Code identifiers follow when files are touched for other reasons, never in a rename
sweep.

**WS4. The scratchspace is the runtime for everything.** A project conversation runs in the
member's own sandbox, with the project mounted (read-only, or writable while checked out). There
are no project sandboxes, no shared volumes, no second RuntimeClass path. _(Chris; D11.)_

**WS5. Product strings.** The switcher is "Workspace" (name, role chip); the team console keeps
"Team" for Members, Invitations and Roles and says "Workspace settings" for models, budgets,
connectors, policy, egress, retention and memory switches (they are about the place); the Files
panel labels the member's scratchspace **"My files"** _(Chris)_, and "Scratchspace" stays the
name of the concept in this spec, the API reference and the help text; `/me/projects` stays
"Projects".

## 5. Roles

**PR1. Team roles.** `team_admin` > `contributor` > `member`. `contributor` is today's `builder`
renamed: same rank, same permissions (`team.agents.build`, `team.agents.publish`,
`team.skills.publish`, `team.projects.create`). Enum value renamed in place (MG1). _(Chris)_

**PR2. Project visibility.** `visibility: "workspace" | "restricted"` replaces `members_mode`.
`workspace`: every member of the workspace is an implicit **reader**; explicit rows name owners and
editors (and may name readers, which then changes nothing until the project is restricted).
`restricted`: only explicit rows (owners, editors, readers) may see the project; to everyone else
it does not exist (404, as today). Team admins see every project of their workspace in both
modes. Default on create: `workspace`. _(Chris agreed to keeping a restricted option.)_

**PR3. Project roles and the matrix.** `owner` > `editor` > `reader`. Effective role = explicit
row, else `reader` when visibility is `workspace`, else none. Team admins act as owners of every
project without being listed (`my_role` null, as today).

| Action                                                                    | reader | editor | owner | team admin |
| ------------------------------------------------------------------------- | :----: | :----: | :---: | :--------: |
| View the project, browse files, read history, download                    |   ✓    |   ✓    |   ✓   |     ✓      |
| Read conversations shared to the project; fork them                       |   ✓    |   ✓    |   ✓   |     ✓      |
| Start a conversation on the project (instructions apply, mount read-only) |   ✓    |   ✓    |   ✓   |     ✓      |
| Share own project conversation to the project / team                      |   ✓    |   ✓    |   ✓   |     ✓      |
| Read project memory (the agent reads it in their conversations)           |   ✓    |   ✓    |   ✓   |     ✓      |
| Check out, edit, commit, update, discard; upload and remove files         |        |   ✓    |   ✓   |     ✓      |
| Agent writes project memory in their conversations (with approval)        |        |   ✓    |   ✓   |     ✓      |
| Revert a commit                                                           |        |   ✓    |   ✓   |     ✓      |
| Edit name, description, instructions, default agent; archive; unarchive   |        |        |   ✓   |     ✓      |
| Change visibility; add, remove, re-role members; transfer ownership       |        |        |   ✓   |     ✓      |
| Delete the project (refused while threads or memory point at it)          |        |        |   ✓   |     ✓      |
| Create a project (needs team role contributor or team admin)              |        |        |       |            |

_(Chris: readers start conversations but cannot save or edit.)_ The sandbox learns the viewer's
access with the run (`run.start.project.access: "read" | "write"`, CM6), so the agent can say
"you can read this project but not change it" instead of failing a commit.

**PR4. Who creates.** Team admins and contributors; members do not. The creator becomes `owner`.
No workspace setting for this in this spec (listed in §16 as a possible later knob). _(Chris)_

**PR5. Owners.** At least one owner per project ("last owner stays", as today). A team admin may
transfer ownership (`POST /v1/projects/{id}/owner {user_id}`) at any time, audited; an owner may
hand over to another member likewise. When a member who is the only owner leaves the workspace, the
project keeps running (team admins manage it) and the Projects page shows it to team admins as
"No owner: assign one". The workspace itself always has a team admin: removing the last one is
refused as today (GV1). _(Chris)_

**PR6. Memory.** Project memory is read in every project conversation. The agent's writes to it
(`remember` into the project scope, the memory panel for the project) require `editor` or above;
in a reader's conversation project `remember` is refused with a plain reason and personal memory
still works. The existing signed-approval rule for project memory writes stays.

## 6. Scratchspace and conversations

**SS1. Scratchspace = today's workspace, renamed in the product.** Same sandbox, same PVC, same
sync, same quota, same hibernation, same offboarding. The free area and `uploads/` are the
member's; `projects/` is the server's except inside a checkout (CM4).

**SS2. A conversation without a project is a scratchspace conversation.** Nothing new is stored:
`threads.project_id IS NULL`. The Threads panel's "Your threads" group keeps its label. Moving
a thread into a project (`POST /v1/threads/{id}/move`) and out stays as it
is, under the same checks (the mover must be able to converse in the target, PR3). _(Chris: one
project per conversation.)_

**SS3. Uploads belong to the scratchspace.** Thread attachments (`uploads/<thread>/`) and the
drop folder (`uploads/`) show under "My files" in the Files panel (FP1) and are not part of any
project. Putting an upload into a project is a copy into the checkout (Files panel "Copy to
project…" on a file, editor only) followed by a commit.

## 7. Projects: visibility and people

**PJ1. Columns.** `projects.visibility text NOT NULL DEFAULT 'workspace'` (check
`IN ('workspace','restricted')`) replaces `members_mode` (MG2). `project_members.role` gains
`'reader'` (check `IN ('owner','editor','reader')`). Everything else stays.

**PJ2. Routes.** Existing routes keep their shapes with `visibility` and `my_role` extended;
`members` lists all explicit rows; `POST /members` accepts `role: owner|editor|reader`;
`PATCH /members/{user}` re-roles; the owner transfer route (PR5). `GET /v1/projects` lists what
the caller may view (readers included), `?role=editor` narrows to projects the caller may edit (the
checkout picker uses it).

**PJ3. Leaving the workspace.** Removing a member ends their checkouts (discard, CM5), removes
their explicit project rows, unmounts (MT4), pauses their schedules and ends their shares as today.
Their project threads stay (authors' content, as today) and stop receiving instructions.

## 8. Commits

**CM1. A project's files are a tree with a history.** New team tables:

- `project_commits (team_id, id, project_id, seq, parent_id, author_user_id, author_kind user|agent,
thread_id null, run_id null, message, file_count, bytes, created_at)`; `seq` is 1, 2, 3… per
  project, unique, assigned under the project row lock; `parent_id` is the previous head (null for
  the first). `message` ≤ 500 chars.
- `project_tree_entries (team_id, commit_id, path, sha256, blob_ref, size_bytes, mime_type,
executable)`: the **whole tree at that commit** (a snapshot, not a delta). With at most
  `PROJECT_FILES_MAX` (500) files per project a snapshot is cheap and makes "the tree at the base
  commit" one query.
- `projects.head_commit_id` (null for a project with no commit yet).
- `project_checkouts (team_id, project_id, user_id, base_commit_id, created_at, updated_at)`,
  one per (project, member).

`project_files` stays as the **head tree** (what mounts, downloads and the API read) and is
rewritten by every commit. Blobs stay content-addressed under the project's prefix
(`teams/<t>/projects/<p>/blobs/<sha256>`, new; existing `files/<id>` keys keep working) and are
shared between commits, so history costs rows, not bytes, until a file changes. The first
migration writes commit 1 for every project with files from its current `project_files` (MG4).

**CM2. Checkout.** `POST /v1/projects/{id}/checkout` (editor+): writes the checkout row with
`base_commit_id = head`, mounts the project if it is not (MT1), and the member's `projects/<slug>/`
folder becomes **writable**: the manifest rows keep pointing at the project's blobs (nothing is
copied), the sync pull answers with the member's checkouts (CM4) and the sandbox agent makes the
folder tree group-writable (`0664`/`0775`, like the free area) instead of locking it. One checkout
per member per project; a second call is idempotent. A checkout survives hibernation and sign-out.

**CM3. Editing inside a checkout.** Three ways, all producing ordinary manifest rows under
`projects/<slug>/`:

- the agent and its tools write files in the sandbox and the sandbox pushes them (CM4);
- the web editor saves with the existing `PUT /v1/workspace/file?path=&base_sha256=` (FE4), which
  now accepts a path inside the member's own checkout;
- the Files panel uploads, renames, moves and deletes inside the checkout (the existing routes,
  same relaxation).

The read-only check (`workspace-files/paths.ts isReadOnlyPath`) becomes "server-owned and not inside
one of the caller's checkouts". Mount reconcile (MT1) skips checked-out projects for that member, so
nothing overwrites a working copy.

**CM4. Sync protocol.** The pull response gains `checkouts: [{ project_id, slug, base_commit_seq }]`.
The push route accepts `projects/<slug>/…` paths only while the caller's (team, user) has a
checkout of that slug; otherwise `read_only` as today. The sandbox agent treats a checked-out slug
as part of the free area for scanning, pushing and permissions, and relocks it when the checkout
ends (next pull without the slug: `lockServerOwned`, then the restore rule replaces local files with
the head). `WORKSPACE_SERVER_OWNED_PREFIXES` is unchanged; the exception is per checkout.

**CM5. Commit, Update, Discard.**

- **Commit** `POST /v1/projects/{id}/commit { message }` (editor+). Under the project row lock and
  the member's workspace lock: the server lists the member's live rows under `projects/<slug>/`,
  diffs them against `project_tree_entries` of the checkout's base; an empty diff answers 200
  `nothing_to_commit`. If `head_commit_id ≠ base_commit_id` → **409 `commit_conflict`** with the
  head's `seq` (the member runs Update first). Otherwise: copy any blob the project does not hold
  yet from the member's workspace prefix to the project prefix (server-side copy, hashes verified),
  write the new commit and its full tree, rewrite `project_files`, move the checkout's base to the
  new commit, audit `project.committed`, and reconcile every other mounted member (MT1) so they see
  the new head. Limits: `PROJECT_FILES_MAX`, `PROJECT_FILE_MAX_BYTES`, the team storage quota
  (GV2). Paths follow the project file path rules; a `.conflict-` file is refused with a message
  naming it.
- **Update** `POST /v1/projects/{id}/checkout/update`: brings the head's changes into the working
  copy. For each path changed between base and head: if the member did not touch it, the working
  copy takes the head's version (a server write, origin `server`); if both changed it, the head's
  version takes the path and the member's edit is kept beside it as `<name>.conflict-<time><ext>`
  (the existing D13 rule), and the response lists those paths. The base moves to the head. The
  sandbox pulls the result as ordinary changes.
- **Discard** `DELETE /v1/projects/{id}/checkout`: ends the checkout; the mount is reconciled back
  to the head (every row under `projects/<slug>/` is replaced or removed), the folder relocks. If
  no conversation keeps the project mounted (MT1) the mount goes with it. The web asks for
  confirmation when the diff is non-empty.

**CM6. The agent's commit.** New kobe-tools call `commit_project { message }` (capability
`projects`), only registered when `run.start.project.access` is `write`. Path: kobe-policy
`policy.check` (a project write, so a policy rule or a signed approval is required, like
`propose_project_file`) → kobe-tools `project.commit` on fd 4 → frame `project.commit` → server.
The sandbox first **pushes** (so the manifest holds the working copy), then sends the call; the
server runs CM5 Commit with `author_kind agent`, `thread_id`, `run_id`, and answers
`committed { seq }`, `commit_conflict { head_seq }`, `nothing_to_commit`, or `pending_approval` when
the approval is still open (the commit happens when it is granted, over the same canonical input:
project id, base seq, message, and the SHA-256 of the sorted diff, so a changed working copy
invalidates the approval). `auto` and scheduled runs: refused, skipped action recorded (D32).
`propose_project_file` is removed in WS-7 (§15) _(Chris)_: a reader who wants a file in the
project shares it to a conversation and an editor commits it; readers never had the tool.

**CM7. History and revert.** `GET /v1/projects/{id}/commits?before=` (readers) pages the history
(seq, author, message, counts, time); `GET /v1/projects/{id}/commits/{seq}` lists its tree and the
diff to its parent (added, modified, deleted, with sizes); `GET …/commits/{seq}/files/{path}`
downloads a file at that commit. `POST /v1/projects/{id}/commits/{seq}/revert` (editor+) writes a
**new** commit whose tree is the tree at `seq` (history is append-only; nothing is rewritten).
Other members' checkouts are not blocked by it: their next Update resolves the head move like any
other (CM5).

**CM8. Web.** The editor (FE) shows, on a file inside a checked-out project, the project name, a
"Changes" count and **Commit…** (message dialog) and **Update** / **Discard** in its header; a file
inside a project the member can edit but has not checked out shows **Check out to edit**. The
project page gets a **History** tab (commits, click to see the diff, download a file at a commit,
Revert) and a "Working copies" list for owners and admins (who has a checkout, since when). The
Files panel marks a checked-out project "editing" and offers Commit / Update / Discard in its menu.

**CM9. Concurrency rules in one place.** Project row lock for commit, revert, update, visibility
and member changes; the member's workspace lock for everything that writes their manifest. A commit
never blocks readers (they read `project_files`). Two editors committing: the second gets
`commit_conflict` and runs Update. Head moves reconcile other mounted members in the background
(MT1), never inside the commit transaction.

**CM10. Git later.** _(Chris)_ This spec's model (snapshot per commit, parent pointer, author,
message, content-addressed blobs) maps onto a git tree without data loss. A later phase adds a
bare repository per project as an export and sync target (push to GitHub/GitLab through the egress
proxy from the server, never from a sandbox), branches and pull requests. Nothing here presumes
it, and no project data is stored in a git format now.

Two notes for that phase. (1) `PROJECT_HISTORY_MAX_COMMITS` (GV2) is a snapshot-era limit, not a
product decision: packfiles store text history as deltas, so once code history lives in git the
cap can be raised or dropped for code. (2) Git does not change the object picture for **data
files**: large or binary files are stored whole per version in git too and would stay as
individual objects in S3, pointed at from the repository, so the object budget, the retention rule
and the legal-hold behaviour of GV2/GV3 carry over unchanged. Pruning git history means rewriting
it, which breaks clones and mirrors, so the history policy must exist before git arrives, not
after.

## 9. Mounts

**MT1. Mount on conversation or checkout.** _(Chris)_ A project is mounted into a member's
scratchspace (its head under `projects/<slug>/`, read-only) exactly while:

- the member has at least one thread in the project that is not in Trash (their own; a shared
  thread they only read does not count), or
- the member has a checkout of it (then writable, CM2).

`projects/mounts.ts desiredFor()` becomes "files of the projects in that set that the member may
view", skipping the checked-out ones (their rows are the member's). The mount appears when the
first such thread is created or moved in (the thread create and move paths call `reconcileUser`,
and run start still does), and disappears when the last such thread is trashed, the checkout is
discarded, the member loses view access or leaves the workspace (MT4). The Files panel shows a
project that is readable but not mounted as "Open to mount" (FP2).

**MT2. Readers of restricted projects.** Same rule; losing the explicit row unmounts (the existing
`reconcileUsers` on member removal) and their threads stop receiving instructions as today.

**MT3. Scale.** Mounted projects per member are now bounded by their conversations and checkouts,
not by the project count of the workspace. The manifest caps (`LIST_LIMIT` 50 000 rows,
`PROJECT_FILES_MAX` 500) are unchanged; a workspace setting `projects.max_mounted_per_member`
(default 20) refuses a new project conversation with `too_many_mounts` and a message naming the
limit.

**MT4. Leaving.** Removing a member or deactivating a user: discard their checkouts (CM5), drop
their explicit project rows, run `reconcileUser` so every `projects/` row goes. Already partly in
place (`reconcileUsers` on removal); the checkout step is new.

## 10. The Files panel

**FP1. Tree.** The rail's Files tab shows:

```
▾ Workspace: Marketing            ← the active workspace (name from the switcher)
  ▾ Projects
    ▸ budget-2027   editing ●     ← checked out: writable, menu has Commit… / Update / Discard
    ▸ onboarding-deck             ← mounted read-only (a conversation is in it)
      All projects (12) →          ← opens /me/projects; readable, unmounted projects are browsed there
  ▾ My files                      ← the member's scratchspace
    ▸ uploads                     ← thread attachments and the drop folder, as today
    ▸ analysis
      notes.md
      …
```

Projects lists the member's mounted projects by name (slug as hover text), with the role chip
(reader / editor / owner) and the editing mark; My files is today's tree minus `projects/`.
Drag-and-drop upload lands in the scratchspace drop folder as today, or into a checked-out project
folder (CM3); dropping onto a read-only project explains "Check out to edit" (editor) or "You can
read this project" (reader).

**FP2. Browsing an unmounted project.** `/me/projects/{id}` already lists a project's files; it
gains download and "Open in a conversation" (creates a project thread, which mounts it, MT1). The
panel does not list unmounted projects; the count link is enough.

**FP3. Editor.** Opening a file from Projects opens it read-only unless the project is checked out
by the member (CM8). Opening from My files is unchanged.

**FP4. Threads panel.** Groups as today ("Your threads" for the member's project-less threads,
project groups). The project header's menu gains "Check out" / "Commit…" for editors.

## 11. Governance (system and workspace admins)

**GV1. Admin floor.** _(Chris)_ A workspace always has at least one team admin; removing or
demoting the last one is refused (`last_team_admin`, today). Deactivating a user who is the last
admin of a workspace is refused with the workspace named; a site admin transfers the admin role
first (`site.users.manage` plus the existing team member routes under break-glass are not needed:
the team's own admin UI does it, or the site admin uses the invitation flow). Stated here because
the spec promises it.

**GV2. Storage: bytes and objects.** _(Chris, 2026-11-08)_ Project blobs (head and history)
count against the team storage quota (D26), attributed to the **project**, not to the committer's
scratchspace; working copies count against the member's scratchspace as any file does. A commit
that would exceed the quota is refused `quota_exceeded`.

Storage is tracked in **objects as well as bytes**: every S3 object costs the store an inode and
metadata work whatever its size (MinIO keeps at least one file per object), so object count is the
quantity that hurts a small-file-heavy workspace first. The team storage view and the project
page show, per workspace and per project, live bytes, history bytes, live objects and history
objects. Beside the byte quota a workspace gets an **object budget** (`team_storage_quotas.max_objects`,
null = the site default from a chart value, proposed 2 000 000) covering scratchspaces, uploads
and projects together; a push, an upload or a commit that would exceed it is refused
`quota_exceeded` with `limit: "objects"`, so the message can say which limit was hit.

Per-project caps stay: `PROJECT_FILES_MAX` (500) per tree and `PROJECT_FILE_MAX_BYTES` (50 MiB)
per file. New: `PROJECT_HISTORY_MAX_COMMITS` (chart value, default **1000**) is a hard cap per
project that applies even under `history_keep: all` (GV3): once a project passes it, the oldest
commits beyond the cap are pruned on the next sweep. It bounds the worst case (an agent rewriting
every file on every commit for a thousand commits leaves about half a million objects); typical
projects never reach it. The cap exists because snapshots are the storage format of this phase;
CM10 says what changes with git.

**GV3. History retention.** _(Chris, 2026-11-08)_ Workspace setting `projects.history_keep`
(team admin, in Workspace settings): **`all` (default)**, or `N commits`, or `N days`; a chart
value sets the default for new workspaces so an operator can make a whole site conservative.
Pruning runs in the retention job: it removes `project_commits` and `project_tree_entries` older
than the rule or beyond `PROJECT_HISTORY_MAX_COMMITS`, **never** the head, **never** a commit any
checkout is based on, and **never** while a legal hold covers the workspace (the hold guard refuses
the delete as it does for threads). Blobs no remaining commit or head references are queued for
the existing blob deleter (`retention_blob_deletions`) after its grace period. What pruning loses
is only the ability to view, download or revert to versions older than the rule; the current files
are untouched. Each sweep that removes something is audited (`project.history_pruned`, GV4) with
the counts.

**GV4. Audit (D31).** New team events: `project.visibility_changed`, `project.owner_transferred`,
`project.checked_out`, `project.checkout_discarded`, `project.committed` (seq, counts, author
kind, thread), `project.commit_reverted`, `project.history_pruned`; `project.member_role_changed`
carries the new role set. Rows added to `docs/audit-log.md`. Site admins see counts, never
content.

**GV5. Export.** The retention export of a workspace gains each project's head tree and its
commit list (metadata and files at head; history files on request per commit). A project owner can
download the head as a zip from the project page.

**GV6. Site boundary.** Unchanged: site admins reach workspace content only through break-glass;
usage and spend dashboards gain project counts and project storage per workspace.

## 12. Migration

**MG0. Gate1 starts fresh.** _(Chris, 2026-11-08)_ To make the lane easier, the gate1 install
is **purged and reinstalled** on the merged build: all existing teams, members, scratchspaces,
projects and their S3 objects go (after a kept `pg_dump` backup; see the lane brief). The
migrations below still exist and are tested on a populated database, because other installs
upgrade in place, but no compatibility shim is kept for a second release: `members_mode` is
dropped in the same migration that adds `visibility`, and `builder` is not accepted on input.

**MG1. Team role rename.** `ALTER TYPE team_role RENAME VALUE 'builder' TO 'contributor'`;
protocol `teamRoleSchema` says `contributor`; the web shows "Contributor". Audit rows keep their
historical value. Hadron and the docs say contributor from the merge on.

**MG2. Visibility.** `projects.visibility` = `'workspace'` where `members_mode = 'team'`,
`'restricted'` where `'selected'`; `members_mode` is dropped in the same migration (MG0).

**MG3. Project roles.** Explicit `project_members.role = 'member'` rows become `'editor'`
_(Chris)_: the people an owner listed by hand were chosen to work in the project, so they get the
new write power without a second round of invitations. The release note tells owners to demote
anyone who should only read.

**MG4. First commit.** For every project with files: one `project_commits` row (seq 1, author =
`created_by`, message "Imported", `author_kind user`) and the tree from `project_files`;
`head_commit_id` set. Projects without files get no commit (head null). Blob keys stay where they
are; new commits write under `blobs/<sha256>`.

**MG5. Mounts.** The first `reconcileUser` after an in-place upgrade applies MT1, so members lose
the mounts of projects they have no conversation in. The release note says so; nothing is deleted
from a project. (Moot on gate1, MG0.)

## 13. Security

Every new table is a team table under RLS and in the probe suite; no cross-workspace path
exists. Checkout and commit run under `withTeam()` and the two locks (CM9); the commit copies blobs
server-side from keys derived from verified ids, never from sandbox-chosen names
(`workspace-sync/keys.ts` rule), and verifies each hash. The sandbox's push into a checkout is
accepted only for the (team, user) of its session token and only for a slug that member has
checked out; the uid-based read-only rule (KOBE-162) stays in force for every other project
folder, and the agent relocks a folder the moment its checkout ends. The agent's commit is a
server-decided tool call with the same signed-approval and D32 rules as every project write;
readers' runs never register it. Visibility `restricted` answers 404 to non-members everywhere
(list, files, history, mounts, memory, shared threads). Instructions reach a run only while the
owner may still converse in the project (as today). No new secrets; S3 credentials stay in the
server.

## 14. Questions and Chris's decisions

Decided 2026-11-08 _(Chris)_: the four nouns and the umbrella (WS1); the scratchspace runs
everything (WS4); readers converse but cannot edit (PR3); restricted visibility stays (PR2);
builder → contributor, admins and contributors create (PR1, PR4); the admin floor (GV1);
Kobe-native versioned commits first, git later (CM1, CM10); mount only on conversation, kept
while a non-trashed thread or a checkout exists (MT1); one project per conversation (SS2);
project roles owner / editor / reader (PR3).

Questions raised in the draft, all answered 2026-11-08:

1. **MG3**: existing explicit members become `reader` or `editor`? _Decided: editor._
2. **CM6**: should `propose_project_file` be removed in this spec (WS-7) or kept as the reader's
   way to suggest a file? _Decided: removed_; a reader shares a file to a conversation and an
   editor commits it.
3. **GV3 defaults**: history `all` by default, prune at 1000 commits per project? _Decided: yes_,
   plus object counting and a per-workspace object budget (GV2), after the small-files discussion.
4. **MT3**: 20 mounted projects per member as the default limit? _Decided: yes._
5. **FP1**: "Scratchspace" as the visible label, or "My files"? _Decided: "My files"_ in the
   panel; Scratchspace remains the concept's name.

## 15. Implementation tickets (filed 2026-11-08 as KOBE-576..582; gate KOBE-583)

Order: WS-1 → WS-2 → WS-3 and WS-5 in parallel → WS-4 → WS-6 → WS-7. Two lanes (the cap): server
(WS-2 → WS-3 → WS-4) and sandbox/web (WS-5 → WS-6). **One gate at the end** _(Chris)_: the lane
runs through every ticket, the fresh gate1 install (MG0) and the browser spec before anything is
shown for review; the gate ticket is KOBE-583 (`docs/gates/gate-workspaces.md`). One generated migration plus custom SQL for the
enum rename and RLS; upgrade tests on a populated database; the cross-team probe suite green.

**WS-1. Protocol (`packages/protocol`).** `teamRoleSchema` with `contributor`;
`projectVisibilitySchema`; `projectRoleSchema` with `reader`;
`projectPermissions` per PR3 (`view`, `converse`, `edit`, `manage`, `manage_members`, `create`);
commit, tree entry, checkout, history and revert shapes and error codes; `run.start.project.access`;
`checkouts` on the sync pull response; `commit_project` tool input; new audit event names.

- ac-1: strict schemas with tests; old `run.start` without `access` parses (additive).

**WS-2. Database (`packages/db`).** Enum rename (MG1); `visibility` replacing `members_mode` in one migration (MG0, MG2); `reader`
role (MG3);
`project_commits`, `project_tree_entries`, `project_checkouts`, `projects.head_commit_id`,
`team_storage_quotas.max_objects`, object counters beside the byte totals; RLS,
indexes, checks; tenancy registry rows in `tenancy/workspace.ts`; probe fixtures; blob-ref
registration for `project_tree_entries.blob_ref`; legal-hold guard coverage; the first-commit
backfill (MG4); audit event definitions (GV4).

- ac-1: probe suite green; upgrade test on a populated database proves MG1–MG4; hold guard refuses
  deleting commits under hold.

**WS-3. Server: roles, visibility, mounts.** Permission matrix wiring; creation gate (PR4);
visibility and `reader` in `projects/access.ts` and the routes; owner transfer (PR5); memory write
gate (PR6); mount-on-conversation (MT1–MT4) with `reconcileUser` on thread create and move;
`too_many_mounts`; audit.

- ac-1: db tests for the matrix row by row (reader converses, cannot upload; editor uploads; owner
  re-roles; team admin everything; restricted hides from non-members with 404 everywhere).
- ac-2: a mount appears on the first project thread, survives a second, disappears when the last
  is trashed; a reader of a restricted project loses the mount on removal; leaving the workspace
  unmounts everything.
- ac-3: last owner stays; a team admin transfers ownership; the owner-less state is listed.

**WS-4. Server: commits.** Checkout, commit, update, discard, history, revert (CM1–CM5, CM7,
CM9); the sync push relaxation and `checkouts` in the pull (CM4); the FE4 save and the Files
routes inside a checkout (CM3); blob copy with hash verification; quota attribution and history
pruning (GV2, GV3); export (GV5); the wire handler `project.commit` with approval (CM6) and D32
refusal.

- ac-1: db tests: checkout → edit via save route → commit writes commit 2 with the right tree and
  diff; a second editor's commit on a stale base gets `commit_conflict`; Update merges untouched
  paths and makes `.conflict-` copies for both-changed ones; Discard restores the head; Revert
  writes a new commit equal to an old tree.
- ac-2: push into `projects/<slug>/` is accepted only with a checkout for that (team, user, slug);
  rejected `read_only` otherwise; relock after discard is observed by the next pull.
- ac-3: agent commit path: approval required unless a rule allows, canonical input binds the diff
  hash, `auto` run refused and recorded; a reader's run never registers the tool.
- ac-4: quota: a commit over the team byte quota or the object budget is refused with the limit
  named and attributed to the project; the storage view reports bytes and objects per project;
  pruning by `N commits`, `N days` and the hard cap keeps head, checkout bases and held
  workspaces, and is audited.

**WS-5. Sandbox agent.** `checkouts` handling in sync (CM4): scan and push checked-out slugs,
permissions `0664/0775` inside them, relock on removal, restore rule after discard;
`commit_project` in kobe-tools and kobe-policy (CM6); the project access line in the system
prompt (PR3).

- ac-1: real-pi tests: a tool writes a file in a checked-out project and the push carries it; the
  same write in a read-only project fails by uid; after the checkout disappears from the pull the
  folder is relocked and matches the head.
- ac-2: `commit_project` only registered with `access: write`; a refused policy check surfaces the
  reason to the model.

**WS-6. Web.** Product strings (WS5: Workspace switcher, Team / Workspace settings, Contributor);
Files panel tree (FP1–FP3); editor checkout and commit controls (CM8); project page: visibility,
roles with reader/editor/owner, History tab, working copies, ownership transfer, download; Threads
panel labels and header menu (FP4); storage and history settings in Workspace settings (GV2, GV3).

- ac-1: component tests for the tree (mounted projects, editing mark, My files subtree, All
  projects link), the read-only versus checked-out editor states, the commit dialog flow with
  `commit_conflict` → Update → Commit, and the roles UI.
- ac-2: a reader sees Open-to-mount and no edit affordances; an editor sees Check out to edit.
- ac-3: no string says "Builder" or calls the scratchspace "workspace" in the shell.

**WS-7. Removal, browser check, docs, ledger.** Remove `propose_project_file`; `e2e/browser/tests/workspaces.spec.ts` (owner creates a restricted
project, adds member2 as reader, member2 converses but cannot upload; promote to editor, check
out, edit in the editor, commit, owner sees the commit in History and the file in their mount);
`docs/audit-log.md`, API glossary, `docs/RUN-LEDGER.md`.

- ac-1: the spec passes against gate1; `pnpm verify`, db suites and `pnpm license:check` pass (no
  new dependency expected).

## 16. Out of scope

- Shared project sandboxes or volumes; a project of its own RuntimeClass or namespace (D11).
- Projects spanning workspaces; moving a project between workspaces.
- Git as the primary store, branches, pull requests, external repository sync (CM10, later).
- Several projects on one conversation (Chris: one).
- A workspace setting for who may create projects (PR4 fixes it to admins and contributors).
- Per-file permissions inside a project; file locking; live co-editing.
- Project-owned schedules, published apps or artifacts as project outputs (candidate next spec
  for "data products").
- Renaming code identifiers, the `/workspace` mount path or S3 keys (WS3).
