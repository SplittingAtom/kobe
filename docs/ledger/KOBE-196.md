# KOBE-196: Pi's HOME and TMPDIR private; nothing Pi loads is writable by the partner uid

- **Status:** in review
- **Branch / worktree:** `kobe-196-executor-tmp-home` in `../Kobe-wt167`
- **Depends on:** KOBE-167 (merged, PR #161). Source: isolation review of #161 (CRITICAL-1, MEDIUM-1, LOWs).
  The executor stays default OFF (chart `sandbox.toolExecutor.enabled: false`).

## Problem

Principle: nothing Pi reads or loads code from may be writable by the partner uid or any tool.
Pi and the executor shared `HOME` and `TMPDIR`. (a) Pi's jiti trusts a transpile cache in
`$TMPDIR/jiti` (name + hash of public source), and `kobe-reclaim` made a finished Pi's `/tmp` files
group 1000 writable, which every partner uid holds: a tool plants an entry, the next Pi runs it.
(b) Node's `$HOME/.node_modules` fallback: Pi's bundled provider SDKs `require` optional modules
(`bufferutil`, `supports-color`) inside try/catch; HOME is tool-writable.

## Decisions

- **Private dirs** (`threads/exec-wiring.ts preparePiPrivateDirs`, only when the executor is on under a
  pair): `<scratch>/kobe-pi-<runtime name>/{home,tmp}` on the pod's /tmp volume (the agent's `TMPDIR`),
  agent-owned with the Pi's group: root 2755, `home` 2770 (partner cannot even read it), `tmp` 2775
  (partner may read, never write: the bash tool's "Full output: /tmp/pi-bash-*.log" files must stay
  readable to the `read` tool). Pi gets these as `HOME`/`TMPDIR`. They are on the scratch volume, not the
  64 MiB runtime volume (review MEDIUM-1): bash full-output logs are unbounded and must not fill the volume
  that holds model files and egress tokens; /tmp is sized for tool output (`tmpSize`) and was already where
  they went. `/tmp` is sticky, so no other uid can rename or remove them. Removed on Pi exit _before_
  `kobe-reclaim` runs (it would otherwise open them to the workspace group), on spawn failure, and swept at
  agent start (`sweepPiPrivateDirs`).
- **`~` for the file tools** (review LOW-1): Pi resolves `~` against its own HOME, so kobe-exec is told the
  tools' home (`KOBE_EXEC_TOOL_HOME`, read once and removed) and maps paths under Pi's private home to it
  (`mapHome`, also for grep/find).
- **Executor keeps the shared HOME and TMPDIR** (user files, pip caches, scratch): built from the
  launch env before Pi's override.
