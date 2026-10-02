# KOBE-23: kobe-sandbox-agent: dial-out WSS + Pi RPC bridge

- **Status:** in review (PR #21)
- **Branch / worktree:** `kobe-23-sandbox-agent` in `../Kobe-wt23`
- **Depends on:** KOBE-21 (sandbox image), KOBE-29 (schema), contracts (#13, `packages/protocol`)

## Acceptance criteria (derived from spec D11, D13, D14, D15, §5.2, §5.3 and the wire contract)

Hadron was not reachable; criteria derived from the spec and `sandbox-wire/connection.ts`.

1. The agent opens exactly one **outbound** authenticated WebSocket to `<server>/v1/sandbox/connect`
   (token for audience `kobe.sandbox-wire` in `Authorization`, never in the URL; subprotocol
   `kobe.sandbox.v1`) and **never listens** on any socket.
2. `hello` / `hello.ack` with per-run outbound seq; un-acked `pi.event` frames are re-sent from
   `durable_seq + 1` on reconnect and from `from_seq` on a live `resend` (duplicates ignored); runs
   the server does not list are aborted.
3. One `pi --mode rpc` (Pi 1.0.x) process per active thread, all with cwd `/workspace`; idle
   processes are reaped; a process cap evicts idle threads only.
4. Server commands map onto Pi RPC: `run.start` → `prompt`, `run.steer` → `steer`, `run.stop` →
   `clear_queue` + `abort` (now or after the in-flight step), allow-listed `pi.command` → the command;
   every command gets exactly one `command.result`; duplicate command ids are ignored.
5. Pi session events stream as `pi.event` frames; extension UI requests are relayed (`pi.ui_request` /
   `pi.ui_response`).
6. Heartbeats, hello timeout, jittered reconnect backoff, terminal close codes stop the agent.
7. Frame size cap at the WS layer (`maxPayload`) and on everything the agent sends; no unbounded
   buffers (Pi lines, outbox, policy checks, dialogs, restore).
8. No provider/MCP secret in the sandbox; Pi gets an allow-listed environment; the wire token is
   read from a file and never reaches Pi's environment.
9. `session.restore` rebuilds a thread's Pi session JSONL from Postgres (D13, D15).
10. Seams: kobe-policy (`policy.check`, KOBE-36), S3 sync (KOBE-27), model/MCP/skills wiring
    (KOBE-41/62/47/49).
11. Integration test against the real pinned Pi 1.0.0 without model credentials.

## Design

`services/sandbox-agent/src`:

| Module                | Role                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `wire/client.ts`      | `ws` client: dial, `hello`/`hello.ack`, heartbeats, backoff, terminal close codes        |
| `wire/encode.ts`      | every outbound frame is checked with the server's `decodeSandboxFrame` before sending    |
| `wire/outbox.ts`      | per-run seq, cumulative ack, resend dedupe, byte cap                                     |
| `wire/backoff.ts`     | exponential backoff, full jitter, floor                                                  |
| `pi/pi-process.ts`    | one Pi child: LF-only JSONL, id correlation, stderr tail, process-group stop             |
| `pi/pi-launch.ts`     | args (`--mode rpc --session <thread file>`) and allow-listed env                         |
| `pi/session-files.ts` | per-thread session file, branch marker, `SessionRestore` (temp file + rename)            |
| `policy/channel.ts`   | fd-3 JSONL channel for the kobe-policy extension (KOBE-36 seam)                          |
| `policy/broker.ts`    | `policy.check` ↔ `policy.pending` / `policy.result` routing, fail closed                 |
| `threads/thread.ts`   | one thread's Pi process and active run, lifecycle lock                                   |
| `threads/manager.ts`  | command → Pi RPC mapping, process cap, idle reaper, restore, shutdown                    |
| `agent.ts`            | glue; `index.ts` entry (config, token file, `pi --version`, signals)                     |
| `testing/`            | fake Pi (scripted JSONL, `fake-pi.mjs`), fake wire server, harness — not built into dist |

## Decisions

- **Session file per thread:** `KOBE_SESSION_DIR/<thread_id>.jsonl` (default
  `/workspace/.kobe/sessions`, on the volume so it survives hibernation), Pi started with
  `--session <path>` (path form: no project-scoped id lookup or interactive prompts, verified).
- **Edit-and-regenerate (`parent_entry_id`):** Pi 1.0.0 RPC has no in-place tree navigation and
  `fork` moves Pi to a **new session file** with fresh history (verified), which would split the
  thread's tree (D15). Instead, with the thread's Pi stopped, the agent appends a `custom` entry
  (`customType: "kobe.branch"`, `data.run_id`, never in model context) whose `parentId` is the branch
  point and restarts Pi, which resumes at the last appended entry (verified with real Pi: the
  abandoned branch leaves the context). The marker is a real entry and is mirrored like any other.
- **`fork` via `pi.command` is refused** (`pi_rejected`) for the same reason (see contract issues).
- **`session.restore`:** each part gets its own `command.result` (one per command frame); parts
  stream to `<file>.restore.tmp` and are renamed into place on `final`; refused while the thread has
  an active run; a partial restore is voided when the connection drops; size cap
  `KOBE_RESTORE_MAX_BYTES` (512 MiB). The header's `cwd` is rewritten to the sandbox workspace: real
  Pi refuses a session whose stored cwd does not exist (found by the real-Pi test).
- **Run end (agent side):** `agent_settled`; or Pi rejected the prompt (`command.result` error
  `pi_rejected`); or disposition `handled` (no run starts, `command.result` ok with
  `data.disposition: "handled"`); or abort completed; or Pi exited (`pi.exited`). A finished run
  stays in `hello.runs` until all its frames are acked.
- **Stop:** `clear_queue` then `abort` (Pi's `abort` otherwise continues queued steering/follow-ups);
  `after_step` waits for the next `turn_end`. `command.result` for `run.stop` is sent once the run
  has ended on the Pi side.
- **Events outside a run** (e.g. compaction from `pi.command compact`) are dropped: `pi.event`
  requires a `run_id`; persistence comes from `get_entries` mirroring.
- **Unsendable Pi events:** an event that would fail the server's decoder (over 4 MiB) is replaced
  by `{type:"kobe.event_dropped", original_type, reason}` with the same seq, so seqs stay gapless
  and the server (which ignores unknown types) never loops on `resend`. U+0000 → U+FFFD, `__proto__`
  keys dropped, nesting capped before encoding.
- **Outbox cap** (`KOBE_OUTBOX_MAX_BYTES`, 64 MiB): on overflow the run is aborted, dropped and the
  agent reconnects, so `hello` no longer lists it and the server interrupts it (D14).
- **Policy channel:** fd 3 of each Pi process is a socket pair (no listener; close-on-exec so tools
  Pi spawns don't inherit it), `KOBE_POLICY_FD=3`. The agent adds `run_id`/`thread_id` itself and
  mints wire `request_id`s; no active run, no connection, connection loss or run end ⇒ local deny
  `{decision:"deny", reasons:[], message}`. Pending checks capped at 512.
- **Pi environment:** allow-list only (`PATH`, locale, `TZ`, `TMPDIR`, `HOME`), plus
  `PI_SKIP_VERSION_CHECK=1`, `PI_TELEMETRY=0`, `PI_OFFLINE=1`, `KOBE_POLICY_FD=3`. The agent's own
  environment (server URL, sandbox id, token file path, anything a pod spec adds) never reaches Pi.
- **Token:** read from `KOBE_SANDBOX_TOKEN_FILE` (default `/var/run/kobe/sandbox-wire/token`) on
  every dial, so a rotated token is picked up; `unauthorized` just backs off and retries.
- **Close codes:** `unsupported_version` ⇒ exit 1; `replaced`, `sandbox_destroyed`, `hibernating` ⇒
  drain (5 s) and exit 0; everything else ⇒ reconnect with backoff (500 ms base, 30 s cap, full
  jitter, 250 ms floor). `shutdown` frame ⇒ refuse new runs, wait up to `deadline_ms`, abort the
  rest, close Pi, exit 0.
- **Process hygiene:** Pi runs in its own process group; stop = close stdin (3 s) → SIGTERM group
  (2 s) → SIGKILL group; on agent exit every group is SIGKILLed. Idle Pi processes are reaped after
  `KOBE_PI_IDLE_MS` (10 min); at `KOBE_MAX_PI_PROCESSES` (8) the least recently used idle one is
  closed, busy ones never.
- **Attachments:** listed in the prompt text (`Attached files:` with path and MIME type); paths
  outside the workspace are refused. Image inlining is left to KOBE-53.
- **`runs.sandbox_seq`:** not added here; the agent does not need it. The server's CAS lives in
  KOBE-24, which should add the column with its migration.
- New dependency: `ws` ^8.22 (MIT; already in the lockfile transitively), `@types/ws` (MIT, dev).
- CI (`ci.yml` `checks`): installs the pinned Pi from `images/sandbox/pi` so the real-Pi test runs.

## Contract issues (for a contracts PR; not changed here)

1. `piBridgeCommandSchema` admits `fork`, which moves Pi to a new session file (verified 1.0.0).
   Suggest removing it; edit-and-regenerate is `run.start.parent_entry_id` (agent-side marker).
2. `session.restore`: say explicitly that every part gets its own `command.result`, and that the
   agent rewrites `header.cwd` to its workspace.
3. `run.start.parent_entry_id` cannot express "branch at the root". In practice Pi writes a
   `thinking_level_change`/system entry first, so a first user message has a parent; note it.
4. `pi.ui_request` is not sequenced; the agent re-sends open dialogs after a reconnect, so the server
   must dedupe by `(thread_id, request.id)`.
5. The kobe-policy ↔ agent channel (fd 3, `policy/channel.ts`) is sandbox-internal; if KOBE-36 wants it
   shared, move its schema into `packages/protocol`.
6. The `kobe.event_dropped` placeholder event type should be listed in `pi-events.ts` docs.

## What other tickets must know

- **KOBE-24 (server registry):** before the first `run.start` on a thread after (re)connect, check
  the session with `pi.command get_entries {since: <last mirrored entry>}`; an error
  `pi_rejected` "Entry not found" (or an empty session for a thread with entries) means the volume
  was lost → send `session.restore` from part 0, then start the run. A `run.start` result with
  `data.disposition: "handled"` or an error ends the run without `agent_settled`. `run.stop`'s result
  arrives after the run ended. `get_entries` data over 4 MiB comes back as `frame_too_large`: page
  with `since`. The agent re-sends open `pi.ui_request`s after reconnect. Add `runs.sandbox_seq`.
- **KOBE-22 (pods):** env `KOBE_SERVER_URL` (base URL; the agent appends `/v1/sandbox/connect`),
  `KOBE_SANDBOX_ID`; mount the wire token at `/var/run/kobe/sandbox-wire/token` (projected secret,
  rotation-friendly). Consider an init (e.g. `tini`) — see risks.
- **KOBE-36 (kobe-policy):** open `new net.Socket({ fd: Number(process.env.KOBE_POLICY_FD) })`, write
  `policy.check` JSONL, wait for `policy.result` (ignore `policy.pending`), block on deny, on channel
  close and on its own timeout.
- **KOBE-27 (S3 sync):** `ThreadManagerOptions.beforeRun(frame)` runs before each prompt reaches Pi.
- **KOBE-41/62/47/49:** wire config into `buildPiLaunch` (args/env, allow-listed, no credentials);
  any field in the launch key restarts an idle thread's Pi when it changes.

## Open risks

- **Same uid:** Pi's tools run as uid 1000 like the agent, so model-driven code can read the token
  file (and `/proc/<agent>/environ`, which holds no secret). With the wire token it could open its own
  connection as this sandbox; leasing confines it to this sandbox's own runs and every tool call is
  still decided server-side. Real fix needs a second uid (image + pod change) — flag for KOBE-22/21.
- **PID 1 reaping:** the agent is PID 1; orphaned grandchildren of Pi tools are not reaped by Node.
  Killing the process group on stop limits it; `tini` (MIT) in the image would remove it.
- `ws` send buffering is bounded only indirectly (≈ outbox + one resend window).
- Session files on `/workspace` are writable by Pi's tools; the server must keep treating mirrored
  entries as untrusted (it validates with `piGetEntriesDataSchema`).

## Self-review round (code-reviewer agent) — resolution

1. HIGH: a `command.result` could go out on a later connection than its command (lease
   violation). `WireClient.epoch` increments per `hello.ack`; results for an earlier epoch are
   dropped (the server re-issues). Test: "never answers a command on a later connection".
2. HIGH: the idle reaper could forget a thread a queued command was about to use (untracked Pi).
   Commands now `claim()` the thread synchronously on arrival (claims count as busy); the reaper
   re-checks and deletes inside the thread lock.
3. MEDIUM: reaper/eviction checked `busy` outside the lock: both re-check under it.
4. MEDIUM: process cap overshoot under concurrent spawns: slots are reserved synchronously
   (`#pendingSpawns`), eviction holds no global lock (no deadlock). Test: concurrent starts at cap 1.
5. MEDIUM: Stop before `agent_start` ended the run early while Pi kept working: the agent now waits
   for `agent_settled` after `abort` (re-sends `abort` once), and stops Pi if it never settles; a
   timed-out prompt stops Pi too.
6. MEDIUM: resend dedupe could stall a run: duplicates are ignored only within 2 s
   (`RESEND_DEDUPE_MS`); a `durable_seq`/`from_seq` below what the server already acked abandons the
   run (abort, drop, reconnect so the server interrupts it). Tests in `outbox.test.ts` and
   "abandons a run whose frames the server lost".

## Evidence (acceptance criteria → test or command output)

`pnpm --filter @kobe/sandbox-agent test`: 12 files, 95 tests (real-Pi suite runs when
`images/sandbox/pi` is installed; it is in CI).

| AC  | Evidence                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `agent.wire.test.ts` "dials the contract path with the token in Authorization"; `no-inbound.test.ts` (no listener APIs in production code)           |
| 2   | `agent.wire.test.ts` delivery and resume (re-send from durable seq, resend dedupe, unlisted runs aborted, finished runs forgotten); `outbox.test.ts` |
| 3   | `agent.runs.test.ts` concurrent threads, process cap / LRU eviction, respawn after exit                                                              |
| 4   | `agent.runs.test.ts` run.start / steer / stop (abort, after_step) / pi.command / duplicate ids; prompt rejected / handled                            |
| 5   | `agent.runs.test.ts` gapless seq stream, translated events valid; extension UI relay and re-send                                                     |
| 6   | `agent.wire.test.ts` heartbeat timeout, token refused then rotated, terminal close codes, shutdown drain; `backoff.test.ts`                          |
| 7   | oversize event placeholder, `frame_too_large` result, `jsonl.test.ts` oversize lines, outbox overflow, broker cap; fake server checks every frame    |
| 8   | `pi-launch.test.ts`, `agent.runs.test.ts` allow-listed env (fake Pi records its env), `no-inbound.test.ts` (no token from env)                       |
| 9   | `agent.runs.test.ts` restore + get_entries, out-of-order, active-run refusal, void on disconnect; `session-files.test.ts`                            |
| 10  | `broker.test.ts`, `agent.runs.test.ts` fd-3 policy relay + fail closed on disconnect; `beforeRun` seam                                               |
| 11  | `agent.real-pi.test.ts` against Pi 1.0.0: get_state on the thread's file, prompt refused without a key, restore read by Pi, in-place branch verified |

Manual smoke: built `dist/index.js` + real Pi against a throwaway WS server: hello (pi_version
1.0.0 from `pi --version`), `get_state` round trip, `shutdown` → exit 0, no Pi process left.
