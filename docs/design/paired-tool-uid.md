# Paired tool uid per thread (KOBE-119, spike for KOBE-74)

Status: accepted (option B); implemented in KOBE-166 (uid pool, helper) and KOBE-167 (executor, `kobe-exec`, see "Implementation notes" at the end). The text below is the original proposal. Items marked **[unverified]** were not
checked against code, docs or a running gVisor in this spike.

## Question

KOBE-71 gave every live Pi process its own uid (`kobe-pi-<n>`, 2000-2063) started through the
file-capability helper `kobe-runas`, with `no_new_privs` and no capabilities. Pi's tools (the `bash`
tool and everything it starts, Python, `rg`/`fd`) and Pi's in-process tools (read, write, edit) run
under that same uid. Should each thread get a second, distinct uid for tool execution?

Constraints from `CLAUDE.md` and `docs/ledger/KOBE-71.md`: gVisor or Kata only; secrets never enter
sandboxes except what the thread's Pi needs; Pi 1.0.x in RPC mode behind `kobe-sandbox-agent`; no
`no_new_privs` weakening and no wider admission policy (only `agent` may add SETUID/SETGID) for any
model-controlled process.

## The threat today

A tool is model-controlled code (prompt injection can steer it). It runs as the Pi's uid `P`, with
groups {P, 1000}, `no_new_privs`, no capabilities, as a descendant of Pi. What it can reach:

