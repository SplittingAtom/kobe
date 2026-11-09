# KOBE-581: Workspaces: Web — switcher, Files panel tree, checkout and commit UI, roles, History (WS-6)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (coordinator pushes and opens the PR)
- **Branch / worktree:** `kobe-581-workspaces-web` in `../Kobe-wt581`
- **Depends on:** KOBE-576 (protocol), 577 (db), 578 (server roles), 579 (commit routes); all
  merged, branch merged with main `3f4c15a5`

## Plan

apps/web only: WS5 strings; FP1–FP3 Files tree; CM8 editor controls; project page (visibility,
roles, ownership, History, Working copies, storage); FP4 Threads header menu; GV2/GV3 storage view.

## Decisions

- **Web types follow the wire** (`lib/projects/api.ts`): `visibility`, roles `owner|editor|reader`,
  storage fields; the KOBE-576 edge translation (reader shown as "member") is gone. Add-member
  default role `editor`. `my_role: null` (unlisted team admin) acts as owner everywhere.
- **Commit API** in `lib/projects/commits-api.ts` (checkout, discard, commit, update, history,
  commit detail, download at a commit, revert, working copies) with the KOBE-576 shapes.
- **Chat context** `components/projects/workspace-projects.tsx`: readable projects by slug + the
  caller's checkouts, loaded lazily (first `ensure()`: a projects/ folder in the listing, a project
  file opened, a project header's menu). Outside the chat nothing changes (all projects read-only).
- **Read-only rule in the web**: `isReadOnlyPath(path, checkedOut)` (and `canMoveInto`,
  `canUploadInto`, `editBlockReason`) treat `projects/<slug>/…` as writable inside the caller's
  checkout; the project folder itself stays server-owned (no rename/move/delete).
- **Files panel (FP1)**: top row "Workspace: <name>" + Refresh; "Projects" tree (mounted projects
  one level up, name as label, slug as `title`, role chip, "editing ●", lock unless checked out,
  "All projects (n) →" counting live readable projects; menu: Check out to edit | Commit… / Update
  / Discard, Open project page); "My files" tree (today's tree minus `projects/`, its top-level
  `aria-posinset/setsize` recounted). Two ARIA trees, each one tab stop. A drop on a read-only
  project says "Check out to edit: <name> is read-only." (editor) or "You can read this project,
  not change it." (reader); a checked-out project takes uploads and moves inside it.
- **Editor (CM8, FP3)**: `components/projects/project-file-bar.tsx` under a file tab's header:
  checked out → name, "Changes: n changes" (from the checkout diff, re-read after saves), Commit…,
  Update, Discard (asks when the diff is non-empty, at once when empty); editable → "Check out to
  edit"; reader → read-only notice. Commit dialog (≤ 500 chars): `commit_conflict` shows "has
  newer commits" + Update in the dialog, then Commit again; `nothing_to_commit` is a notice.
- **Project page**: tabs Overview | History. "Open to mount" while the caller has no own thread in
  the project and no checkout, else "Open in a conversation" (both `/?project=<id>`, FP2); reader
  badge + "read and converse, not change". Visibility select + explanation; roles select owner/
  editor/reader; "No owner: assign one" notice + Transfer ownership form (`#project-owner`);
  Projects page links owner-less projects for team admins (`GET /v1/projects/no-owner`, never
  called for others). File uploads/deletes on the page need `edit` (578 matrix). Storage block
  (live/history bytes and objects, "—" while null). History: commits (seq, message, author or
  "Agent for <name>", files, size, time), Show older (`before`), diff table with sizes, per-file
  download at the commit (not for deleted), the commit's tree, Revert (editors+, confirm). Working
  copies for owners/admins only (`can.manage`).
- **Threads panel (FP4)**: project group header gets a ⋯ menu (file-menu scope, bound items only):
  "Check out" or Commit… / Update / Discard for editors, Open project page for all. "Your threads"
  unchanged.
