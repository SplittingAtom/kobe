# KOBE-580: Workspaces WS-5: sandbox agent — checkouts in sync, commit_project, project access line

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (coordinator pushes and opens the PR)
- **Branch / worktree:** `kobe-580-sandbox-checkouts` in `../Kobe-wt580`
- **Depends on:** KOBE-576 (protocol, merged). Server side of the frames: KOBE-579.

## Plan

Sandbox agent only (`services/sandbox-agent`); the server is faked in tests (fake wire server,
`FakeSyncServer` taught `checkouts` and the checkout-only push rule).

## What changed

- **Sync (CM4)** `workspace/sync.ts`, `workspace/fs.ts`: the pull's `checkouts` (last page wins,
  default `[]`) is the set of writable `projects/<slug>/` folders. `isLockedPath(path, checkouts)`
  replaces `isServerOwnedPath` everywhere in sync (scan, push, pushPath, restore, pull, resync,
  modes). `WORKSPACE_SERVER_OWNED_PREFIXES` unchanged. On a new slug: `unlockCheckout` (dirs 0775,
  files 0664, 0775 when the manifest row is executable). On a slug that left: `relockCheckout`
  (group write off top down, returns entries the agent cannot lock), then each foreign entry is
  removed (a tool-owned file at a path the server knows) or moved to `kobe-moved/` (anything
  else), then the pull's rows apply with the read-only rule, `#revertFolder` brings unpushed
  local edits/new files back to the head, and `lockServerOwned(..., keep=checkouts)` locks it.
  `lockServerOwned` skips checked-out slugs; `ensureParents`/`writeFileAtomic`/`removeFile`/
  `pruneEmptyParents` take the checkout set (folders inside a checkout are 0775, `projects/`
  itself stays the agent's 0555/0755). Restore recomputes everything from the pull (relocks every
  local project folder not listed, unlocks every listed one): survives hibernation, nothing stored.
  `WorkspaceSync.pushAll()` = full push for the commit (fails when sync is off or not restored).
- **`commit_project` (CM6)** `kobe-tools/project-commit-tool.ts` (+ `protocol.ts`, `client.ts`,
  `project-reply.ts`), agent side `tools/project-commit-broker.ts`, wired in `agent.ts`
  (`project.commit` request, `project.commit_result` frame, failRun/failThread/failAll). Path:
  kobe-policy `policy.check` (generic, unchanged) → kobe-tools `project.commit` on fd 4 →
  `pushAll()` → frame `project.commit {request_id, run_id, thread_id, tool_call_id, tool, input}`
  → result relayed. Texts: `Committed as #<seq>.`; conflict: "moved on to #<head_seq> … Ask the
  user to Update …, then commit again"; `Nothing to commit…`; `Awaiting approval…`. Server
  refusals (`ok:false`) become `code: message` tool errors (D32 relayed as is). One commit per
  thread in flight; 5 min tool timeout (the push can be large). `propose_project_file` untouched.
- **Registration**: registered with the `projects` capability, but listed to the model only in
  runs with `run.start.project.access === "write"`: the per-run memory file gains
  `project_write` (from `memoryRunFileContent`), and `registerProjectHooks` toggles the tool on
  every `input` (same mechanism as `remember`/`recall`). Absent/malformed field or file = not
  listed. Without Pi's active-tools API the tool is not registered at all (fail closed).
- **Access line (PR3)** `memory/project-context.ts` `projectAccessLine`: write → `You can edit
project "X"; commit with commit_project. …`; read or absent → `You can read project "X" but not
change it: …`. Part of the project block, which is now emitted for every project run (also
  without instructions: "Its admins wrote no instructions."). `context/system-prompt.ts` needed
  no change (the block keeps `PROJECT_HEADER`).

## Review fixes (coordinator, 2026-11-08)

- Unlock, relock and `lockServerOwned` walk with `walkOwned` (fs.ts): every folder opened
  `O_NOFOLLOW` through its held parent and entered only if the agent's own; files changed only
  through `shareOnVolume` (no-follow, uid check). Unlock is bottom up (slug folder last), relock
  top down (write bit off before listing). Links and other uids' entries are never followed or
  changed (tests: link planted inside a checkout, slug folder swapped for a link).
- The agent refuses `project.commit` unless that run's `run.start.project.access` was `write`
  (`ProjectCommitBroker.canCommit`, set from `run.start`, cleared at run end), before any push.
- `commit_project` is listed through the per-run memory file, so it is offered only when the
  agent has that file (kobe-tools with `memory`, which every agent with the tools channel
  announces); without the file it is never listed (fails closed). Same as project instructions.
- Split: checkout walks and bookkeeping moved to `workspace/checkouts.ts` (`unlockCheckout`,
  `relockCheckout`, `applyCheckouts`); path helpers stay in fs.ts. `sync.ts` is still ~1180
  lines (was 1061 before this ticket); the rest of the growth is the read-only revert helpers
  and `pushAll`, no further clean cut without moving restore/pull logic.

