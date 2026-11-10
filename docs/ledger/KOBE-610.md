# KOBE-610: TFM-1: thread_file_links: record which workspace files a thread read or wrote

- **Status:** done in branch (group `thread-file-map`), not pushed
- **Branch / worktree:** `kobe-610-thread-file-links` in `../Kobe-wt610`
- **Spec:** `docs/specs/thread-file-map.md` (TFM1–TFM7, final)

## What

- **Table** `thread_file_links` (`packages/db/src/schema/thread-file-links.ts`, area
  `tenancy/conversations.ts`, probe fixture in `probe-fixtures/conversations.ts`). Migrations
  `0205_thread_file_links` (generated) and `0206_thread_file_links_rls` (custom: ENABLE + FORCE
  RLS, `team_isolation` policy, triggers). One row per (thread, owner | project, path, access),
  `UNIQUE NULLS NOT DISTINCT`; exactly one of `owner_user_id` / `project_id`; `first_at`,
  `last_at`, `count`, `deleted_at`. Cascades with its thread and with a project.
- **Recording (server only, TFM2)** — `services/server/src/thread-file-links/`:
  - Policy decision (`sandbox-wire/policy-check.ts`, `recordFileLink`): after an `allow` (rule or
    approval), not for skill eval runs or MCP tools. Tools (`paths.ts LINK_TOOLS`): read, ls,
    find, grep, share_file, open_file, propose_file_edit = read; write, edit, run_python (path) =
    write. Path canonicalised as the policy does (`canonicalPath`), must be under `/workspace/`,
    `.kobe/` ignored, the root ignored (ls/find/grep without a path). Best effort (logged).
  - `projects/<slug>/<file>` resolves to the project (`project_id`, path inside it), so a slug
    rename keeps links and project readers see them (TFM7); unknown slug or the bare folder = none.
  - Attachments: `uploads/attach.ts` commit, same transaction, `write` (the message put the file
    into the workspace).
  - Project commits from a thread: `projects/tree.ts writeCommit` (covers `commit_project` and
    accepted proposals, `from-proposal.ts`), every changed path as `write`.
  - A link to a path that does not exist yet (not pushed) is marked deleted; the file's arrival
    clears the mark (trigger).
- **Moves and deletes** are SQL triggers (every writer covered: sandbox push, browser, server
  moves): `workspace_files` tombstone with `moved_to` → path rewritten (merging into an existing
  row); plain tombstone → `deleted_at`; live row → mark cleared; `workspace_moves` insert (dir) →
  prefix rewrite incl. links to the folder itself; `project_files` delete/insert → mark/clear
  (skipped while the project itself is being deleted).
- **Backfill (TFM3)** — `thread-file-links/backfill.ts`, CLI `dist/cli/thread-file-links-backfill.js`
  (`[--restart] [--max <threads>] [--pace-ms <ms>]`). Sources: entries' toolCall/toolResult (a call
  counts only with a non-error result; offloaded entries skipped), attachments, project commits
  (diff against parent). Idempotent (counts merge with GREATEST), resumable (cursor
  `site_settings` key `thread_file_links.backfill`, written in each thread's transaction; `done`
  at the end). Eval threads skipped.

## Running the backfill on gate1

After the deploy (release `kobe` in the gate namespace, see `CLAUDE.local.md`):
`sudo k3s kubectl -n <gate namespace> exec deploy/kobe-server -- node dist/cli/thread-file-links-backfill.js`
→ one JSON line; exit 1 means `--max` stopped it (run again). Documented in `docs/install.md`
upgrade notes.

## Decisions

- Attachments are `write` (the thread's message created the file in the workspace).
- `share_file`, `open_file`, `propose_file_edit` count as reads; `run_python` with a path as write.
- ls/find/grep link the folder they name; folder links follow folder moves, but a folder whose
  files are deleted one by one is not marked deleted (only marked at record time).
- Accepted workspace (non-project) `propose_file_edit` proposals are saved by the editor with no
  thread attribution, so only the proposal itself (read) is linked.
- Forks do not copy links.

## Open questions

- None blocking.

## Evidence

- ac-1: `packages/db/src/thread-file-links-upgrade.db.test.ts` (upgrade over populated DB, RLS,
  checks, triggers) 7/7; `probe.db.test.ts` 756/756; `migrate.db.test.ts` 5/5; db unit 803/803.
- ac-2: `services/server/src/thread-file-links.db.test.ts` (policy decision: read/write/ls, bash,
  outside path, denied, project mount; project commit) ; `runs-attachments.db.test.ts` (attachment
  link); `thread-file-links/paths.test.ts` (unit). Related suites (workspace move/sync/files,
  project commits/proposals/mounts, policy, sandbox-wire, offboarding, retention, legal hold)
  21 files / 322 tests green.
- ac-3: backfill test in `thread-file-links.db.test.ts` (resume with `--max`, cursor `done`,
  restart changes nothing).