| Target                                                                    | Reachable?             | Basis                                                                                                                           |
| ------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Pi memory (`/proc/<pi>/mem`, `ptrace`, `process_vm_readv`, `pidfd_getfd`) | No                     | Yama `ptrace_scope` 1: a descendant may not trace its ancestor. Start-up probe `--probe-ptrace` proves it per pod (KOBE-71).    |
| Run-bound gateway token (KOBE-118)                                        | Not directly           | Lives only in Pi's heap and agent memory; delivered over Pi's RPC channel (`ctx.ui.input`), never file, env or argv.            |
| `/proc/<pi>/environ`, `cmdline`, `maps`                                   | Yes (same uid)         | Measured under gVisor for a same-uid non-descendant. Pi's env is an allow-list (`pi-launch.ts`): no secret, but it names paths. |
| `/proc/<pi>/fd/*`                                                         | Listing yes, reopen no | stdio and fd 3/4 are sockets or pipes: `open` gives ENXIO (KOBE-71 real-helper test).                                           |
| The Pi RPC pipe                                                           | No                     | Same reason; tools cannot inject RPC lines. They can still `kill`/`SIGSTOP` Pi (denial of service of their own thread).         |
| **`model.json`** (0640, group = Pi's gid)                                 | **Yes**                | Holds the sandbox's model-gateway session token (`models/model-file.ts`). Under `requireRunToken` the token alone is refused.   |
| **Pi's `agent/` dir** (2770, Pi uid)                                      | **Yes, writable**      | `models.json`, `settings.json`, `auth.json`. See "the bridge" below.                                                            |
| Other threads' Pis, the agent, `/run/kobe-agent`                          | No                     | Different uid, directory modes (KOBE-71).                                                                                       |
| Shared `/workspace`, `$HOME`, `/tmp`, session files                       | Yes, by design (D13)   | Unchanged by this spike; KOBE-71 residual risks 1 and 4.                                                                        |

**The bridge (the real gap).** Because the tool shares Pi's uid it can write Pi's `agent/` directory.
Pi 1.0.0 re-reads `models.json` when the model list is reopened (`docs/models.md`: "Opening `/model`
reloads the file"), lets it set a provider's `baseUrl`/headers, and runs `!command` values at request
time. If a planted `models.json` can redirect the `kobe` provider (or add a provider the next
`set_model` selects) to a listener the tool controls, the provider attaches `x-kobe-run-token` and the
session token to that request, and the "in memory only" property of KOBE-118 is gone: the tool never
reads Pi's memory, it makes Pi hand the token over. Whether `models.json` can override an
extension-registered provider in 1.0.0 is **[unverified]**; it is the first thing to test (T1 below).
Today's defence is the tripwire (`verifyRuntime` before each prompt rejects unexpected entries), which
is a detector with a time-of-check gap, not a boundary (KOBE-71: "a detector there, not a boundary").

A second, smaller gap: `model.json`'s session token is readable by tools. KOBE-118 made that token
insufficient on its own once `requireRunToken` is on, so it matters mostly during rollout.

## Options

### A. Paired uid through the existing helper (Pi execs a tool helper)

Idea from the KOBE-71 follow-up: `settings.json` `shellPath` points at `kobe-toolrun`, a
file-capability helper that Pi's group may execute and that switches `P -> T`.

- Blocker 1 (KOBE-71, confirmed): a file-capability binary gains nothing under `no_new_privs`, and
  `kobe-runas` sets it on Pi. Making A work needs Pi to run **without** `no_new_privs`, which violates
  the constraint above and lets any process of uid `P` (the tools themselves) use the capability
  binary and any future file-capability or setuid file in the image.
- Blocker 2: only `shellPath` is redirected. Pi's `read`/`write`/`edit` run in-process as `P`, and
  `grep`/`find` spawn `rg`/`fd` from Pi (`dist/core/tools/{grep,find}.js` call `spawn(rgPath)` /
  `spawn(fdPath)` directly), so they would stay at `P` and the `agent/` directory would stay writable
  by them.
- Blocker 3 (resolved here): `shellPath` is honoured by `getShellConfig` and fails if the path is
  missing (`dist/utils/shell.js`), so redirection works, but only for the bash tool.
- Verdict: **rejected**. Weakens the one invariant we keep, covers only part of the tools.

### B. Separate executor process under the partner uid (recommended)

The agent starts, next to each Pi, a small **tool executor** process under the partner uid `T`, using
the same `kobe-runas` (switch to `T`, groups {T, 1000}, umask 002, no caps, `no_new_privs`). Pi's
tool operations are redirected to it by an extension, so Pi itself never spawns or touches a tool.

How Pi 1.0.0 allows this without patching it (verified in the 1.0.0 package):

- Every built-in tool factory takes `operations` (`createBashTool`, `createReadTool`,
  `createWriteTool`, `createEditTool`, `createGrepTool`, `createFindTool`, `createLsTool`;
  `dist/core/tools/*.js`). `pi.registerTool` with an existing name replaces the built-in; the
  documented Gondolin extension (`examples/extensions/gondolin`, `docs/containerization.md`) does
  exactly this for all seven tools to run them in a micro-VM, and `docs/containerization.md` says
  other extension tools still run on the host unless they delegate too.
- Kobe already loads root-owned extensions with `-e` (kobe-models, kobe-tools, kobe-policy), so a
  fourth, `kobe-exec`, needs no change to Pi. `kobe-policy` stays the last `-e`; it checks
  `tool_call` by tool name before `execute`, so overriding the implementation does not bypass it
  (**[unverified]**: needs a real-Pi test that policy still sees the overridden tools).
- Pi's own internal spawns (git for version info, clipboard, models.json `!command`, MCP stdio
  servers if ever enabled) stay in Pi. Kobe's pin disables most (`PI_OFFLINE`, `--no-extensions`);
  `builtin:mcp` (KOBE-62) goes through mcp-proxy. Inventory of remaining `spawn` sites in Pi is a
  task in T2. The RPC `bash` command is driven only by the agent, which never sends it **[unverified]**.

Wiring: the agent creates two pipes and **relays** frames between Pi (new fd 5, `kobe-runas` already
closes fds >= 5, so it learns to keep 5 exactly like 3 and 4) and the executor (its stdio). A relay in
the agent avoids any socket path the tool uid could connect to, and keeps `T` from being able to talk
to Pi's end. The executor speaks a small request/response protocol (exec with streamed stdout/stderr,
read, write, stat, list, glob) and runs tools as its children.

Fail closed: if the executor is missing or dies, `kobe-exec` returns a tool error; it never falls back
to executing in Pi. Agent without the new capability: Pi runs as today (negotiated in `hello`).

What it closes: signals to Pi, `/proc/<pi>/*` (environ, maps, cmdline: cross-uid, measured refused
toward uid 1000), writes to `agent/` (planting `models.json`/`settings.json`), reading `model.json`
(group is Pi's own, `T` is not in it), Pi's session cache and auth store. It also removes
`PI_CODING_AGENT_DIR`, `KOBE_MODEL_FILE`, `KOBE_POLICY_FD` from the tools' environment (the
executor builds its own allow-list), and KOBE-71 residual risk 3 disappears.

### C. seccomp / Landlock / ptrace restrictions inside gVisor

