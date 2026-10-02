# KOBE-36: kobe-policy Pi extension

- **Status:** in review
- **Branch / worktree:** `kobe-36-policy-extension` in `../Kobe-wt36`
- **Depends on:** KOBE-35 (policy engine, merged), KOBE-23 (sandbox agent + fd-3 channel, merged),
  contracts (`packages/protocol`). KOBE-24 (server side of `policy.check`) is built in parallel.

## Acceptance criteria (Hadron KOBE-36 + coordinator brief)

1. **ac-1** Every tool call is checked; no path skips the hook (model-issued, parallel, codemode
   nested calls; no channel / timeout / malformed reply / closed channel → block).
2. **ac-2** Mismatched input vs approved decision is rejected (see Decisions: the sandbox never
   holds the HMAC key or the token; the extension binds the decision to the call and the input).
3. **ac-3** Denials surface as `policy.denied`: the call fails with a structured tool error
   `policy.denied: <reason>`; the Kobe Event Stream `policy.denied` event is the server's (KOBE-24).
4. Fail closed everywhere; `require_approval` waits through `policy.pending`; no bypass mode.
5. Tamper hardening that is cheap: extension root-owned/read-only in the image, verified last in
   the handler chain, fd variable and nonce never exposed to tools, tools cannot use fd 3.
6. Tests: unit (fake channel) and integration with the real pinned Pi 1.0.0 in RPC mode.

## Design

`services/sandbox-agent/src/kobe-policy/` — the extension, self-contained (node builtins and its own
files only; a test enforces it), compiled by the package build to `dist/kobe-policy/*.js` and copied
by the image to `/opt/kobe/pi-extensions/kobe-policy/` (root, 0444 files in 0555 dirs).

