# KOBE-537: Threads: Browser check and ledger (TLF-6)

- **Status:** in review (coordinator runs the specs against gate1 and opens the PR)
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
- `thread-lineage.spec.ts`: source renamed, Fork A, back by the strip's link, Fork B from the same
  answer. On B: two rows (source link; B as the siblings dropdown "B · n of 2", B checked), the
  fork point excerpt. The source link opens it in place (`?thread=` changes, bold
  `aria-current` title); its "2 forks" dropdown lists both and opens A. The ticket text says
  "three rows"; the coordinator's brief (two forks of one source) gives two rows plus the forks
  row, which is what the spec checks.
- Screenshots (light/dark) of the panel after filing, attached to the report (`shoot`).

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- ac-1: not run here (no gate1 access from the worktree agent). Commands:
  `npx playwright test thread-folders` and `npx playwright test thread-lineage` in `e2e/browser`
  with `KOBE_BASE_URL`, `KOBE_USER`, `KOBE_PW` (and `KOBE_USER2`, `KOBE_PW2` for test 2).
- `tsc -p e2e/browser`, eslint and prettier clean on both files; `playwright test --list` lists 3
  tests.
- ac-2: `pnpm verify` passed (27 + 26 turbo tasks, license:check, hygiene, wording; db suites not run
  here: no `KOBE_TEST_DATABASE_URL`). Nothing failed between the panel and the strip; no
  dependency added.