- **WS5 strings**: switcher/collapsed icon/console menu say "Workspace" (`Workspace: <name>, <role>`,
  "Your workspaces", "Choose a workspace"); one-workspace header shows the role chip too. Team
  console groups: **Team** (Members and roles, Invitations), **Workspace settings** (Models,
  Follow-ups, Budgets, Connectors, Egress, Policy, Retention, Memory, Storage and history),
  Agents and skills, Governance (Usage, Audit, Break-glass). Smallest reading: Follow-ups is a
  chat setting of the place, so it joined Workspace settings; Usage moved to Governance once
  "Models and spend" emptied. "Builder(s)" → "Contributor(s)" in every shown string; the agent
  builder (a tool, not the role) keeps its name. Scratchspace "workspace" strings → "My files" /
  "your files"; sandbox wake messages say "sandbox". "Workspace" left where it means the place
  (rail landmark, legal hold, storage full, visibility).
- **Storage and history page** (`/admin/team/storage`, permission `team.projects.manage` as the
  579 route): totals vs quota and object budget, per project (with commit count) and per member's
  files, and a settings form (history kept: all / N commits / N days; projects mounted per member;
  object budget, empty = site default) that PUTs only what changed (snake_case) and shows the
  answer. `lib/projects/storage.ts` maps the snake_case view.
- No "Copy to project…" (SS3) and no cross-tree drag from My files into a checkout: not in this
  ticket's list; a drag between the two trees does nothing.

- **Review fixes (coordinator, round 1):** a failed projects or checkouts read is an error state
  (alert + Try again in Files, a notice in the editor), never "no checkouts", and `ensure()`
  retries while in error; only a known, live project's checkout is writable (unknown/archived =
  readable); editor reasons follow `projectFileAccess` (reader / check out / archived); Upload
  and the folder note use `canUploadInto` for project folders; the inactive tree's focus reports
  are kept, not applied, until focus enters it; "No projects" waits for the projects/ listing;
  "Show older commits" has an in-flight guard and dedupes by id; `list()` lost the unused
  `?role=editor` option; "No owner: assign one below." only with the transfer form.

## Matched to KOBE-579 (merged, main `3f4c15a5`; re-checked against the routes on main)

- Routes and bodies as the KOBE-576 shapes; `GET /v1/me/checkouts` answers 200 `{checkouts: []}`
  when none (a failure, 404 included, is the error state); `GET /v1/projects/{id}/checkout` →
  checkout + `diff` (404 = none); head zip `GET /v1/projects/{id}/download` ("Download as zip" on
  the project page, readers too); `GET/PUT /v1/team/storage` (above); Update's `conflict_paths`
  are workspace paths `projects/<slug>/…`, shown inside the project. No drift found after the merge.

## Open for 582

- **582 browser specs:** e2e still names the old strings: tree `"Files in your workspace"` →
  `"My files"` (files-tree, file-editor, rail-resize, add-to-project, viewed-file-guard,
  shared-file-badge, file-tab-outside-change, gate5/u18), navigation `"Teams"` → `"Workspace"`
  (rail-header.spec), "no longer in your workspace" → "no longer in your files". A mounted project
  is now in the `"Projects"` tree, not under `projects/` in My files.

## Open questions (for Chris or the coordinator)

should be another.

## Evidence (acceptance criteria → test or command output)

- ac-1: tree `components/files/workspace-tree.test.tsx` (mounted projects, role chips, editing
  mark, All projects (n), My files subtree, drop refusals, project menu → commit) and
  `file-tree.test.tsx` (updated for the two trees); editor states and commit flow
  `components/projects/project-file-bar.test.tsx` (commit_conflict → Update → Commit, nothing to
  commit, Discard asks / does not); roles and visibility, History, Working copies, ownership
  `components/projects/project-roles.test.tsx`; FP4 `components/shell/threads-panel.test.tsx`
  ("project header menu"); storage `components/admin/team/storage-page.test.tsx`; pure helpers
  `lib/projects/workspace.test.ts`, `lib/files/tree.test.ts`, `lib/files/editor.test.ts`.
- ac-2: `project-roles.test.tsx` "a reader sees Open to mount and no edit affordances";
  `project-file-bar.test.tsx` "an editor sees Check out to edit" / "a reader sees a read-only
  notice"; `workspace-tree.test.tsx` "offers Check out to edit to an editor, and nothing to change
  to a reader".
- ac-3: `lib/workspace-wording.test.ts` (no shown "Builder"; no "your/my workspace" in the shell),
  `workspace-tree.test.tsx` "never calls the member's files the workspace".