- Landlock: not implemented by gVisor (KOBE-71, from measurements/docs; re-check against the pinned
  `runsc` release-20260928.0 **[unverified here]**). Node's permission model does not cover child
  processes (KOBE-71).
- seccomp-bpf: filters are installable unprivileged under `no_new_privs`, and gVisor documents
  seccomp support for the guest **[unverified against this release]**. A wrapper (`shellPath`) could
  install a filter blocking `ptrace`, `process_vm_*`, `pidfd_*`, and `kill` with Pi's pid as a
  constant argument. But seccomp filters on syscall arguments, not paths: it cannot stop
  `open("models.json")` or `open("agent/models.json", O_WRONLY)`, which is the actual gap. It also
  applies only to the bash tool's descendants, not to in-process tools, and pid-keyed kill filters
  race with pid reuse.
- Ptrace: already restricted (Yama 1, probed at start-up). Nothing to add.
- `/proc` hiding (`hidepid`): needs a mount (CAP_SYS_ADMIN), which the sandbox does not have, and
  whether runsc honours `hidepid` is **[unverified]**.
- Verdict: **rejected as the fix**, useful only as defence in depth inside the executor (T4).

### D. Do nothing and accept

Cost: zero. Risk: the `models.json`/`agent/` bridge (if exploitable) defeats KOBE-118 for a prompt-
injected run, and KOBE-42's per-run budget stop stays dodgeable in the same way. Harm is bounded to
the team's own threads and its own model budget (no other tenant is reachable), and the tripwire
catches the plant before the next prompt. Acceptable only if T1 shows the bridge is not exploitable.

## gVisor facts relied on

| Fact                                                                                                              | Status                                                                  |
| ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| File-capability helper switches uid with `allowPrivilegeEscalation: true`; setuid-root binary does not            | Measured on the cluster's runsc (KOBE-71 ledger, "gVisor measurements") |
| Yama `ptrace_scope` 1; cross-uid ptrace, `mem`, `environ`, `kill` refused; same-uid ancestor `mem`/ptrace refused | Measured (KOBE-71)                                                      |
| `/run/kobe-pi` memory emptyDir is sticky 3777 and a mount point                                                   | Measured (KOBE-71)                                                      |
| Second pool of uids needs no new capability: same helper, same two caps                                           | By construction; the new range check is in the helper                   |
| POSIX ACLs on the workspace volume                                                                                | **[unverified]**; not needed (see next section)                         |
| Kata guest kernel has Yama and the same `st_dev` behaviour                                                        | **[unverified]**; KOBE-71 residual risk 8 applies unchanged             |

## Workspace ownership between the two uids

Today every identity has the workspace group 1000, runs with umask 002, and the pod's fsGroup makes
volume directories setgid 1000, so files are `uid:1000 0664` and any thread, and the agent (sync,
KOBE-27), can read and write them. Paired uids keep exactly this:

- Tools create files as `T` with groups {T, 1000}, umask 002, in setgid directories: `T:1000 0664/0775`.
  Pi (`P`, also in group 1000) reads and writes the same files by group. Shared group, umask and
  setgid directories are enough; **no ACLs** needed.
- What changes: files tools create are owned by `T`, not `P`. `chmod`/`chown` by `P` no longer
  work on them (Pi never does that). Pi's own files (session JSONL under `/workspace/.kobe/sessions`)
  stay `P:1000 0660`; tools can still rewrite them through the group (KOBE-71 residual risk 4,
  unchanged; moving the session dir to the agent is a separate idea, not proposed).
- Recycled-uid files (KOBE-71 residual 9) now belong to a pool of `T` uids; same treatment, and the
  reclaim script must clean both uids of a pair.
- `git` refuses repositories owned by another uid ("dubious ownership"). This already bites when a
  later thread gets a different uid; a system-wide `safe.directory = *` in the image's gitconfig
  fixes it for both models **[unverified whether already set]** (T3).
- Executor and Pi must agree on cwd and path spelling: `kobe-exec` passes absolute paths and the
  executor resolves them (`O_NOFOLLOW` where relevant). Pi's in-process work no longer needs
  read access beyond the session file and skills store.

## Pi 1.0.x constraints (summary)

