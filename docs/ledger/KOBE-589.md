# KOBE-589: PC-2 Conversation title "<Project> / <conversation name>" with a project menu

- **Status:** in review (commits on branch, not pushed)
- **Branch / worktree:** `kobe-589-project-title` in `../Kobe-wt589`
- **Depends on:** KOBE-588 (PR #509, not merged): builds on its draft header and hooks

## Plan

Spec `docs/specs/projects-in-conversations.md` §4 TT1-TT4. Web only.

## Decisions

- TT1: `ThreadTitle` (`components/chat/thread-title.tsx`) takes the project id from
  `state.summary.projectId` and its name from `useProjectName` (an alias of the draft's lookup:
  live list, then `GET /v1/projects/{id}`). The heading reads "<Project> / <name>" (project in
  `text-muted-foreground`); until the name is known the title is the bare name. Untitled fallback
  and no-project conversations are unchanged.
- TT2: `project-title-menu.tsx`: a Radix DropdownMenu on the project button (accessible name
  "Project <name>", tooltip the full name, `max-w-[40%]`, shrinks before the name which also
  truncates). Items: Open project (a `Link` to `/me/projects/{id}`), Move to project… (submenu of
  the other projects) and Move out of the project. The moves are NOT a second copy: the menu calls
  `useOrganizeMenu` (the thread menu's hook) and reads its `move-thread` binding (choices, busy
  rule, the same `POST /v1/threads/{id}/move`). `OrganizeMenuInput.onMoved` (new, optional)
  makes the header read the summary again, so the title follows. A refusal shows as a
  `role=alert` beside the button. Rename button keeps "Rename <title>"; its tooltip is now
  "<title> (click to rename)" so it carries the full name.
- Unavailable moves (a run going, projects loading) stay focusable with their reason, like the row
  menu. The projects load when the menu opens, so Move items read "loading" briefly.
- TT3: only `renameable` titles (owner, saved, not Trash, in the chat shell) get the menu; shared
  readers, Trash and the builder's test pane see the text.
- TT4: `use-document-title.ts` sets `document.title` to the header text while a created
  conversation is open (exactly TT1, no "Kobe" suffix), keeps the hidden-tab activity prefix of
  `useTabTitle`, and restores the previous title on close. Threads panel rows are untouched.
- `ProjectBar`'s open-project icon is removed (the title's menu has Open project); the sharing
  controls stay. The `open-project` command stays in the registry, now unused in the UI.

## Tests

`components/chat/thread-project-title.test.tsx` (12): format, Untitled, no project, tab title,
tooltips and 40%, Open project href, Move out, Move to project… (keyboard in the submenu: happy-dom
has no layout for Radix's grace area), full keyboard run of the menu, refusal, shared reader, Trash.

## Open

- Tab title without a suffix: say if "<title> - Kobe" is wanted.
