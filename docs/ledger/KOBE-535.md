# KOBE-535: Threads: Lineage strip (web) (TLF-4)

- **Status:** in review (coordinator opens the PR)
- **Branch / worktree:** `kobe-535-lineage-strip` in `../Kobe-wt535`
- **Depends on:** KOBE-532 (protocol), KOBE-533 (`GET /v1/threads/{id}/lineage`)

## Plan

`LineageStrip` replaces `ForkOriginNote` (TL3, TL4), apps/web only:

- `lib/chat/lineage.ts`: pure parts (rows, fold, labels, phone family, In Trash) and
  `readThreadLineage` (raw fetch + `threadLineageResponseSchema`, wire casing like the context
  viewer; never throws, null on failure). `ChatApi.threadLineage` wraps it.
- `lib/chat/use-lineage.ts`: the TL4 triggers (open, `session.onThreadCreated` = fork success,
  `session.onThreadTrashChanged` = Trash/restore/Delete forever from the panel, window focus when
  the last read is >= 60 s old or failed). Never stored; late answers dropped.
- `components/chat/lineage-strip.tsx`: `LineageStripView` (pure render) and `LineageStrip`
  (session, `OpenThreadContext`, `useShellBand`). `thread-view.tsx` wraps it in the
  `OpenThreadContext` provider. `fork-origin.tsx` removed; `forkHint` stays.

## Decisions

- **When the strip shows:** `ancestors` or `forks` non-empty, or `root_hidden` (the hidden row
  is an ancestor the viewer can't open). A fork whose only source was purged shows nothing (TL3:
  "purged root: nothing extra"; the old note said "Forked from a thread you can't open").
- **Excerpt length:** `forkPointExcerpt` takes an optional max; the strip passes 48 (TL3), the
  default stays 80.
- **Fold:** more than 4 ancestor rows → root, "… n more", parent, self (5 ancestors → "… 3 more").
  The hidden row is not counted.
- **Self with siblings:** the bold self row becomes the siblings dropdown (diagram in TL3); picking
  the checked one does nothing.
- **Phone line:** under 820 px = shell bands `overlay`/`single`. Label "Forked thread · N
  related"; a non-fork with forks reads "Thread with forks · N related" (spec names only the fork
  case). N counts every other listed thread (siblings included), "+" when any list was cut. Items
  are `menuitemcheckbox`, checked along the path; the hidden root is a disabled item.
- **Trash signal:** new `ChatSession.onThreadTrashChanged`/`threadTrashChanged`, fired by the
  list adapter's archive/unarchive/delete (= Trash, restore, Delete forever) after success.
- `UNTITLED_THREAD` exported from `lib/chat/fork.ts` (no shared constant existed).
- No Storybook in apps/web, so no story.
- Menus are controlled Radix `DropdownMenu`s so the portal resolves the chat root on open.

## Open questions (for Chris or the coordinator)

- Phone label for a non-fork with forks ("Thread with forks") is my wording.

## Evidence (acceptance criteria → test or command output)

- ac-1: `components/chat/lineage-strip.test.tsx` "the rows (ac-1)" (plain fork, "2 of 3",
  50+, "2 forks"/"1 fork:", hidden root, purged root, fold at five, In Trash, phone line, text
  only); `lib/chat/lineage.test.ts`.
- ac-2: "opening threads (ac-2)" (OpenThreadContext; modified/middle click not prevented);
  `fork-thread.test.tsx` link opens the source in the app.
- ac-3: "when there is nothing to show (ac-3)" (ordinary thread; failed read, retry on focus).
- ac-4: "when it reads (ac-4, TL4)" hook triggers; `fork-thread.test.tsx` "asks for a title,
  forks…" shows the source in the new thread's strip with no reload; adapter test counts the
  trash signals.
- ac-5: "accessibility (ac-5)": navigation "Thread lineage", Tab through link and menu buttons,
  Enter/arrows/Escape in menus.