- Redirect without patching: yes, through `registerTool` + `operations`, as above (verified in the
  1.0.0 package; end-to-end behaviour under Kobe's lockdown flags **[unverified]**).
- Tool names, schemas and output limits must match the built-ins so models and `kobe-policy` see no
  difference; reuse Pi's `create*Tool` with Kobe operations rather than reimplementing.
- `grep`/`find` accept custom operations (Gondolin supplies them); the `rg --pre` risk in the KOBE-71
  note disappears because `rg` then runs as `T`.
- Pi pin stays `1.0.0` (`images/sandbox/pi/package.json`); any 1.0.x bump re-runs the real-Pi suite.

## Cost and complexity

| Item                            | Estimate / note                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Helper change                   | Small: second uid range, `--kill-all` for both, keep fd 5. `kobe-runas.c` stays about 250 lines.                                          |
| Identity pool                   | Pair per Pi (`T = P + 1000`, 3000-3063); 64 more passwd/group entries; 16 more supplementary groups.                                      |
| Executor + protocol + extension | Medium: framed exec/streaming, cancellation, timeouts, output caps, seven operation sets, Pi-version tests.                               |
| Memory                          | One extra Node process per live Pi (tens of MB, lazy start on first tool call); measure against the pod limit.                            |
| Latency                         | One local hop per tool call (agent relay); expected negligible next to model latency, measure cold start (KOBE-71 ac-3 budget 10%).       |
| Pod spec / admission            | None: no new capability, same container, same policy. `supplementalGroups` grows by the T groups.                                         |
| Rollout                         | Server reconciles team SandboxTemplates (300 s); running threads switch on Pi restart; capability negotiated in `hello`, no DB migration. |

## Recommendation

**Do it, via option B, and do not weaken `no_new_privs` (reject A).** Gate the priority on T1: if a
planted `models.json` can redirect the Kobe provider, the paired uid is the only structural fix for
the run-token and per-run-stop guarantees and should precede turning on `requireRunToken` by default;
if not, schedule it as hardening after the gate tickets. Keep the tripwire either way.

### Follow-up tickets

| #   | Title                                                          | Scope (one line)                                                                                                                                                                                            | Migration                    | Depends on            |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | --------------------- |
| T1  | Real-Pi test: can a tool redirect the Kobe provider via agent/ | Plant `models.json`/`settings.json` from a tool uid during a run and after `set_model`; assert the run token never reaches a tool-owned listener (red test first).                                          | no                           | KOBE-118              |
| T2  | kobe-exec: Pi tools routed through an executor extension       | Extension overriding the seven tools with remote operations, executor program, framing, relay in the agent on fd 5, fail-closed; Pi spawn-site inventory.                                                   | no                           | T3 (or stub), KOBE-71 |
| T3  | Paired uid pool and helper support                             | `kobe-runas` second range and fd 5, pair allocation/reclaim in `pi/identities.ts`, passwd/group entries, `supplementalGroups`, git safe.directory, image checks.                                            | no (pod spec reconcile only) | KOBE-71               |
| T4  | Paired uid: end-to-end isolation tests and rollout             | Real-helper and e2e (gVisor) tests: tool cannot signal Pi, read `model.json`, write `agent/`; workspace sharing and KOBE-27 sync; cold-start budget; seccomp inside the executor as defence in depth; docs. | no                           | T2, T3                |

If T1 shows the bridge is not exploitable, a cheaper interim step is to close it in the agent
(re-assert the Kobe provider after each reload and treat any `models.json` entry as `runtime_tampered`
mid-run, not only before prompts); that interim is not proposed as a replacement.

## Open questions for the user

1. Is one extra Node process per live Pi acceptable on the smallest sandbox size? (A shared
   executor cannot hold a distinct `T` per thread without the agent holding the capability.)
2. Should T1 outcome gate T2-T4 (as proposed), or do you want the paired uid regardless?

## Implementation notes (KOBE-167)

What was built, where it differs from the proposal, and the inventory T2 asked for.

- **Pieces.** `services/sandbox-agent/src/kobe-exec/` is the Pi extension (loaded right before
  kobe-policy; it re-registers the seven built-ins, `bash read write edit ls grep find`, and a
  `user_bash` handler). `exec/relay.ts` is the agent's relay on Pi's fd 5, `exec/executor/` the
  program that runs as the partner uid, `exec/spawn-executor.ts` starts it through `kobe-runas`,
  `threads/exec-wiring.ts` ties it to a thread. The wire format is `kobe-exec/protocol.ts`.
- **Helper: no change.** KOBE-166's helper already keeps fd 3, 4 and 5 for a Pi and stdio only for a
  partner uid; the executor's channel is its stdio, the agent relays between the two sockets.
- **Tool semantics.** Pi's own tool definitions are reused (schema, prompt text, renderers,
  truncation, details) with Kobe `operations` for bash, read, write, edit, ls. Pi's grep and find
  spawn `rg`/`fd` from Pi even with custom operations, so those two re-implement `execute` from
  Pi's source with the executor running the program. `tools.pi-parity.test.ts` runs the same
  operations through Pi's tool and the routed one and compares results and error messages.