| File            | Role                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------ |
| `index.ts`      | Pi entry (default export factory); one channel per Pi process (module scope)               |
| `extension.ts`  | open fd 3 (must be a socket), drop `KOBE_POLICY_FD` from env, handshake, self-check        |
| `client.ts`     | channel client: hello → ready/refused, checks by request id, pending/timeouts, fail closed |
| `handler.ts`    | the `tool_call` handler: validate ids, plain-JSON check, deep-freeze, ask, re-verify       |
| `plain-json.ts` | plain-JSON check (no getters/proxies/hidden keys/holes/…), deep freeze, stable JSON        |
| `self-check.ts` | argv: `--no-extensions` present and kobe-policy is the last `-e`                           |
| `protocol.ts`   | channel message names, limits, timeouts (shared with the agent's `policy/channel.ts`)      |
| `lines.ts`      | LF JSONL reader with a byte cap                                                            |

Agent side (KOBE-23 code, extended): `policy/channel.ts` handles `channel.ready` /
`channel.refused` and denies checks before ready; `threads/manager.ts` waits for `channel.ready`
after every spawn (30 s) and fails the command `pi_unavailable` ("kobe-policy did not start: …")
otherwise, stopping that Pi — **no prompt reaches a Pi without a working kobe-policy**;
`pi/pi-launch.ts` always appends kobe-policy as the **last** `--extension` (`policyExtension`
required; other extensions go before it); `config.ts` `KOBE_POLICY_EXTENSION` (default
`/opt/kobe/pi-extensions/kobe-policy/index.js`); `index.ts` refuses to start unless that file and
every directory above it are root-owned and not group/world-writable (`policy/extension-file.ts`).
`AgentDeps.extensions` loads further extensions before kobe-policy (KOBE-62's `builtin:mcp` seam).

Channel (JSONL on fd 3, see `kobe-policy/protocol.ts`):

```
agent → ext   {"type":"channel.hello","nonce"}
ext → agent   {"type":"channel.ready","nonce","extension":"kobe-policy","version":1}
              | {"type":"channel.refused","nonce","reason"}
ext → agent   {"type":"policy.check","nonce","request_id","tool_call_id","parent_tool_call_id"?,"tool","input"}
agent → ext   policy.pending {request_id, tool_call_id, approval_id, expires_at, …}
              policy.result  {request_id, tool_call_id, decision, reasons, message?}   (no approval token)
```

Per call: ids valid (`idSchema` rules) → input is plain JSON → **deep-freeze the very object Pi will
execute** → fingerprint (sorted-key JSON) → ask → allow only if `decision === "allow"` and
`tool_call_id` matches → re-check `event.input` is the same object with the same fingerprint →
return nothing (allow). Everything else returns `{block: true, reason: "policy.denied: …"}`.

Timeouts: hello 10 s; first answer 60 s; after `policy.pending` until `expires_at` + 60 s, capped at
1 h + 60 s (D29 TTL); the run's abort signal (`ctx.signal`) blocks at once. In-flight cap 128 (the
agent's per-thread cap); request line cap 4 MiB (the wire frame cap); reply line cap 1 MiB.

## Pi 1.0.0 facts verified (package source in `images/sandbox/pi`, and real-Pi tests)

- Hook: `pi.on("tool_call")`; `agent-session.js` `_beforeToolCall` → `runner.emitToolCall`, which
  awaits handlers **extension by extension in load order**, each extension's handlers in
  registration order, and returns at the first `{block: true}`. A handler that throws blocks the
  call. Blocked → error tool result with `reason` as text (`agent-loop.js` `prepareToolCall`).
- Load order = order of `-e` flags (`resource-loader.js` `loadFinalExtensionSet`; `builtin:<name>`
  included in place). `--no-extensions` drops discovery and built-ins; `-e builtin:codemode` /
  `builtin:mcp` load them explicitly. The built-in MCP extension has its own `tool_call` handler
  (waits for servers) — it must load before kobe-policy, which `pi-launch.ts` guarantees.
- `event.input` **is the executed object**: `validateToolArguments` returns a `structuredClone`
  after `prepareArguments` and TypeBox `Value.Convert`; that same reference goes to
  `tool.execute`. In-place mutation by an earlier handler changes what runs; **reassigning
  `event.input` changes nothing** (Pi keeps its own reference).
- **edit's legacy top-level `oldText`/`newText` is already folded into `edits[]`** (and the legacy
  keys deleted) before the hook (`prepareEditArguments`); real-Pi test "sees edit's legacy …". So
  KOBE-35's strict schema never sees the legacy form from kobe-policy. (`tool_execution_start` events
  still carry the model's original arguments.)
- Nested calls (`ctx.executeTool`, codemode scripts): each goes through `_beforeToolCall` with
  `parentToolCallId`, id `<parent>/<n>`; parallel `Promise.allSettled` calls each checked.
- `ctx.signal` is the run's abort signal in `tool_call` handlers.
- Built-ins (read, write, edit incl. legacy form, bash, ls, grep, find, codemode) run with a
  deep-frozen input.
- Tools started by Pi do not get fd 3 (bash: writing to `>&3` fails; channel unaffected).
- An async extension factory is awaited before Pi starts the session; extension `.ts` with `./x.js`
  imports load through jiti; compiled ESM `.js` loads too (image check).
- On Linux an fd 3 may exist in a Pi without the channel (libuv's epoll fd): the extension only
  touches fd 3 when `KOBE_POLICY_FD` is set and fd 3 is a socket.

## Decisions

- **Where it lives:** inside `@kobe/sandbox-agent` (`src/kobe-policy/`), compiled with the package
  and shipped as its own read-only directory; no new workspace package or bundler. It imports only
  node builtins and sibling files (test-enforced), so no `node_modules` is needed next to it.
  The channel constants live in `kobe-policy/protocol.ts` and the agent imports them (the channel is
  sandbox-internal; no `packages/protocol` change).
- **ac-2 without the HMAC in the sandbox.** The contract (approval.ts) keeps the key and the token
  out of the sandbox, and KOBE-23 strips `approval` from channel replies; "for Pi built-ins and
  kobe tools the server's `policy.result` is itself the authorisation". So the extension binds each
  decision to the call it asked about: request id → pending call, the result's `tool_call_id` must
  equal the call's, and the input that runs is the very object that was sent, frozen before the
  check and re-fingerprinted after it (swap or change → block). The signed-token check proper is the
  MCP proxy's (KOBE-58) and the server's (KOBE-37).
- **Freeze, don't replace.** The contract text says kobe-policy "replaces `event.input` with
  `JSON.parse(canonicalJson(input))`" on allow; in Pi 1.0.0 that is a no-op (see facts). Instead the
  extension refuses anything but plain JSON (so `JSON.stringify` = what the tool reads) and
  deep-freezes the executed object before asking. Contract wording to fix (below).
- **Ready handshake (agent-enforced).** A Pi extension that throws at load is reported and skipped
  by Pi, so the agent requires `channel.ready` before using a Pi; kobe-policy sends it only after
  the handshake and its self-checks pass. With a missing/invalid channel it never throws; it blocks
  every call with the reason.
- **"Verify it's last":** argv self-check (last `-e` resolves to its own file, `--no-extensions`
  present) → otherwise `channel.refused` and block everything. Within its slot, other extensions'
  later `pi.on("tool_call")` registrations still run before it (Pi orders by extension first).
- **Fail closed details:** unparsable/oversize reply line, a second `channel.hello`, stream error or
  end → channel closed for the life of that Pi; every pending and later call blocked. A module
  re-evaluation (reload) finds the fd variable gone and blocks everything.
- **Block reason format:** `policy.denied: <reason>`, the server's `message` for server denies
  (≤ 2000 chars), a local reason otherwise (`policy check timed out`, `policy channel closed`,
  `the approval expired before a decision arrived`, `the run was stopped`, …).
- **Hardening done:** `KOBE_POLICY_FD` deleted from `process.env` at load (real-Pi test: a tool sees
  it unset); nonce only in the client object; fd 3 opened only if it is a socket and `unref`'d.
  Node has no `dup`/`fcntl`, so "dup+close fd 3" is not possible from the extension; tools do not
  inherit fd 3 anyway (libuv passes only requested stdio; real-Pi test), and the nonce check
  covers a tool that is handed it.
- `KOBE_POLICY_REPLY_TIMEOUT_MS` (tests): can only shorten the 60 s first-answer wait; read once and
  deleted; never in the agent's allow-listed Pi environment.

## For other tickets

- **KOBE-24 (server, `policy.check`):** per KOBE-35, verify the actor is still a team member and
  clamp `run.approval_mode` to the install floor / team settings before `decide` (outside any
  `withTeam`); derive risk from the registry (the frame carries only tool name + input). Answer every
  check exactly once; an **allow must echo the check's `tool_call_id`** (the extension blocks
  otherwise); send `policy.pending` with `expires_at` for `require_approval`, then the final
  `policy.result`; emit the Kobe Event Stream **`policy.denied`** `{tool_call_id, tool, reasons}`
  for server denies. Sandbox-local blocks show up only as `tool.result` `is_error` with text
  `policy.denied: …` (no reason codes for them; see contract gaps). The checked input for edit is the
  normalised `{path, edits[]}`; `tool_execution_start` events carry the model's raw arguments —
  show the checked input in approval cards.
- **KOBE-37 (approvals):** the extension waits up to `expires_at` + 60 s (max 61 min) after
  `policy.pending`; the server should send a `deny` result on TTL expiry/run end (its own timer is a
  backstop only). A Stop aborts Pi's signal and blocks the waiting call immediately; a late allow is
  ignored.
- **KOBE-41 (models):** with KOBE-23's read-only `PI_CODING_AGENT_DIR`, real Pi 1.0.0 cannot use
  any provider: the prompt fails with `Credential store read failed …: EACCES` (it opens `auth.json`
  there) — even with `--model` and an extension-registered provider. Found while scripting a faux
  model; the kobe-policy integration tests use a writable config dir for that reason.
- **KOBE-62 (MCP):** pass `builtin:mcp` (and `builtin:codemode` if wanted) through
  `AgentDeps.extensions` / `ThreadEnv.extensions`; kobe-policy is appended last automatically.
  The rate limit (20/s, burst 50) and 128 in flight per thread apply to codemode fan-out.
- **KOBE-22 (pods):** nothing new; the image carries the extension.

## Contract issues (for a contracts PR; not changed here)

1. `sandbox-wire/frames.ts` `policyCheckFrameSchema` doc: "on allow it replaces `event.input` with
   `JSON.parse(canonicalJson(input))`" is a no-op in Pi 1.0.0; replace with "checks the executed
   object as is (plain JSON only) and freezes it before asking".
2. No reason code for sandbox-local denies (channel closed, timeout, extension refused) —
   `policy.denied` needs `reasons.min(1)`; suggest a `sandbox_policy_unavailable` code if the server
   should surface them as `policy.denied`.
3. `approval.ts` says kobe-policy "passes [the approval token] on where a downstream verifier (MCP
   proxy) needs it"; KOBE-23 strips it on fd 3 and the MCP proxy finds approvals by
   (run, tool_call_id) — align the wording (KOBE-58).
