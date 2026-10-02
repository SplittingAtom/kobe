# Contracts: shared protocol interfaces (wave 0)

- **Status:** in review (PR #13)
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
  `starting_after` wins over `Last-Event-ID`; stream closes after a terminal `run.*` event.
- **Deltas carry `message_id`, not `entry_id`:** verified Pi 1.0.0 RPC exposes no entry id until the
  entry is persisted; `entry.committed` binds `message_id` → `entry_id`.
- **Stop** emits `run.interrupted {reason: "cancelled", retryable: false}` with run status
  `cancelled` (§6.2 has no `run.cancelled`). Approval expiry → run `failed`.
- **Canonicalisation:** RFC 8785 JCS + strict JSON-only, lone surrogates rejected, no Unicode
  normalisation, depth ≤ 128. Signing bytes = UTF-8 JCS of
  `["kobe.approval.v1", run_id, tool_call_id, input]`; HMAC-SHA256, base64url; `kid` for rotation.
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

## Open questions (for Chris or the coordinator)

1. §6.2 shows `entry_id` on `text.delta`; contract uses `message_id` (Pi limitation). OK?
2. No `run.cancelled` event type: Stop uses `run.interrupted{reason:"cancelled"}`. Add a type
   instead?
3. MCP proxy second enforcement (D29): token via `_meta` (`kobe.dev/approval`) or proxy lookup by
   (run, input HMAC)? KOBE-58 to decide.
4. KOBE-29 needs `runs.retry_of_run_id` (nullable) for the new-run retry model, and `run_events.seq`
   per run.

## Evidence (acceptance criteria → test or command output)

- `pnpm --filter @kobe/protocol test`: canonical JSON (RFC 8785 vectors, key order, numbers,
  Unicode, rejections), approval golden MACs (independently computed), event payload/envelope/SSE
  /cursor, full transition matrix, policy schemas, wire frames both directions, fakes.
