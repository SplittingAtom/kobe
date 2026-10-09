# KOBE-167: 74d T2: kobe-exec: route Pi's tools through an executor under the partner uid

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review
- **Branch / worktree:** `kobe-167-kobe-exec` in `../Kobe-wt167`
- **Depends on:** KOBE-166 (merged, PR #142), KOBE-165/169. Rollout: KOBE-168. Migrations: none.
- **Design:** `docs/design/paired-tool-uid.md` (option B), "Implementation notes" at its end.

## Plan

The structural fix for KOBE-165: Pi's built-in tools stop running in Pi. A Pi extension (`kobe-exec`)
re-registers them; every call goes over fd 5 to the agent, which relays it to an executor process
running as the Pi identity's partner uid; fail closed.

## Decisions

- **Seven tools, plus a hook.** `bash read write edit ls grep find` (Pi 1.0.0 `allToolNames` minus
  `powershell`, which throws off Windows). Extension tools replace built-ins by name
  (`agent-session.js _refreshToolRegistry`), so kobe-policy (last `-e`) still checks each call first
  (real-Pi test: a denied call never reaches the executor). `user_bash` is routed too: Pi's RPC `bash`
  command and `!` commands would otherwise run in Pi (not in the `pi.command` allow-list; closed anyway).
- **Semantics preserved by reuse.** bash/read/write/edit/ls are Pi's own `create*ToolDefinition` with
  Kobe `operations` (same schema, prompt text, renderers, truncation, notices, diffs). grep and find
  spawn `rg`/`fd` from Pi even with custom operations (verified `grep.js`, `find.js`), so those two copy
  Pi's `execute` with the program run remotely. `kobe-exec/tools.pi-parity.test.ts` runs identical
  operations through Pi's tool and ours (real Pi package, fake rg/fd on PATH to compare arguments too).
  ls does one `readdir` carrying entry kinds instead of a stat per entry.
- **Wire** (`kobe-exec/protocol.ts`): JSONL; ops exec/cancel/read/write/mkdir/access/stat/readdir;
  exec streams base64 stdout/stderr frames then a final frame; files move in 1 MiB chunks (cap 64 MiB
  per call); executor argv only for rg/fd. The relay validates envelopes and ids, tracks open requests,
  bounds line sizes and buffers, answers every open request with `unavailable` if the executor dies, and
  starts a fresh executor (after `killPartner`) on the next call. A broken channel kills the executor.
- **Fail closed.** Extension without a channel registers all seven tools failing (registering nothing
  would leave Pi's local ones). Executor cannot start/dies: call fails, never runs in Pi. Flag on under
  Pi identities without the partner groups: the agent refuses to start (`index.ts toolExecutor`). A Pi
  whose relay cannot be created is killed.
- **Helper: no change.** KOBE-166's helper keeps fd 3/4/5 for a Pi and stdio only for a partner; the
  executor speaks over its stdio to the agent's relay. Verified by real Pi under the helper (fd 5 works).
- **Executor environment** is an allow-list built by the agent (`executorEnv`): PATH, HOME, TMPDIR, LANG...,
  `NODE_OPTIONS=--disable-sigusr1`, and the egress variables (BASH_ENV, proxy, thread id). None of Pi's
  (agent dir, model file, fds). Only Pi's `PI_SESSION_*/PROVIDER/MODEL/REASONING_LEVEL` pass, because the
  bash tool's prompt promises them.
- **Egress token** moves with the tools: under a pair it lives in `<runtime>-tool/` (agent-owned, partner's
  group, 2750, file 0640), not in the Pi-group runtime dir; without identities it stays where it was.
- **Lifecycle.** One executor per Pi, started on the first call, killed with the Pi (relay close, then the
  existing `killAll` of both uids). Dead executor between calls: `killPartner` (new, serialised with `killAll`)
  then a new one.
- **Flag.** Agent `KOBE_TOOL_EXECUTOR` (true/false; unset = on outside Kobe's pods so dev/tests exercise it,
  off inside them; needs `KOBE_EXEC_EXTENSION`, set by the image; on without it in a pod = refuse to start). Chart `sandbox.toolExecutor.enabled` (default **false**) ->
  server `sandbox.toolExecutor` -> pod env. Takes effect on sandboxes started after the change.
- **Spawn-site inventory:** design doc table; pinned by `kobe-exec/pi-spawn-sites.test.ts`. In short: the only
  site still in Pi's uid that a Kobe launch can reach is the `!command` resolver for config values, whose
  inputs are in `agent/` (now unwritable to tools). MCP stdio, package manager, clipboard, browser, git
  footer, `pi.exec`, codemode: not reachable (flags, offline, RPC mode, nothing loads them).
- **KOBE-165.** The three `it.fails` raw-Pi cases are now plain `it`, run with real Pi as a Pi identity and
  its tools in the executor as the partner uid (agent layout, guarded placeholders, plant path handed to the
  tool). They need the real helper, so they run in the Linux CI step (`scripts/test-identities.sh`); a
  control case in `pnpm test` shows the same scenario still leaks when the tool shares Pi's uid.
- **Limits.** 64 MiB per file call; ls lists the first ~1.5 MiB of names (sorted); read of FIFOs/devices is
  refused (not waited on); `O_NOFOLLOW` not used (Pi follows links too).

## Open questions (for Chris or the coordinator)

- `hello` does not announce the executor (the design mentioned negotiating it). Nothing needs it: the pod
  spec carries the flag and the agent refuses to start inconsistently. KOBE-168 may want a capability for
  the server to show "tools isolated" per sandbox.
- Executors are lazy; a thread that never calls a tool costs nothing. Memory per active thread (one Node
  process) is not yet measured against the smallest sandbox size (design open question 1).
- `powershell` is Pi's eighth built-in; on Linux it throws, so it is not overridden. A Pi bump that makes it
  work on Linux must override it (the spawn-site pin test would flag `core/tools/powershell.js`).

## Evidence (acceptance criteria -> test or command output)

| Criterion                                       | Test                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 every Pi tool call runs as the partner uid | `exec.real.test.ts` "runs the executor and every command as the partner uid" (real helper, via relay + Pi's tool ops); `kobe-exec.real-pi.test.ts` "runs Pi's bash tool in the executor process, not in Pi"; RPC bash: `kobe-exec.rpc-bash.real-pi.test.ts` |
| ac-1 executor unavailable -> the call fails     | `kobe-exec.real-pi.test.ts` "fails closed when there is no executor", "fails the call when the executor dies..."; `exec.real.test.ts` kill/restart; `client.test.ts`, `relay.test.ts`                                                                       |
| tool semantics equal Pi's                       | `tools.pi-parity.test.ts` (bash, read, write, edit, ls, grep, find: results, details, error text, rg/fd arguments)                                                                                                                                          |
| KOBE-165 cases pass                             | `kobe-models.redirect.real-pi.test.ts` "KOBE-167" describe (real helper, Linux step); control case in `pnpm test`                                                                                                                                           |
| tools cannot reach Pi / agent dir / model file  | `exec.real.test.ts` "cannot signal Pi, read its memory...", "hands the egress token to the partner uid and not to Pi"                                                                                                                                       |
| spawn-site inventory                            | design doc table + `pi-spawn-sites.test.ts`                                                                                                                                                                                                                 |
| flag                                            | `config.test.ts`, server `manifests.test.ts`/`config.test.ts`, chart `sandbox.test.ts`, `kobe-exec.real-pi.test.ts` "flag off"                                                                                                                              |
| image                                           | `images/sandbox/test-image.sh` (kobe-exec perms, env, executor runs as a partner uid); not run locally (no Docker engine)                                                                                                                                   |

The real-helper step was also run on the remote Docker host in a throwaway container (all 7 `exec.real`,
3 redirect, 27 KOBE-71/166 cases green) before the PR; CI runs it as `Sandbox privilege separation`.
