# Kobe — Thread lineage and thread folders

Status: **decisions by Chris, 2026-10-31** (Q1–Q6 in §7; TL1–TL9 and TF1–TF12 below reflect them).
Hadron spec `71dcf77b-f3ef-4458-be76-54bebf3647ad`; tickets filed 2026-11-01: TLF-1 KOBE-532, TLF-2
KOBE-533, TLF-3 KOBE-534, TLF-4 KOBE-535, TLF-5 KOBE-536, TLF-6 KOBE-537 (lane brief:
`docs/ledger/thread-lineage-folders-lane.md`). Written against main `443f5568`.

Request (Chris, 2026-10-31): when a thread is forked, show that at the top of the conversation
column: the original thread first, below it the fork with a fork icon and its name, each name a
link that switches to that thread, and a dropdown where a thread has several forks. Within a
workspace, threads exist today as current threads and deleted threads: add thread folders a
member can save a current thread into, and give the Threads panel two rails: a folder tree on the
left (current, deleted and the member's folders), the threads of the chosen folder on the right.

## 1. Summary

**Lineage.** A fork already records where it came from (CE16, KOBE-215: `forked_from_thread_id`,
`forked_at_entry_id`) and the conversation shows one line, "Forked from _X_ at “…”". This spec
replaces that line with a **lineage strip** at the top of the conversation column: the root thread
first, then each fork down to the thread on screen, one row per generation with a fork icon. Every
row is a link that opens that thread. Where a thread has several forks the viewer may open, the
row is a dropdown of them; the thread on screen gets a trailing "Forks" dropdown when it has
forks of its own. The server answers one new read, `GET /v1/threads/{id}/lineage`, that names
only threads the viewer may read, under the rule the fork origin uses today.

**Folders.** Members create **thread folders** for the team (nested up to three levels, visible to
every member of the workspace) and save threads into them. A thread is in at most one folder, and a
filed thread lives there, not in `Current`. A member sees in a folder the threads they may read
(their own and the ones shared with them), so a shared read-only thread can be filed too. The
Threads panel (KOBE-453) gets two rails: a **folder tree** on the left with `Current` (holding
`Archived`, folded), the team's folders and `Deleted`, and on the right the threads of the chosen
node, with today's groups, rows, menu, drag and search. Nothing about retention, who may read a
thread, projects or the model changes.

## 2. Where this sits among the Kobe decisions

| Decision                   | How this spec relates to it                                                                                                                                                                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CE16** Fork              | Extended. The provenance columns stay as they are (set at INSERT, never re-pointed, SET NULL on purge). The lineage strip reads them; nothing new is written when forking except TF9 (a fork of a filed thread inherits the folder).                                                      |
| **CE19** Organization      | Extended with a third axis: folder, beside pin and archive. Unlike those two it is team-visible, so it is audited like a project move (TF11). Idempotent, refused in Trash, never activity (`last_activity_at` untouched).                                                                |
| **CE5** Rail, **KOBE-453** | The Threads panel stays the large centred overlay. Its content gains the folder tree; the rail itself does not change.                                                                                                                                                                    |
| **CE20 / D23** Sharing     | A fork of another member's shared thread is private to the forker; lineage shows only threads the viewer may read (own, shared to them). Nothing about who may read a thread changes: a folder shows each member only the threads they may read. A reader may file a shared thread (TF3). |
| **D18** Retention, Trash   | `Deleted` is Trash: same 30-day purge, Restore, Delete forever. A filed thread keeps its folder in Trash and returns to it on Restore. Retention runs from the last message as before; a folder never extends a thread's life. Export gains the folder path.                              |
| **D15 / D16** Record, wire | One new team table (`thread_folders`), one new column (`threads.folder_id`), one new read route, one new organize action, folder CRUD routes. No new event kinds on the run stream.                                                                                                       |
| **D31** Audit              | Team events for folder create, rename, move and delete and for filing a thread (TF11): they change what every member sees. Fork and move stay audited as today.                                                                                                                           |
| **D9** One active team     | Folders belong to the team. Switching team shows that team's folders.                                                                                                                                                                                                                     |

## 3. Today (what the code does, verified 2026-10-31)

- `threads.forked_from_thread_id` / `forked_at_entry_id` (`packages/db/src/schema/threads.ts`):
  SQL-only key `threads_forked_from_fk` ON DELETE SET NULL; trigger `threads_guard_forked_from`
  refuses any UPDATE except to NULL, so provenance has no cycles. Index `threads_forked_from_idx`
  on (team_id, forked_from_thread_id).
- The thread summary carries `forked_from_thread_id`, `forked_at_entry_id` and
  `forked_from_title`; the server (`threads/repository.ts`) names the source only when the viewer
  may read it, else the id and title are null and the web shows "a thread you can't open"
  (`HIDDEN_SOURCE`, `apps/web/lib/chat/fork.ts`).
- `ForkOriginNote` (`apps/web/components/chat/fork-origin.tsx`) renders one line above the
  conversation; the rail row's hover text says "Forked from …" (`forkHint`).
- `POST /v1/threads/{id}/fork` copies entries, keeps the project when the forker may create
  there, audits `thread.forked`, rate limit 30 per 10 min per user (`threads/fork.ts`).
- The Threads panel (`apps/web/components/shell/threads-panel.tsx`) is a modal overlay at
  `/threads`: search, Export, groups in fixed order (Pinned → projects → Your threads → Scheduled
  → Workbench → Shared with me → Archived → Trash; `lib/chat/thread-groups.ts`), Trash and
  Archived start collapsed, rows from `thread-item.tsx` with the ⋯ menu (`use-thread-menu`), drag
  onto a project header, Load more. Under 820 px it is a full-screen sheet.
- The list adapter (`lib/chat/thread-list-adapter.ts`) reads five lists on open (pinned, activity
  page, shared, archived, trash) and pages only the activity list. Placement travels in
  assistant-ui's item `custom` (`placementCustom`).
- Organization routes: `POST /v1/threads/{id}/pin|unpin|archive|unarchive|move`
  (`threads/organize.ts`), each `lockForChange` (owner only), refused in Trash and on test threads.
- Layout preferences (`packages/protocol/src/ui-preferences.ts`) are a strict object; new keys
  are additive.

## 4. Lineage decisions

**TL1. One read: `GET /v1/threads/{id}/lineage`.** Any viewer who may read the thread (owner, or
a reader under D23) gets:

```jsonc
{
  "thread_id": "…",            // the thread asked about
  "root_hidden": false,        // true: the chain continues above `ancestors[0]` into a thread the viewer can't open
  "ancestors": [               // root first, down to the parent of `thread_id`; [] for a thread that is not a fork
    { "thread_id": "…", "title": "Budget 2027", "deleted_at": null,
      "siblings": [ /* the readable forks of THIS thread's parent, newest first, incl. itself; [] at the root */ ] }
  ],
  "self": { "thread_id": "…", "title": "…", "forked_at_entry_id": "c3d4…", "siblings": [ … ] },
  "forks": [ { "thread_id": "…", "title": "…", "deleted_at": null, "owner": "me" | "other" } ]  // readable forks of `thread_id`, newest first
}
```

The server walks `forked_from_thread_id` upward at most `LINEAGE_MAX_DEPTH` (20) steps inside one
`withTeam()` transaction (no cycles are possible, TL5), then reads the forks of every thread on
the path plus of the thread itself in one query over `threads_forked_from_idx`. Each list is
capped at `LINEAGE_MAX_SIBLINGS` (50), newest activity first, and says `more: true` when cut.
Titles are the stored titles (null → the web's "Untitled conversation"). Nothing about a thread
the viewer cannot read is returned: not its id, not its title, not that it exists. A chain that
reaches an unreadable ancestor stops there and `root_hidden` is true. A purged ancestor is simply
absent (the key was nulled): the fork's `forked_at_entry_id` without an ancestor means "forked
from a thread that no longer exists", as today.

**TL2. Readable means the same as today.** The same predicate the summary's `forked_from_title`
uses: the viewer owns the thread, or it is shared to a project they are a member of, or shared to
the team (CE20). Builder test, Workbench test and eval threads are never listed (they are never
forked either). Threads in Trash **are** listed for their owner (with `deleted_at`), greyed in the
UI with "In Trash", because the owner can still open them; another member's thread in Trash is
not readable (its share no longer serves) and so is not listed.

**TL3. The strip.** Shown at the top of the conversation column (right column), where the
"Forked from" note is today, only when `ancestors` or `forks` is non-empty (an ordinary thread
shows nothing new). It replaces `ForkOriginNote`. One row per generation, root first, each row
after the first indented one step and prefixed with the fork icon (`GitForkIcon`, as the note):

```
Budget 2027                                  ← root (link)
  ⑂ Budget 2027 — marketing cut              ← link; "1 of 3 ▾" when the parent has several readable forks
    ⑂ Try the Q3 numbers ▾  · at “Redo Q3…”  ← the thread on screen: bold, not a link; its fork point excerpt
      ⑂ 2 forks ▾                            ← only when the thread on screen has forks
```

- Every ancestor's title is a link to `/?thread=<id>` that opens the thread in place
  (`OpenThreadContext`, as the note's link does; a modified click keeps the browser's own).
- When the thread at a row has **siblings** (its parent has more than one readable fork), the row
  is a **dropdown button** (Radix `DropdownMenu`, the chat's portal): the label is the thread in
  the path with "n of N", the menu lists the siblings newest first with the one in the path
  checked; choosing another opens it. The root row is never a dropdown (roots have no siblings).
- The last row is the thread on screen: its title in the strip's bold, then "at “<excerpt>”",
  the fork point excerpt the note shows today (`forkPointExcerpt`, 48 chars, from the thread's own
  projection).
- A trailing **Forks** row appears when the thread on screen has readable forks: "⑂ N forks ▾",
  a dropdown of them newest first; one fork reads "⑂ 1 fork: <title>" as a plain link.
- A hidden root (`root_hidden`) adds a first, unlinked, muted row "a thread you can't open" above
  the first readable ancestor (the `HIDDEN_SOURCE` text). A missing root (purged) shows nothing
  extra: the chain just starts lower, and the current row's "at “…”" still says where it forked.
- More than `LINEAGE_FOLD_ROWS` (4) ancestor rows fold the middle: root, "… n more ▾" (a dropdown
  of the folded generations in order), parent, self.
- "In Trash" threads in any list carry a muted "In Trash" suffix.
- Under 820 px the strip is one line, "⑂ Forked thread · N related ▾", whose dropdown holds the
  whole family in the order above (indented items), so nothing is lost on a phone.
- Plain text only (titles are escaped as everywhere), `role="navigation"` labelled "Thread
  lineage", items are real links or menu items, so the keyboard and screen readers get them.

**TL4. When it reads.** The web reads the lineage when a thread opens (with its summary), when
the member forks (the fork dialog's success), when a fork is restored or trashed from the panel,
and on window focus if the last read is older than 60 s. It is never pushed and never stored. A
failed read shows nothing (no error box: the conversation is unaffected) and retries on the next
trigger. The rail row's "Forked from …" hover hint stays as it is.

**TL5. No new columns for lineage.** The provenance already there is enough; the trigger
guaranteeing no cycles stays, so the walk needs no visited set beyond the depth cap. _Rejected:_ a
`root_thread_id` column or a closure table (one more thing to keep right on purge for a read that
is cheap at depth ≤ 20).

**TL6. Rate and cost.** One lineage read per thread open is the same order as the summary read.
The route is behind the ordinary per-member request limits; no new limit.

**TL7. Lineage across projects and Trash.** Links open whatever the viewer may open: a fork moved
to another project, or in Trash, still opens (the conversation header already shows "In Trash").

**TL8. Rail row title hint unchanged; panel rows gain nothing.** The panel does not draw trees:
lineage is the conversation's view. (A "Forks" group in the panel was considered and rejected: the
panel is for finding threads, the strip for moving within a family.)

**TL9. Protocol.** `packages/protocol/src/threads.ts` gains `threadLineageResponseSchema` (strict,
the shape in TL1), exported types, and `LINEAGE_MAX_DEPTH`, `LINEAGE_MAX_SIBLINGS`. Additive.

## 5. Folder decisions

**TF1. Folders belong to the team, nested to three levels.** (Chris, 2026-10-31: folders are
visible to all members of the workspace.) Table `thread_folders` (area `conversations`,
`packages/db/src/tenancy/conversations.ts`):

```
team_id uuid NOT NULL → teams ON DELETE CASCADE
id uuid NOT NULL DEFAULT gen_random_uuid()
parent_id uuid NULL
name text NOT NULL            CHECK char_length(btrim(name)) BETWEEN 1 AND 80 AND name = btrim(name)
position integer NOT NULL DEFAULT 0   -- manual order among siblings; ties by name
created_by uuid NOT NULL → users (NO ACTION; users are deactivated, never deleted)
created_at, updated_at timestamptz NOT NULL DEFAULT now()
PRIMARY KEY (team_id, id)
FOREIGN KEY (team_id, parent_id) → thread_folders (team_id, id) ON DELETE CASCADE
UNIQUE (team_id, parent_id, lower(name))   -- SQL-only expression index, NULLS NOT DISTINCT for the top level
INDEX thread_folders_tree_idx (team_id, parent_id, position, name)
ENABLE + FORCE ROW LEVEL SECURITY, policy on current_setting('kobe.team_id')
```

Every member of the team sees every folder; any member may create, rename, move or delete one
(there is no folder owner, only `created_by` for the audit trail). A trigger
`thread_folders_guard_parent` (SQL-only, like `threads_guard_forked_from`) refuses a parent chain
deeper than `THREAD_FOLDER_MAX_DEPTH` (3, counting the folder itself) and any cycle. At most
`THREAD_FOLDERS_MAX` (500) folders per team (checked in the create transaction under a per-team
advisory lock). Deleting a folder cascades to its subfolders; their threads are **not** deleted:
`threads.folder_id` is nulled (TF2) and they are back in `Current` for their owners. The
cross-team probe suite gains the table.

**TF2. A thread is in at most one folder: `threads.folder_id`.** New nullable column; SQL-only
key `threads_folder_fk` (team_id, folder_id) → thread_folders ON DELETE SET NULL (folder_id), the
way `schedule_id` is done. Index `threads_folder_idx` (team_id, folder_id, last_activity_at DESC,
id DESC) WHERE folder_id IS NOT NULL AND deleted_at IS NULL, IF NOT EXISTS so large sites can
build it CONCURRENTLY first (`docs/install.md`, "Upgrading"). Check `threads_folder_not_test`: a
builder test, Workbench or eval thread never has a folder. The folder is a property of the thread,
seen by everyone who may read the thread (`folder_id` in every reader's summary).

**TF3. Filing: `POST /v1/threads/{id}/file` `{folder_id: uuid | null}`.** The sixth organize
action, beside pin/unpin/archive/unarchive/move (`threads/organize.ts`). Who may file: the owner,
and any member who may read the thread under D23/CE20 (shared to their project or to the team),
since folders are the team's and a shared thread is already in front of them (Chris,
2026-10-31). This needs a new lock, `lockForFiling`, beside the owner-only `lockForChange`: it
takes the row `FOR UPDATE` when the viewer may read it, and leaves every other change owner-only.
Refused in Trash (`thread_in_trash`), on a test thread (`test_thread`), and on a folder that does
not exist in this team (404 `folder_not_found`). Idempotent; never activity. `null` removes the
thread from its folder (back to `Current`). Filing keeps pin, archive, project and shares as they
are: those axes are independent (TF6). Audited `thread.filed` `{threadId, from, to}` (folder ids,
null for none) only on a change (TF11), so the owner can see who moved their thread.

**TF4. Folder routes.** Under the member's team context, for any member of the team:

- `GET /v1/thread-folders` → `{folders: [{id, parent_id, name, position, created_by, threads: n}]}`,
  every folder of the team (at most 500, so no paging). `threads` is the count **for the caller**:
  the folder's live, unarchived threads the caller may read (own, or shared with them), from one
  grouped query under the same predicate as TF5.
- `POST /v1/thread-folders` `{name, parent_id?}` → 201 the folder. Rate limit 60 per 10 min per
  member (`folder-create`), as fork's. Audited `thread_folder.created`.
- `PATCH /v1/thread-folders/{id}` `{name?, parent_id?, position?}` → the folder; `parent_id: null`
  moves it to the top level. Errors: `folder_not_found` (404), `folder_name_taken` (409),
  `folder_too_deep` (409; also when the folder's own subtree would then exceed the depth),
  `folder_cycle` (409), `folder_limit` (409). Audited `thread_folder.renamed` or
  `thread_folder.moved` on a change; a position change alone is not audited.
- `DELETE /v1/thread-folders/{id}` → 204; subfolders go with it, threads return to `Current`.
  Audited `thread_folder.deleted` `{folderId, name, folders: n, threads: n}` (what it took along).

Names are plain text, trimmed, 1–80 chars, unique among siblings ignoring case. _Rejected:_
restricting rename and delete to the creator or a team admin: Chris chose folders every member
can see and use, and the audit trail (TF11) says who did what; a thread is never lost by a folder
change, it returns to its owner's `Current`.

**TF5. Listing a folder's threads.** `GET /v1/threads` gains `folder=<uuid>|none` (default:
unchanged, the caller's own live threads). `folder=<id>` lists that folder's live, unarchived
threads **the caller may read**: their own, plus others' shared to a project they are in or to the
team (the `/shared` predicate), newest activity first, keyset-paged as today; `none` lists the
caller's own unfiled ones. `/pinned` takes the same parameter (the caller's pinned threads of that
folder). `/archived`, `/trash` and `/shared` do not: Archived and Trash are their own nodes and
list every such thread of the caller whatever its folder, and the Shared with me group of
`Current` lists others' unfiled shared threads. The thread summary gains `folder_id` (additive, in
`threadOrganizationSchema`), sent to every reader, so `placementCustom` can carry it and the
client can place rows without a second read.

**TF6. What a folder shows.** (Chris, 2026-10-31: a filed thread lives in its folder, not in
`Current`.) The chosen folder's right rail shows the same groups as `Current`, restricted to that
folder's live, unarchived threads the member may read: Pinned (of this folder), projects, Your
threads, Scheduled, Shared with me (others' threads filed here and shared with the member).
Workbench never appears in a folder (test chats cannot be filed), and neither does an Archived
group: an archived thread shows only under `Archived` (TF7), whatever its folder, and returns to
its folder on Unarchive (the folder is kept, as in Trash). Subfolders are nodes in the tree, not
groups in the list: choosing a folder shows its own threads only (not its subfolders'); a folder
with subfolders and nothing the member may read says "No threads here. Its folders are in the
tree." Counts on tree nodes are the node's own threads, for this member (TF4).

**TF7. The two rails of the Threads panel.** At ≥ 820 px the panel's body becomes a two-column
grid: the tree, 220 px (not resizable in v1), a divider, and the list taking the rest. The search
box and Export stay in the panel's header row above both. The tree (`role="tree"`, arrow keys as
the Files tree) holds, in this order:

```
▾ Current          (n)   ← the member's live, unarchived threads not in a folder: today's groups minus Archived and Trash
    Archived       (n)   ← the member's archived threads (CE19), whatever their folder; folded under Current by default
▸ Folder A         (n)   ← the team's folders, every member sees the same tree; counts are the member's
  ▸ Sub-folder     (n)
  Folder B         (n)
Deleted            (n)   ← Trash: today's Trash group with Restore / Delete forever and the 30-day hint
+ New folder
```

(Chris, 2026-10-31: `Archived` is a built-in node that stays collapsed inside `Current`.) The
`Archived` node is a child of `Current`, folded until the member opens `Current`'s chevron (the
fold state lives with the tree, in memory). It lists the member's archived threads newest-archived
first, as today's Archived group does (`/archived`), as one flat list with the row's folder path as
a muted note under rows that have one; its rows keep the ⋯ menu (Unarchive, Delete). The Archived
group disappears from `Current`'s list and from folders. Counts on `Current` and on folders leave
archived threads out; `Archived` counts them all.

`Current` is selected when the panel opens for the first time in a session; after that the panel
reopens on the node last chosen (in memory per tab, not a stored preference; TF12). Choosing a
node replaces the list; the list's own group open/closed state is kept per node. Under 820 px the
tree is a single `<select>`-style dropdown above the list ("Current ▾") listing every node with
its depth as indentation (Archived indented under Current), and `+ New folder` is a button beside
it.

Node actions (⋯ on hover/focus, or the context menu key): Rename (inline), New folder inside
(refused at depth 3 with "Folders go three levels deep"), Move to… (a submenu of the other
folders and "Top level"), Delete (confirm: "Delete “A” and its 2 folders? The threads in them go
back to their owners' Current."). `Current`, `Archived` and `Deleted` have no actions. The tree is
read again when the panel opens, when the window regains focus and after any folder change the
member makes, so another member's new folder appears on the next open or focus (no push).

**TF8. Putting a thread in a folder.** Three ways, all calling TF3, offered on every row the
member may read (their own and the ones shared with them):

- The row's ⋯ menu (`useThreadMenuBindings`) gains **Save to folder…** (a submenu: the team's
  folders as an indented list, "New folder…" at the end, and "Remove from folder" when it is in
  one). Keyboard path to everything below. On a read-only shared row the menu, which today offers
  only Copy, gains this item.
- Drag a row onto a tree node (the same `THREAD_DRAG_TYPE` as dropping on a project header; the
  node highlights with `data-drop-target`). Shared rows become draggable for this purpose only
  (a drop on a project header still refuses them, as today). Dropping on `Current` removes the
  thread from its folder; `Archived` and `Deleted` are not drop targets (archive and Trash stay
  explicit actions).
- The conversation header's thread menu (the ⋯ beside the title; `thread-commands.tsx`) gets the
  same **Save to folder…** item, so a member can file the thread they are in without opening the
  panel. The command palette lists it as "Save to folder".

A successful move announces in the panel's polite region ("Saved “Budget” to Folder A") as the
project move does (`organizedMessage`).

**TF9. Forks, Trash, archive, projects, sharing, export.**

- A fork starts in its source's folder (Chris, 2026-10-31: forked threads inherit the folder from
  the parent), whoever owns the source: `createThread` takes `folderId` and the fork plan copies
  the source's. A folder deleted between plan and insert nulls it (the key).
- Trash keeps `folder_id`; Restore puts the thread back in its folder (or in `Current` when the
  folder was deleted meanwhile, since the key nulled it). Delete forever and the 30-day purge are
  unchanged. Archive keeps it the same way (TF6).
- Moving a thread between projects keeps its folder; folders and projects are independent axes.
  The project's own group inside a folder's list shows which project each filed thread is in.
- Sharing a filed thread to its project or the team works as today; readers see it in the folder
  (TF5) and may re-file it (TF3). Unsharing takes it out of their view of the folder; the folder
  stays on the thread.
- The export zip's per-thread metadata (`retention/export.ts`) gains `folder: "A/Sub-folder"`
  (the path by names) when set.

**TF10. Panel search spans every node.** The server search (`GET /v1/threads?q=`) is unchanged
and finds threads in any folder; a hit in a folder shows the folder path under the row as the
match note does (`hit-note.ts`). Search results replace the right rail only; the tree stays.

**TF11. Audited as team organization; no event stream change.** Because every member sees the
folders and a filing moves a thread for everyone who may read it, the changes are audited as team
events in `packages/db/src/audit/events.ts` and `docs/audit-log.md`: `thread_folder.created`
`{folderId, name, parentId}`, `thread_folder.renamed` `{folderId, from, to}`,
`thread_folder.moved` `{folderId, from, to}` (parent ids), `thread_folder.deleted` `{folderId,
name, folders, threads}`, and `thread.filed` `{threadId, from, to}` (folder ids), only on a change.
Pin and archive stay unaudited (personal, CE19). No new kinds on the run event stream.
_Rejected (earlier draft):_ no audit at all, which fitted personal folders only.

**TF12. Preferences.** No new stored preference. The chosen node and the tree's fold state are
remembered in memory per tab (as the groups' open/closed state is). `rail_panels`, `rail_tab`,
`rail_picker` are untouched. _Rejected:_ remembering the node server-side: it would make the first
open of the panel wait on one more read for little gain.

## 6. Interaction details and limits

| Item                              | Value                                                    |
| --------------------------------- | -------------------------------------------------------- |
| Folder name                       | 1–80 chars, trimmed, unique among siblings ignoring case |
| Depth                             | 3 (folder, sub-folder, sub-sub-folder)                   |
| Folders per team                  | 500                                                      |
| Folder create rate                | 60 per 10 min per member                                 |
| Lineage walk depth                | 20 generations                                           |
| Siblings / forks listed per level | 50, newest first, `more: true` when cut                  |
| Strip fold                        | more than 4 ancestor rows fold the middle                |
| Tree width                        | 220 px at ≥ 820 px; dropdown below 820 px                |
| Lineage re-read on focus          | when older than 60 s                                     |

Accessibility: the tree is `role="tree"` with `aria-selected`, arrow keys, Home/End, type-ahead;
the strip is `role="navigation"` "Thread lineage"; dropdowns are Radix menus in the chat portal;
every action has a keyboard path (the ⋯ menus) beside drag and drop; announcements go through the
panel's existing polite region.

Security: every folder route and the file action run inside `withTeam()` under RLS, so a folder
of another team answers 404 like a thread would. Filing checks that the viewer may read the
thread (owner or D23/CE20 reader) before taking the row lock; a folder's list and counts apply the
same readable predicate per viewer, so a folder never reveals a thread its member could not open
elsewhere (not its title, not its count). Every folder change and filing is audited with the
actor (TF11). Lineage reveals nothing about unreadable threads (TL1). Folder names are rendered as text, never HTML.
No new secrets, no sandbox involvement, no model exposure (folders never reach the model's
context).

## 7. Questions and Chris's decisions (2026-10-31)

1. **Current vs. folders: one place or two?** _Decided: one place._ A filed thread lives in its
   folder and leaves `Current` (TF6). Bookmark semantics (also listed in `Current`) are rejected.
2. **Archived as its own tree node?** _Decided: yes, a built-in node that stays collapsed inside
   `Current`._ Chris said first "a third built-in node", then "Archived stays collapsed inside
   Current"; the spec reads both together as a child node of `Current`, folded by default (TF7).
   The Archived group leaves `Current`'s list and the folders (TF6).
3. **Nesting depth 3** (TF1) or flat folders? _Decided: 3._
4. **Forks inherit the folder.** _Decided: a fork inherits its parent's folder_, whoever owns the
   parent (TF9).
5. **Who sees folders; can shared threads be filed?** _Decided: folders are visible to all members
   of the workspace (team), and read-only shared threads can be filed since every member sees all
   folders_ (TF1, TF3, TF5). Consequence taken in the spec: folder changes and filing are audited
   (TF11), any member may create, rename, move and delete folders (TF4), and each member sees in a
   folder only the threads they may read (TF5).
6. **The strip replaces the "Forked from … at …" note** (TL3), keeping the excerpt on the current
   row. _Decided: replace._

## 8. Implementation tickets (filed 2026-11-01 as KOBE-532..537)

Order: TLF-1 → TLF-2 and TLF-3 in parallel → TLF-4 → TLF-5 → TLF-6. The protocol PR goes first on
its own. One generated migration plus one custom SQL migration (TLF-3), with upgrade tests; the
cross-team probe suite must stay green. Two lanes (the cap): lineage (TLF-2 then TLF-4) and
folders (TLF-3 then TLF-5).

**TLF-1. Protocol shapes (`packages/protocol`).** `threadLineageResponseSchema` and constants
(TL9); `folder_id` on `threadOrganizationSchema`; `threadFolderSchema`, `threadFoldersResponseSchema`,
`createThreadFolderRequestSchema`, `updateThreadFolderRequestSchema`, `fileThreadRequestSchema`;
`folder` on `listThreadsQuerySchema`; the new error codes.

- ac-1: every new schema is strict, has tests for valid, absent-optional and refused shapes, and
  old thread summaries without `folder_id` still parse (additive).

**TLF-2. Lineage read (server).** `GET /v1/threads/{id}/lineage` (TL1, TL2): the walk, the one
forks query, the readable predicate shared with `forked_from_title`, caps, Trash handling.

- ac-1: a three-generation family with two forks at one level answers root-first ancestors with
  the right siblings, `self` with its fork point, and `forks` of the asked thread (db test).
- ac-2: an ancestor the viewer cannot read stops the chain with `root_hidden: true` and reveals
  neither id nor title; a purged ancestor leaves the chain shorter with no flag (db test).
- ac-3: a reader under D23 (shared thread) gets the lineage of what they may read only; a
  stranger gets 404 `thread_not_found`; test, Workbench and eval threads never appear.
- ac-4: a thread in Trash is listed for its owner with `deleted_at`, not for anyone else.
- ac-5: caps: depth 20, 50 siblings with `more: true`; the whole read is one transaction, two
  queries plus the walk.

**TLF-3. Folders (db, server).** `thread_folders` table, RLS, trigger, `threads.folder_id` with
key and index (TF1, TF2); `lockForFiling` and the file route (TF3); folder routes with their
audit events (TF4, TF11); list parameter and per-viewer counts (TF5); `folder_id` in every
reader's summary; fork inheritance, Restore and Unarchive (TF9); export metadata (TF9); probe
suite rows; `docs/audit-log.md` rows.

- ac-1: any member creates, renames, moves and deletes folders with the stated errors; depth 4 and
  a cycle are refused by the trigger even through direct SQL (db test); the 501st folder is
  refused; each change is audited with the actor.
- ac-2: filing by the owner and by a D23/CE20 reader works, is idempotent, is refused in Trash, on
  test threads and for a stranger (404), keeps pin, archive, project and shares; `null` unfiles;
  `thread.filed` is recorded on a change only.
- ac-3: deleting a folder nulls its threads' `folder_id` and cascades to subfolders; Trash and
  archive keep the folder and Restore/Unarchive return there; a fork inherits its source's folder
  whoever owns the source.
- ac-4: `GET /v1/threads?folder=<id>` returns the caller's own threads of the folder plus others'
  shared with them and nothing else (another member's private filed thread never appears); the
  folder counts match that list; `?folder=none` and `/pinned?folder=` page correctly.
- ac-5: cross-team probe suite green (folders, filing and counts never cross a team); migration
  upgrade test passes on a populated database.
- ac-6: the export's thread metadata carries the folder path.

**TLF-4. Lineage strip (web).** `LineageStrip` replaces `ForkOriginNote` (TL3, TL4): rows,
dropdowns, fold, hidden root, In Trash, phone line, re-reads on open/fork/focus.

- ac-1: component tests for a plain fork (two rows), a family with siblings (dropdown "2 of 3"),
  forks of the current thread ("2 forks ▾"), hidden root, purged root, fold at five generations,
  In Trash suffix, phone line.
- ac-2: links open in place through `OpenThreadContext`; a modified click keeps the browser's.
- ac-3: an ordinary thread renders nothing; a failed read renders nothing and retries on focus.
- ac-4: after Fork, the new thread's strip shows the source above it without a reload.
- ac-5: `role="navigation"` "Thread lineage"; keyboard through every link and menu.

**TLF-5. Threads panel with two rails (web).** The tree, nodes and actions (TF7), Save to
folder in the row menu, header menu and palette, drag onto nodes (TF8), folder views (TF6),
search notes (TF10), phone dropdown, the adapter's folder lists, announcements.

- ac-1: component tests: tree order (Current with Archived folded under it, folders, Deleted) and
  counts; choosing a folder shows only its unarchived threads in the standard groups, Shared with
  me included; `Current` excludes filed and archived threads; `Archived` lists every archived
  thread with its folder path and Unarchive returns it to its folder; `Deleted` is today's Trash
  behaviour.
- ac-2: new folder (inline name), rename, move, delete with confirm; errors shown inline
  (`folder_name_taken`, depth).
- ac-3: Save to folder from the row menu (own and shared rows), the header menu and drag onto a
  node; Remove from folder; the polite announcement; the tree re-reads on focus so another
  member's folder appears.
- ac-4: under 820 px the tree is the dropdown; everything reachable.
- ac-5: panel search finds filed threads and shows their folder path; choosing a hit closes the
  panel onto it as today.
- ac-6: the chosen node is remembered while the tab lives, not stored.

**TLF-6. Browser check and ledger.** `e2e/browser/tests/thread-folders.spec.ts` (create a folder,
file a thread from the row menu, see it under the folder and gone from Current, delete the folder
and see it back; as the second test member, see the folder and file a thread shared with them)
and `thread-lineage.spec.ts` (fork twice, see three rows, switch by the link and by the dropdown)
against gate1; `docs/RUN-LEDGER.md` entry.

- ac-1: both specs pass against gate1 in the suite shard, with cleanup in `finally`.
- ac-2: `pnpm verify` and the db suites pass; `pnpm license:check` unchanged (no new
  dependency: Radix and lucide are already in).

## 9. Out of scope

- Personal (private) folders; folders on projects; per-member folder permissions or a folder owner.
- Resizable tree width; folder colours or icons; folder search.
- A graph view of a fork family; lineage in the panel rows (TL8).
- Pi-level fork bridging (unchanged since KOBE-215).
