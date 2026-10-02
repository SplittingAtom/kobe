# Contracts: shared protocol interfaces (wave 0)

- **Status:** in review (PR #13), review round 1 addressed
- **Branch / worktree:** `kobe-contracts` in `../Kobe-wt-contracts`
- **Depends on:** — (KOBE-29 runs in parallel; it takes run states and event names from here)

## Plan

Types + zod schemas + in-memory fakes in `packages/protocol` for four contracts, so wave-1 tickets
build in parallel: sandbox ↔ server wire (KOBE-23/24/36/41/62), Kobe Event Stream payloads + SSE
(KOBE-31/32/55/30), run orchestrator + state machine (KOBE-30/26/42/64/10), policy decision +
approval token (KOBE-35/36/37/58/65). Map and rules in `packages/protocol/README.md`.

## Decisions

- **Run states** = spec §5.4 exactly: `queued, running, waiting_approval, completed, failed,
interrupted, cancelled, budget_stopped`. Terminal: the last five. Retry of an `interrupted` run
  creates a **new run** with `retry_of_run_id` (terminal states have no exits).
- **Transitions:** queued → running | failed | cancelled | budget_stopped; running →
  waiting_approval | completed | failed | interrupted | cancelled | budget_stopped;
  waiting_approval → running | failed (incl. approval expired) | interrupted | cancelled |
  budget_stopped. Each edge has named causes (`RUN_TRANSITIONS`).
- **Event envelope** `{run_id, seq, ts, type, payload}` is the SSE `data:` body; `id:` = seq,
  `event:` = type. seq per run from 1, strictly increasing; clients dedupe `seq <= last`.
  cursor = max(`starting_after`, `Last-Event-ID`); stream closes after a terminal `run.*` event.
- **Deltas carry `message_id`, not `entry_id`:** verified Pi 1.0.0 RPC exposes no entry id until the
  entry is persisted; `entry.committed` binds `message_id` → `entry_id`.
- **Stop** emits `run.interrupted {reason: "cancelled", retryable: false}` with run status
  `cancelled` (§6.2 has no `run.cancelled`). Approval expiry → run `failed`.
- **Canonicalisation:** RFC 8785 JCS + strict JSON-only, lone surrogates rejected, no Unicode
  normalisation, depth ≤ 128. Signing bytes = UTF-8 JCS of
  `["kobe.approval.v1", team_id, run_id, tool_call_id, tool, expires_at, input]` (review round 1);
  HMAC-SHA256, base64url; `kid` for rotation.
  Sign/verify only in `@kobe/protocol/node`; the sandbox never holds the key.
- **Wire:** one outbound WSS per sandbox at `/v1/sandbox/connect`, Bearer session token on the
  upgrade (not in the URL), subprotocol `kobe.sandbox.v1`; per-run outbound `seq` + cumulative
  `ack` for resume; `pi.command` admits only an allow-list of Pi RPC commands (no `bash`,
  `switch_session`, `prompt`); `require_approval` never reaches the sandbox (server holds the
  `policy.check` and sends `policy.pending`, then `policy.result`).
- **Policy order reading:** deny rule → deny; ask rule → require_approval (user allow cannot remove);
  user allow can only remove prompts from risk class / mode. `auto` and scheduled runs never get
  `require_approval` (deny instead).
- zod `^4.0.0` added to `@kobe/protocol` (MIT); already used by every service.

## Pi RPC: verified vs assumed

Verified from the `@earendil-works/pi-coding-agent@1.0.0` tarball: JSONL framing (LF only, not
`readline`), command/response shapes and `id` correlation, `prompt` dispositions and
`streamingBehavior`, `steer`/`follow_up`/`abort`/`get_entries(since)`/`fork`, session events incl.
`agent_settled`, delta-only `message_update`, extension UI request/response, session entry v3 base,
`tool_call` handler `{block, reason}` with mutable `event.input`, nested call ids `<parent>/<n>`,
MCP annotation defaults. **Assumed:** how kobe-policy talks to kobe-sandbox-agent inside the sandbox
(local IPC, KOBE-36), whether Pi's MCP client can attach the approval token to `tools/call`
(KOBE-58), how edit-and-regenerate maps onto Pi `fork` (KOBE-23).

## Review round 1 (coordinator, 3 HIGH + MEDIUM/LOW) — resolution

1. HIGH approval binding/replay: signed tuple is now `["kobe.approval.v1", team_id, run_id,
tool_call_id, tool, expires_at, input]` (tag kept at v1: nothing was published); token carries
   `team_id`, `tool`, `expires_at` (10 min after allow, speculative). Normative two-half
   verification: `verifyApproval` (binding, expiry, MAC) + `authorizeApprovedCall` over an
   `ApprovalStore` (row `allowed`, matching `input_hmac`, run active, consumed once via
   `approvals.consumed_at`). New golden vectors, recomputed in Python.
2. HIGH sandbox-supplied risk: `policy.check` carries tool name + input only. Server derives
   `ToolDescriptor` from `BUILTIN_TOOLS` (Pi 1.0.0 names verified: bash, read, edit, write, grep,
   find, ls, powershell, codemode, tool_search, MCP resource tools; kobe-tools) or the pinned MCP
   snapshot; unknown → deny (`unknown_tool`). Added `scope` (sandbox/kobe/external).
3. HIGH wire resume: `runs.sandbox_seq` (KOBE-23/24), updated in the same transaction as the
   appended rows; `seq <= sandbox_seq` dropped (still acked); gap → error. In README column table.
4. Schema reconcile: Kobe ids are uuids; `approval_mode` (KOBE-30), `user_entry_id` (KOBE-30),
   `retry_of_run_id` (KOBE-26, unique) marked; null agent = install default in `run.started`,
   policy input and thread config.
5. Executed = `JSON.parse(canonicalJson(input))`; `toolInputSchema` rejects U+0000, `__proto__`,
   unsafe integers; canonicalJson rejects `__proto__`; frames reject duplicate keys.
6. SSE cursor = max(`starting_after`, `Last-Event-ID`).
7. Ended run with nothing after cursor → 204 (EventSource stops); compacted run → 410
   `events_compacted`, client renders entries. `decideStreamOpen`.
8. `ThreadStatus` + `nextThreadStatus`; `interrupted` blocks the queue; Retry runs first;
   `resumeQueue` ("Continue without retry", speculative). Fake fixed.
9. `checkRetry`: latest ended run only, interrupted only, once; repeat returns the existing retry.
10. U+0000: rejected by `decodeSandboxFrame`, tool-input and HTTP body schemas; the agent maps it to
    U+FFFD in Pi output.
11. Leasing rule + close code `lease_violation` (4007).
12. `piThreadConfigSchema` strict, no URLs (agent builds the MCP proxy URL from env + connector id),
    bounded system prompt, skill-name regex.
13. `parseTranslatedPiEvent` (narrow schemas for the translated Pi events) and
    `piGetEntriesDataSchema`.
14. Glob grammar (`*`, `?`, `\` escape; anchored, linear-time) for tool globs; `arg_pattern` =
    `{JSON Pointer: glob}` over string value or canonical JSON. No regex.
15. Session tokens: one per audience (`kobe.sandbox-wire`, `kobe.model-gateway`, `kobe.mcp-proxy`,
    `kobe.egress-proxy`), claims schema, `acceptsAudience`.
16. Pending approvals expire with a cause when the run ends (`approval.resolved.cause`).
17. `tool.call` / `approval.requested` input use `toolInputSchema`.

- WS-layer frame cap noted for KOBE-23/24 (`maxPayload`).

## Review round 2 (coordinator, at 2b27e53) — resolution

1. Decoder DoS: `findJsonSafetyIssue` is iterative (no spread) and depth-limited; `scanJsonText`
   pre-scans nesting (≤ 128) and duplicate keys before `JSON.parse`/zod; `decodeSandboxFrame` /
   `decodeServerFrame` never throw (exceptions → `malformed_frame`). Tests: 1.5M-element flat array,
   200k nested arrays, 150 nested objects.
2. MCP names: `connectorNameSchema` (no `__`, no leading/trailing separator), `mcpServerSegment`,
   `parseMcpToolName`; resolution normatively by (run's connector map → connector_id, Pi tool name
   in pinned snapshot).
3. `ApprovalStore.consume` is one conditional UPDATE (unconsumed, `allowed`, run active); failure
   reason renamed `not_consumable`.
4. MCP proxy normative order (parseJsonStrict → toolInputSchema → registry → policy →
   authorizeApprovedCall → forward canonical form); `verifyApproval` rejects invalid inputs.
5. `policyInputSchema` requires `connector_id` and `connector_exposure` for MCP tools.
6. Cursor CAS statement; gaps on a live socket answered with new `resend` frame.
7. Leases: command ids per connection; lease ends at terminal; late frames → `run_not_active`
   (late `policy.check` also gets `deny`); never-leased ids → `lease_violation`.
8. Session tokens: pin the algorithm, reject `none`, ignore embedded key URLs.

## Open questions (for Chris or the coordinator)

1. §6.2 shows `entry_id` on `text.delta`; contract uses `message_id` (Pi limitation). OK?
2. No `run.cancelled` event type: Stop uses `run.interrupted{reason:"cancelled"}`. Add a type
   instead?
3. MCP proxy carries the token via `_meta` (`kobe.dev/approval`) if Pi's MCP client can attach it;
   otherwise the proxy finds the approval by (run, tool_call_id). KOBE-58 to decide.
4. After Stop, queued messages start (D17 "queued messages remain" read as "not deleted"). Or should
   Stop also pause the queue like `interrupted`?
5. Tool `scope`: in `ask-on-write`, sandbox-local tools (bash, write) are not prompted by risk class
   alone (D29: "bounded by the sandbox and egress policy"). KOBE-35 to confirm.
6. Agent-file shorthand `bash:rm -rf*` (§6.3) maps to tool glob + `primary_arg` glob (KOBE-45).
7. Review items 16, 17 and 19 were not restated in the review message; left open for the
   coordinator.

## Evidence (acceptance criteria → test or command output)

- `pnpm --filter @kobe/protocol test` (380 tests): canonical JSON (RFC 8785 vectors, key order, numbers,
  Unicode, rejections), approval golden MACs (independently computed), event payload/envelope/SSE
  /cursor, full transition matrix, policy schemas, wire frames both directions, fakes.
