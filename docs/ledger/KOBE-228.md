# KOBE-228: executor off: Pi gets a private HOME and TMPDIR per thread (interim fix)

- **Status:** in review
- **Branch / worktree:** `kobe-228-shared-pi-home` in `../Kobe-wt228`
- **Depends on:** KOBE-196 (PR #178). Real fix: the executor on everywhere (KOBE-168).

## Plan

Executor stays default OFF (user decision). Reuse KOBE-196's private directories for the flag-off path.

## Decisions

- **`preparePiPrivateDirs`** (`threads/exec-wiring.ts`) now runs for every Pi, with `partner: false` when
  there is no executor: `<scratch>/kobe-pi-<random runtime name>/{home,tmp}`, agent-owned, group = the
  Pi's own gid, mode **2770** (no other uid and not the workspace group can enter; the name is the
  runtime dir's `mkdtemp` random suffix). Without any identity (dev, no uid separation): 0700.
  Executor on: unchanged (2755/2770/2775). Removal, spawn-failure cleanup and the start-up sweep are
  the same code as KOBE-196 (identity-less case now removes it in `#reclaim`).
- **Tools keep the shared HOME/TMPDIR.** Without the executor tools are Pi's children and inherit its
  env, so the agent passes `KOBE_TOOL_HOME`/`KOBE_TOOL_TMPDIR` and the root-owned BASH_ENV script
  (`images/sandbox/egress-env.sh`) exports them as `HOME`/`TMPDIR` for every bash tool call (absolute
  paths of `[A-Za-z0-9._/-]` only; anything else is ignored). Tested in `egress-wiring.test.ts`.
- **Provider SDK loading** needs nothing more: Node's `$HOME/.node_modules` fallback follows Pi's HOME;
  `NODE_PATH` is not in the allow-listed env (pinned by `pi-launch.test.ts`); jiti/compile caches are
  already off (KOBE-196).
- The shared-HOME `/workspace` and user files are unchanged; `~` in Pi's own file tools now resolves to
  Pi's private home (they have `KOBE_EXEC_TOOL_HOME` mapping only with the executor).

## What the interim fix prevents, and what it does not (same uid)

Prevents (paired or unpaired identities, executor off): a tool of thread A, a different uid with a
different gid, cannot create, write or read thread B's Pi HOME/TMPDIR, so nothing it plants in the
shared `~/.node_modules` (or anywhere reachable) is loaded by B's Pi. Both ends are checked: the plant
is refused (`Permission denied`) and B's Pi HOME is not the shared one.

Does not prevent:

- A tool of the **same** thread runs as Pi's uid and can write that Pi's own HOME/TMPDIR (find them via
  `/proc/<pi>/environ`, `ls /tmp`). The private dir is only unguessable, not unreachable, for the same
  uid. Plant in the current Pi's HOME only runs in a later load by that same Pi (same thread).
- No identities (dev, no uid separation): every thread is one uid, so 0700 only hides the path.
- Without egress (outside Kobe's pods, no BASH_ENV) tools see Pi's private HOME.
- Non-bash tool code in Pi (read/edit/write) resolves `~` against Pi's private home.
- `auth.json`/`!command` from #161 (same uid, no escalation) and session JSONL remain as before.

The real fix is the executor (KOBE-168): tools run as the partner uid and cannot write Pi's dirs.

## Open questions

- Should the BASH_ENV script be set even without egress, so tools always get the shared HOME?

## Evidence

- ac-1: `identities.real.test.ts` ("a tool of thread A cannot plant ~/.node_modules in thread B's Pi
  HOME ...", real helper, Linux CI step `scripts/test-identities.sh`); modes in the same file and in
  `threads/exec-wiring.test.ts`; load behaviour of a private HOME: `exec.load-paths.real.test.ts`
  (`$HOME/.node_modules` control vs private HOME, KOBE-196).
