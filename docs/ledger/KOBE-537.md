# KOBE-537: Threads: Browser check and ledger (TLF-6)

- **Status:** done (PR #444 merged, main 688f4360; both specs passed on gate1 at `local-688f4360c7f5`)
- **Branch / worktree:** `kobe-537-browser-checks` in `../Kobe-wt537`
- **Depends on:** KOBE-535 (lineage strip), KOBE-536 (Threads panel with two rails)

## Plan

Two Playwright specs in `e2e/browser/tests`, written against the roles and names the components
and their unit tests use; `pnpm verify` once, since this branch carries the strip and the panel
together for the first time.

## Decisions

- `thread-folders.spec.ts`, test 1 (owner): `+ New folder` inline, Save to folder… from the row's
  ⋯ menu (waits for the item to stop being disabled while the folders load), checks the polite
  region's "Saved “…” to …", the row under the folder and gone from Current, then Delete in the
  folder's ⋯ menu with the inline confirmation; the row is back in Current.
- Test 2 (second member, skipped without `KOBE_USER2`/`KOBE_PW2`): the owner's folder is made
  through the API (the inline path is test 1's), the thread shared with the team from the row
  menu; the second member, in a fresh context, sees the folder at `/threads`, files the row from
  Shared with me, and finds it under the folder. Not in `e2e/gate5.sh`'s map, so a skip there is
  not judged NOTRUN.
- Clean-up in `finally`: unshare (`POST /v1/threads/{id}/share` private), folder deleted by name
  through `/v1/thread-folders`, second context closed; the `chat` fixture trashes threads.
- `thread-lineage.spec.ts` (three generations, per the coordinator): root renamed, forks A and B
  from the same answer, C forked from B. On C: three rows (root link; B as the siblings dropdown
  "B · n of 2"; C bold with "at “…”"). By the link: the root opens in place with "2 forks". By the
  dropdown: back to C (forks menu → B, "1 fork: C" link), B's dropdown → A opens in place. Clean-up
  in `finally` via `chat.trashAll()`, which now takes the ids off its list so the fixture does not
  trash them twice.
- Screenshots (light/dark) of the panel after filing, attached to the report (`shoot`).

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- ac-1 (coordinator, gate1 at `local-f5a5575c1486`, 2026-11-01): `thread-lineage` passed (three
  generations, switching by the link and by the dropdown); `thread-folders` test 2 (member2 sees the
  owner's folder and files the shared thread) passed; test 1 failed at its last step: after Delete,
  the thread did not come back to Current within 15 s. Cause in the web client, not the server:
  deleting a folder only refreshed the folder store, while the thread list is read again on a node
  change or a filing, so with Current already chosen the threads the server took back to Current
  stayed off screen until the next list read (the unit test deleted from the folder's own node, which
  changed the node). Fixed in this PR: `session.removeFolder` re-reads the list and tells the other
  tabs (`threads-folders.test.tsx` "deleting a folder while Current is chosen…" was red first).
  Re-run after the deploy of `local-688f4360c7f5` (2026-11-01): `thread-folders` (owner, second
  member) and `thread-lineage` passed, 4 passed in 1.0 min.
- Commands:
  `npx playwright test thread-folders` and `npx playwright test thread-lineage` in `e2e/browser`
  with `KOBE_BASE_URL`, `KOBE_USER`, `KOBE_PW` (and `KOBE_USER2`, `KOBE_PW2` for test 2).
- `tsc -p e2e/browser`, eslint and prettier clean on both files; `playwright test --list` lists 3
  tests.
- ac-2: `pnpm verify` passed (27 + 26 turbo tasks, license:check, hygiene, wording; db suites not run
  here: no `KOBE_TEST_DATABASE_URL`). Nothing failed between the panel and the strip; no
  dependency added.
