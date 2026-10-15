# KOBE-284: k3d e2e: fork to a new thread at a chosen message with a title (Gate B ac-2)

- **Status:** committed on `group-1-fixes` (ticket group G1; no PR of its own).
  **The k3d run is still to be proven at G1's CI** (no k3d outside CI).
- **Branch / worktree:** `group-1-fixes` in `../Kobe-g1`
- **Depends on:** KOBE-216 (fork at an entry with a title), KOBE-164 (projects e2e section)

## Plan

New section `==> fork at a message (KOBE-284)` in `e2e/run.sh`, right after the KOBE-164
projects section (which covers `POST /v1/threads/{id}/fork` only via sharing). It runs in the
same shards: `suite` (and `executor`, which is `suite` with the tool executor; and `all`). Same
style: a `FORK_JS` node script run in the server pod (`fork_js fork|after …`), `chat_run` for
the real runs, `contains` on `key=value` lines, here-strings instead of `printf | grep` pipes.

1. `chat_run` twice: the Owner's private thread gets two exchanges (`fork-first-…`, `fork-second-…`).
2. `fork_js fork`: picks the first exchange's assistant entry (the middle), forks at it with a
   title, asserts title, history = source path up to that entry, leaf and last entry = chosen,
   the second exchange absent, `forked_from_thread_id`/`forked_at_entry_id`/`forked_from_title`,
   the source unchanged (entry count, leaf, title, not a fork), and the reader (team member, no
   access to the private source) refused `404 thread_not_found`.
3. `chat_run "history?"` on the fork: run completes; the model was given the copied first
   exchange and not the second.
4. `fork_js after`: the fork's new entry hangs off the chosen entry; the source is still unchanged.

## Decisions

- **Fake model `history?` echo** (`services/model-gateway/src/testing/fake-llm.ts`): nothing in the
  suite proved what conversation the model received (only `system?`, `tools?`, the last user
  text), so the fake now answers `history?` with the earlier user/assistant texts
  (`role: text`, `|` joined). Unit tests in `fake-llm.test.ts`. The fake ships in the
  model-gateway image, so CI's build carries it.
- The access refusal uses a non-project private thread (the reader is a team member, not its
  owner): `fork.ts` `planFork` answers `thread_not_found` when `findThread` sees nothing.

## Grounding of each assertion (server tests)

| e2e assertion                                    | server test                                                                                                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fork with `{entry_id, title}` → 201 `thread_id`  | `thread-fork.db.test.ts` "copies the entries up to the chosen message…"; `thread-sharing.db.test.ts` "forks up to an entry, with a new title"                                                |
| title, `leaf_entry_id` = chosen, path ends there | same two tests (`title`, `leaf_entry_id`, `entryIds`)                                                                                                                                        |
| provenance incl. `forked_from_title`             | `thread-fork.db.test.ts` (`forked_from_thread_id`, `forked_at_entry_id`, `forked_from_title`)                                                                                                |
| source unchanged                                 | `thread-fork.db.test.ts` "…the source is untouched" (leaf, not a fork, entry count)                                                                                                          |
| first run continues from the copied history      | `thread-fork.db.test.ts` "forks with no sandbox running, then runs on the copied session" (Pi session rebuilt; new user entry's parent = fork point)                                         |
| non-viewer refused 404                           | `thread-sharing.db.test.ts` "not shared yet" and outsider 404 (status only); the `thread_not_found` code is from `fork.ts` `planFork` + the route's error map, not asserted by a server test |

## Evidence

- `bash -n e2e/run.sh` passes; shellcheck is not installed locally.
- `FORK_JS` extracted and `node --check`ed; dry-run against a local mock of the four routes it
  calls: every line came out as the assertions expect.
- `pnpm --filter @kobe/model-gateway exec vitest run src/fake-llm.test.ts`: 13 passed (the two
  new history-echo tests failed first).
- k3d: **pending, proven at G1's CI.**