## Decisions (spec silent; smallest consistent reading)

- "Registered only with access write": Pi registers tools at start, access is per run (a member
  can be promoted mid-thread), so the tool is registered once and **activated per run**; a
  reader's run neither lists it nor can call it (real-pi test: no `policy.check`, no frame).
- Files the server never had, left in an ended checkout (unpushed new files, a tool's folder),
  are moved to `kobe-moved/projects/<slug>/…` like every other non-server file in a read-only
  area ("never lost"); unpushed edits of known files are overwritten by the head (Discard).
- A tool-made **folder** in an ended checkout is moved out whole (the agent cannot chmod it);
  files in it that were pushed and then discarded therefore reappear under `kobe-moved/`.
  Accepted: no data loss, never writable inside `projects/`.
- If the agent cannot move a foreign entry (a tool made a folder 0700, so the rename needs write
  on it), it is logged and stays; it is still never pushed (server: `read_only`) and is retried
  at the next relock/restore. Under the pod's umask 002 this does not happen.
- `pending_approval` is a success answer (not an error), like `propose_project_file`'s.
- The tool sends the model's message unchanged (the server's schema trims); the policy check and
  the frame carry the same input.

## Open for 579 / 581 / 582

- **579 (server) must:**
  - answer every `GET manifest` page with `checkouts: [{project_id, slug, base_commit_seq}]`
    for the caller's (team, user), the same list on every page of one pull; a slug missing from a
    pull = ended (the agent relocks at once).
  - accept pushes into `projects/<slug>/…` only while that slug is in the caller's checkouts,
    `rejected read_only` otherwise (the agent relies on it after a stale push).
  - on Discard write the head back as **new rows** (origin `server`) for every path the member
    changed, tombstones for the member's new paths, and drop the checkout; on Update write the
    head's versions as new rows (the agent applies them with the free-area conflict rule).
  - handle frame `project.commit` (schema `projectCommitFrameSchema`; capability `projects`):
    the project is the thread's, `input.message` only; answer exactly one
    `project.commit_result` for the same `request_id`: ok `{op:"project_commit", outcome}` or
    `{ok:false, error:{code, message}}` (D32 refusal, not a member, no checkout, quota: the
    message is shown to the model verbatim). The agent pushed before sending; diff the manifest.
  - set `run.start.project.access` (`write` for editor+, `read` otherwise); absent reads as read.
  - policy: `commit_project` reaches the server first as an ordinary `policy.check`
    (`BUILTIN_TOOLS` entry from 576: kobe, write, `/message`).
- **581 (web):** nothing from the sandbox; a checkout's files become 0664 within one pull.
- **582:** remove `propose_project_file` (tool, broker, reply parser, protocol mirror); keep
  `registerProjectHooks` for `commit_project`.

## Open questions (for Chris or the coordinator)

- none blocking.

## Evidence (acceptance criteria → test or command output)

- ac-1: `src/kobe-tools.project-commit.real-pi.test.ts` "ac-1: writes in a checkout are pushed,
  a read-only project refuses them (EACCES), and an ended checkout is relocked to the head";
  by uid under Pi identities: `src/workspace/projects.readonly.real.test.ts` (KOBE-580 case, run
  by `scripts/test-identities.sh`); sync bookkeeping: `src/workspace/checkouts.test.ts`
  (restore, unlock on pull, Update, relock + head, hibernation, stale push, fs modes).
- ac-2: same real-pi file: access write lists the tool and the edit line, read lists neither and
  says "can read … but not change it"; a reader's call never reaches policy or the server; a
  denied `policy.check` → `policy.denied: <reason>`; allowed → push then `project.commit`, answers
  relayed (committed, commit_conflict, D32 refusal). Units: `kobe-tools/project-commit-tool.test.ts`,
  `kobe-tools/memory-hooks.test.ts` (registerProjectHooks), `tools/project-commit-broker.test.ts`,
  `memory/project-context.test.ts`.
- `pnpm --filter @kobe/sandbox-agent test`: 1189 passed, 67 skipped; the 2 failures
  (`models/runtime-dir.test.ts`) come from `TMPDIR=$HOME/tmp` (non-sticky parent) and pass with
  the default TMPDIR. Real-pi suites ran (Pi installed via `npm ci --prefix images/sandbox/pi`).
- `pnpm --filter @kobe/sandbox-agent lint`: clean; `pnpm typecheck` (turbo, concurrency 1): 26/26;
  prettier: clean.
- `scripts/test-identities.sh` could not run here: the real kobe-runas helper refuses on this
  VM ("a process can ptrace … its parent", no Yama ptrace protection), and every identity suite
  fails the same way before any test body runs. The new KOBE-580 uid case runs in CI's
  identities job (same file, same setup as the KOBE-162 cases).