- **Fail closed.** Extension loaded without a usable channel: all seven tools are still registered
  and fail. Executor missing, dead or not answering: the call fails (`unavailable`); the relay
  clears the partner uid and starts a fresh executor on the next call. Asked for under Pi identities
  without the partner groups, the agent does not start.
- **Egress token** moves to a directory next to the runtime dir, in the _partner's_ group
  (`<runtime>-tool/`, 2750), so tools read it and Pi does not; the egress variables go to the
  executor's environment, not Pi's. The executor's environment is an allow-list; Pi's `PI_*` session
  variables (model, session id) are passed on because the bash tool's prompt promises them.
- **Limits** differing from running in-process: a file read or written by a tool call is capped at
  64 MiB; a directory listing is cut after about 1.5 MiB of names (sorted first); the tools run in
  the workspace group's view, so files they create are `partner:1000 0664`.

### Pi's own spawn sites (Pi 1.0.0)

Pinned by `kobe-exec/pi-spawn-sites.test.ts` (it fails when an upgrade adds, moves or drops one).

| Site (module under `dist/`)                                                                                   | Starts                                                | In a Kobe launch                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/tools/{bash,grep,find}.js`, `utils/shell.js`                                                            | shell, `rg`, `fd`, `which`                            | Replaced by kobe-exec; none runs in Pi any more. RPC `bash` and user `!` commands go through `user_bash` to the executor (tested against real Pi).                                                       |
| `core/resolve-config-value.js`                                                                                | `!command` config values                              | **Stays in Pi's uid.** Inputs are `models.json`/`settings.json` (agent-written placeholders, 0440) and `auth.json` (Pi's own store) in `agent/`, which no tool can write now. The tripwire still checks. |
| `core/exec.js` (`pi.exec`)                                                                                    | any program                                           | Not reachable: only Kobe's root-owned extensions load (`--no-extensions`) and none calls it.                                                                                                             |
| `extensions/mcp` (`builtin:mcp`) via pi-mcp `StdioTransport`                                                  | MCP stdio servers                                     | Servers come from `mcp.json` in the agent dir (not writable by tools); Kobe wires MCP over HTTP through mcp-proxy (KOBE-62), no stdio server is written.                                                 |
| `core/package-manager.js`, `package-manager-cli.js`, `config.js`                                              | npm, git                                              | Package install/update and self-update: `settings.json` is guarded, `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1`, no such RPC command.                                                                      |
| `core/footer-data-provider.js`                                                                                | `git symbolic-ref`                                    | TUI footer; RPC mode builds none (the resource loader only reads `.git` files).                                                                                                                          |
| `utils/clipboard-command.js`, `utils/open-browser.js`, `modes/interactive/*`, `rpc-client.js`                 | clipboard tools, `xdg-open`, `$EDITOR`, `gh`, `trash` | Interactive mode / OAuth / client library only; not constructed in `--mode rpc`.                                                                                                                         |
| `utils/tools-manager.js`, `utils/paths.js`                                                                    | `rg --version`, downloads, `xattr`                    | Called by the replaced grep/find, interactive start-up and the package manager only.                                                                                                                     |
| Bundled provider SDKs (AWS `credential_process`, Google external-account executables, Anthropic helper shell) | credential helpers                                    | Only when a Bedrock/Vertex/Anthropic-SDK model is selected; Kobe's model is the `kobe` provider, `set_model` is not allowed over the wire (KOBE-169) and `run.start` names a gateway model.              |
| Built-in `codemode` extension (model-written JS in a worker inside Pi)                                        | -                                                     | Not loaded: built-ins load only as explicit `builtin:<name>` paths and the agent passes none but (later) `builtin:mcp`. Enabling it would put model code in Pi's process; do not.                        |

The residual in-Pi site is therefore the `!command` resolver, and it is only as steerable as the
files in `agent/`, which is what the partner uid takes away from tools.