4. The fd-3 channel stays sandbox-internal (`kobe-policy/protocol.ts`); no move to
   `packages/protocol` proposed.

## Open risks

- Same uid as model-run tools (second-uid separation is a later ticket): in-process code is trusted;
  kobe-policy is cooperative. External effects are enforced server-side / at the MCP proxy.
- Sandbox-scoped built-ins (bash, write, edit) are enforced only here (D29: bounded by sandbox and
  egress policy).
- Codemode scripts fanning out > 50 calls quickly hit the agent's channel rate limit (excess
  denied).
- Tool-call ids longer than 128 chars (deep nesting) are blocked (`idSchema`).

## Self-review round (code-reviewer agent: 0 CRITICAL/HIGH, 2 MEDIUM, 5 LOW) — resolution

1. MEDIUM `deepFreeze` skipped already-frozen containers (a shallow-frozen parent left children
   writable): now descends everything, tracking visited objects (test "freezes all the way down").
2. MEDIUM `channel.ready` was sent before `pi.on` registered the handler: `connectPolicy` no longer
   announces; `registerKobePolicy` registers, then announces (test "does not report ready when
   registering the handler fails").
3. LOW no cancel on abort/timeout: the server's pending approval stays until the run ends or TTL
   (KOBE-37 resolves approvals when the run ends; noted above). No channel message added.
4. LOW `-0` serialises as `0`: refused (handler table row "negative zero").
5. LOW large inputs serialised several times before the 4 MiB cap: accepted (bounded by Pi/model).
6. LOW kobe-policy listed again under another spelling: `pi-launch.ts` compares resolved paths.
7. LOW eviction while waiting for ready: not reachable — every command claims its thread (busy)
   before `#ensureProcess`.
8. Repeated `policy.pending` could extend the wait indefinitely: the first pending fixes a deadline
   (`MAX_PENDING_WAIT_MS`) no later one can move (test "cannot be kept waiting forever").

## Evidence (acceptance criteria → test or command output)

`pnpm --filter @kobe/sandbox-agent test`: 228 passed, 1 skipped (root-only case) (real-Pi suites run when
`images/sandbox/pi` is installed, as in CI; CI runs them against the compiled `dist/kobe-policy`).

| AC   | Evidence                                                                                                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 | `kobe-policy.real-pi.test.ts`: allow runs only after the decision; codemode nested calls each checked (`cm1/1..3`, deny of one honoured); multi-call messages; no channel                |
| ac-1 | fail closed: connection drop, channel closed, timeout, no channel, not-last extension (real Pi); `client.test.ts`, `extension.test.ts`; agent ready gate (`agent.runs.test.ts`)          |
| ac-2 | `handler.test.ts` (frozen input, swapped `event.input` → block, plain-JSON refusals), `client.test.ts` (allow for another `tool_call_id` → deny); real Pi: mutated input checked and run |
| ac-3 | real Pi: denied write → tool error `policy.denied: Denied by team rule: …`, file not written; `handler.test.ts` reason format                                                            |
| 4    | real Pi: `policy.pending` waited through, Stop while pending blocks; `client.test.ts` pending TTL cap, abort                                                                             |
| 5    | `test-image.sh`: extension root-owned/0444/0555, agent accepts the file, Pi loads it and answers `channel.ready`; real Pi: forged `>&3` write fails, `KOBE_POLICY_FD` unset for tools    |
| 6    | `client.test.ts`, `handler.test.ts`, `extension.test.ts`, `self-check.test.ts`, `channel.test.ts`, `extension-file.test.ts`, `pi-launch.test.ts`, both real-Pi suites                    |

Image: built on the remote amd64 Docker host, `images/sandbox/test-image.sh` all `ok` (26 checks).