- **Caches off for every Pi** (`pi-launch.ts`): `JITI_FS_CACHE=false` (jiti 2.7.0 env, checked in the `jiti`
  package Pi loads through `jiti-static-loader`; Pi's loader options cannot be changed) and `NODE_DISABLE_COMPILE_CACHE=1`
  (`enableCompileCache()` in the bundle). Also helps the flag-off path.
- **kobe-reclaim** deletes `jiti/` and `node-compile-cache/` that the uid owns at the top of each
  shared dir before opening the tree to the group (older Pis' leftovers); never chgrp/chmod them.
- **LOW-3**: `grep`, `find`, `ls` overrides are `defaultActive: false`, as in Pi, so the flag does not
  widen the model's toolset (the real-Pi test no longer expects `ls`).
- **LOW-6**: positive control in the same layout in `exec.real.test.ts` (Pi's uid can read what the
  partner cannot).

## Audit: what Pi reads or loads, and whether a tool uid can write it (flag on, pair)

| Path / mechanism                                                              | Writable by partner?       | Handled by                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------- |
| `$TMPDIR/jiti` (extension transpile cache)                                    | was yes (via reclaim)      | private TMPDIR, cache off, reclaim deletes                                                         |
| `$TMPDIR/node-compile-cache` (V8 code cache)                                  | was yes (via reclaim)      | private TMPDIR, `NODE_DISABLE_COMPILE_CACHE`                                                       |
| `$HOME/.node_modules` (CJS fallback)                                          | was yes                    | private HOME                                                                                       |
| `$HOME/.pi`, XDG dirs, npm/npx caches, `.cache`                               | was yes                    | private HOME (`PI_CODING_AGENT_DIR` is explicit; nothing runs npm)                                 |
| `PI_CODING_AGENT_DIR` (`agent/`, `mcp.json`, `settings.json`, `models.json`)  | no (KOBE-166/169)          | unchanged                                                                                          |
| Extension files (`-e`), Pi's `node_modules` (`/opt/pi`)                       | no (root-owned)            | unchanged                                                                                          |
| `NODE_PATH`                                                                   | not set (allow-listed env) | `pi-launch.test.ts` pins the env                                                                   |
| Project `.pi/`, `AGENTS.md`, skills, prompt templates, themes in `/workspace` | yes                        | not loaded: `--no-approve --no-context-files --no-skills ...`; skills are explicit root/agent dirs |
| `/workspace/.kobe/sessions` (session JSONL)                                   | yes (group)                | data, not code (KOBE-71 residual 4)                                                                |
| `PATH` entries (`/usr/local/bin`, `/usr/bin`, `/bin`)                         | no                         | unchanged                                                                                          |

## Tests

Unit (`pnpm test`): `threads/exec-wiring.test.ts` (modes/groups/refusal/sweep of the private dirs, `mapHome`),
`pi/kobe-reclaim.test.ts` (Linux: caches deleted, links left alone), `pi-launch.test.ts` (cache env),
config. Thread wiring with the real helper: `identities.real.test.ts` (Pi's HOME/TMPDIR are the private dirs
with the modes above, gone with the Pi; flag off: shared, no private dir).

## Tests (real helper, Linux CI step; `scripts/test-identities.sh`)

- `exec.load-paths.real.test.ts`: control (shared TMPDIR + old reclaim effect: the planted jiti entry
  runs in the next real Pi); hardened (cache off, Pi's dirs unwritable by the partner, plant in the
  shared dirs does not run in the current or the next Pi); reclaim drops the caches; `$HOME/.node_modules`
  control vs private HOME; each protection alone (private TMPDIR with the cache on, shared TMPDIR with it off).
- `kobe-models.redirect.real-pi.test.ts` KOBE-167 describe: each case records `id -u` from the tool and
  asserts it is the partner uid; controls per protection: executor on + lock on, executor on + lock off
  (executor alone stops it), executor off + lock on (KOBE-169 alone stops it), both off (leaks).

## Flag OFF (review MEDIUM-3, pre-existing, not fixed here)

With the executor off every Pi's HOME is the shared home, so thread A's tool can write
`~/.node_modules/<pkg>/index.js` and thread B's Pi runs it when it first loads a provider SDK that
optionally requires it (Google family via kobe-models). The jiti half is closed for all Pis (cache off).
Fix needs a private HOME per Pi with the shared one passed to the tools only, and with the flag off the
bash tool inherits Pi's environment, so the tools' HOME would have to be set separately; that is the
executor's job. Mitigation until the executor is on everywhere: KOBE-168 rollout. To ticket.

## LOWs not fixed here

- LOW-1/2/3/4 of the #178 review are fixed (above, tests, `<scratch>` root in Pi's group).

- #161 LOW-1: flag off, `auth.json` is P-writable and `!command`-resolved by P (no escalation, same uid).
- #161 LOW-2: Pi's own `access()`/`realpath()` probes on tool paths run as P (existence oracle only).
- #161 LOW-4: close during a lazy executor start can race the identity reclaim (fails closed; the late
  `killPartner` may hit the next holder's fresh executor, which then fails its call).
- #161 LOW-5: `exec` requests have no client-side bound (a tool can SIGSTOP its own executor); thread-local DoS,
  ended by Stop.

Update: interim fix for the flag-off path in KOBE-228 (private Pi HOME/TMPDIR per thread).
