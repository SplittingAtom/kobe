# KOBE-542: Tree: Protocol shapes (`packages/protocol`) (CT-1)

- **Status:** in review (local commits; not pushed)
- **Branch / worktree:** `kobe-542-tree-protocol` in `../Kobe-wt542`
- **Depends on:** none (spec docs/specs/conversation-tree.md CT2, CT3, CT9, CT11-CT13, CT20)

## Plan

Additive shapes only, tests first: `threads.ts` (labels, branches read, leaf rate, card branches,
branch summary request and errors), `events.ts` (`thread.updated.leaf_entry_id`),
`sandbox-wire/frames.ts` (`thread.branch_summary`).

## Decisions

- **Labels** reuse the folder-name character rule (`FOLDER_NAME_REFUSED_CHARS`: C0, DEL, line and
  paragraph separators, bidi) with trim and 1-60 (`branchLabelSchema`). `setLabelBodySchema`
  `{label: branchLabelSchema | null}`; null removes. Error codes `entry_not_found` 404,
  `label_limit` 409 (added for CT9's 200 cap), `thread_in_trash` 409, `test_thread` 409.
- **`LEAF_RATE`** is `{windowMs: 600000, max: 120}`: the protocol has no rate constants, so it
  takes the server's `RateLimitRule` shape (`FORK_RATE`, `FOLDER_CREATE_RATE`) and is assignable
  to it.
- **Card branches:** `threadCardSchema` lives in `services/server/src/threads/schemas.ts`, not in
  the protocol. To stay in the protocol the ticket adds `threadCardBranchesSchema`
  `{branches?: 0..1000, branches_capped?: boolean}` (`THREAD_CARD_BRANCHES_MAX` 1000, CT12) for
  the server's card to spread in KOBE-543. Absent fields parse (old cards).
- **`thread.updated`** gains optional `leaf_entry_id` (idSchema); `title` stays required.
- **Run kind:** the run kind enum is `RUN_KINDS` in `@kobe/db` with a CHECK constraint, so adding
  `branch_summary` there needs a migration: left to KOBE-548. The protocol names it as
  `RUN_KIND_BRANCH_SUMMARY`.
- **Branch summary:** `branchSummaryRequestSchema` `{to_entry_id, focus?}`; focus is one line
  (folder-name rule, so no LF/CR/tab, unlike compaction's focus), not blank, at most 1000 (as
  compaction's). Codes and statuses: thread_busy 409, sandbox_unavailable 503,
  model_not_configured 409, nothing_to_summarize 409, summary_limit 409, summary_failed 502,
  read_only 403, test_thread 409, each with a fixed message (strict error body, as compaction's).
  `BRANCH_SUMMARIES_MAX` 20, `CAPABILITY_THREAD_BRANCH_SUMMARY` `thread_branch_summary`.
- **Wire command** `thread.branch_summary` `{command_id, thread_id, run_id, from_leaf_entry_id,
to_entry_id, focus?, model, model_limits?, run_token, trace?}`, strict, the compact frame's run
  context. Deliberately **not** in `serverToSandboxFrameSchema` (a test pins that): adding it
  means the db command-kind list, frame size entries, router and agent dispatch, which belong
  with its result frame and capability in KOBE-548 (and only if the KOBE-541 spike passes).
- No compile fallout outside `packages/protocol`.

## Open questions (for Chris or the coordinator)

- `thread.updated.title` is still required: a leaf move from the route must send the current
  title too (or KOBE-543 makes `title` optional, also additive). Untitled threads cannot send a
  leaf-only event under the current shape.
- Result frame `thread.branch_summary_result` and an HTTP response schema for the summary are
  left to KOBE-548.
- The label write rate (§5 table: 60 per 10 min) has no constant yet; add beside `LEAF_RATE` in KOBE-543.

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/protocol/src/threads.test.ts` (branch labels, branches response, leaf rate,
  card branches incl. old card, branch summary request and errors),
  `src/events.test.ts` ("thread.updated leaf_entry_id", old event parses),
  `src/sandbox-wire/branch-summary-frames.test.ts`. RED first (19 failing), then GREEN.
- ac-2: `pnpm --filter @kobe/protocol test` 59 files / 1115 tests pass; `pnpm build`,
  `pnpm typecheck`, `pnpm lint` green; `pnpm verify` green (see final commit).
