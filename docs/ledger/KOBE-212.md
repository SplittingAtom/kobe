# KOBE-212: B8 Contract: thread.compact wire command and POST /v1/threads/{id}/compact

- **Status:** in review (PR #274)
- **Branch / worktree:** `kobe-212-compact-contract` in `../Kobe-wt212`
- **Depends on:** none. Blocks KOBE-213 (server route + agent mapping). Spec CE15.

## Plan

`packages/protocol` only, additive, tests first (KOBE-127 pattern). No server or agent change.

## Pi 1.0.0 compact RPC (verified)

Source: `@earendil-works/pi-coding-agent@1.0.0` tarball (integrity matches
`images/sandbox/pi/package-lock.json`): `docs/rpc-commands.md` "compact", `docs/json.md`
"Compaction events", `docs/session-format.md` "CompactionEntry", `dist/modes/rpc/rpc-types.d.ts`,
`dist/modes/rpc/rpc-mode.js`, `dist/core/agent-session.js` `compact()`,
`dist/core/compaction/compaction.js`, `dist/core/session-manager.js` `appendCompaction()`.

- **Command:** `{"id"?, "type":"compact", "customInstructions"?: string}`. Already in
  `piBridgeCommandSchema` (`pi.command`). RPC calls `session.compact(customInstructions)`.
- **Custom instructions: supported.** `generateSummaryWithUsage` appends
  `\n\nAdditional focus: <customInstructions>` to the summarization prompt (also the update prompt
  when a previous summary exists). So `focus` is passed verbatim as `customInstructions`, never
  dropped or prepended by Kobe. Extensions see it in `session_before_compact`.
- **Success response:** `{"type":"response","command":"compact","success":true,"data":CompactionResult}`
  with `CompactionResult = {summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter?,
usage?, details?}` (`usage` = Pi `Usage` incl. `cost`; `details` default `{readFiles, modifiedFiles}`).
  No entry id is returned.
- **Failure response:** `{"type":"response","command":"compact","success":false,"error":"<message>"}`.
  Messages seen in source: `Nothing to compact (session too small)`, `Already compacted`,
  `Compaction cancelled` (abort or extension cancel), `No model selected...`, and summarizer
  errors (raw message; the `compaction_end` event prefixes `Compaction failed: `).
- **Side effects:** `compact()` first calls `abort()` (aborts a running agent turn, retry, other
  compaction). Then emits `compaction_start {reason:"manual"}`, appends the entry, emits
  `compaction_end {reason:"manual", result, aborted:false, willRetry:false}` (failure: no `result`,
  `aborted`, `errorMessage`). RPC `abort` cancels a running compaction.
- **Entry appended:** `{type:"compaction", id, parentId, timestamp, summary, firstKeptEntryId,
tokensBefore, details?, usage?, fromHook?, systemMessage?}` (`firstKeptEntryId` = own id for
  retain-none). It is NOT announced by `entry_appended` (that event is for extension entries only):
  mirror it with `get_entries since`.
- **Model:** the summary uses the session's current model (`this.model`) through Pi's normal
  provider path, i.e. kobe-models and the gateway token.

## Decisions

- Coordinator decision (review of #274, 2026-10-14): **a compaction is a real run row (kind
  compaction)**. KOBE-213 creates it through the existing lease and run-start transaction:
  `runs_one_active_per_thread` gives `thread_busy`, `mintRunToken` mints its token in the lease
  transaction, `revokeRunTokens` at run end, `run_usage` / budget / D14 interruption / audit apply
  unchanged. The gateway's `isRunTokenActive` is not loosened. Needs a migration (run kind).
- `threads.ts`: `CAPABILITY_THREAD_COMPACT = "thread_compact"`, `threadCompactFocusSchema`
  (1..1000 chars, not blank, kept as sent; refuses C0/DEL except tab/LF/CR, U+2028/9, bidi
  controls), request/response schemas, `COMPACT_THREAD_ERROR_CODES` with HTTP status
  (`thread_busy` 409, `sandbox_unavailable` 503, `nothing_to_compact` 409, `model_not_configured`
  409, `compaction_failed` 502) and **one fixed message per code** (`COMPACT_THREAD_ERROR_MESSAGES`,
  `compactThreadError(code)`); the error schema admits only those pairs, so Pi's or the sandbox's
  text never reaches the client (log it server-side).
- `thread.compact` (server -> sandbox): `command_id`, `thread_id`, `focus?`, and **required**
  `run_id`, `model` (alias + gateway model + API), `run_token`; `model_limits?`. Sent only to agents
  announcing `thread_compact` and `run_token`.
- `compact` removed from `piBridgeCommandSchema`: a raw `pi.command` can no longer compact (or abort
  a run) around the server; it now fails decoding. The server never sent it; no agent code changed
  (`SLOW_COMMANDS` still lists `compact`, now reachable only via `thread.compact` in KOBE-213).
- Reply is its own frame `thread.compact_result` (sandbox -> server, strict, own 1 MiB entry in
  `SANDBOX_FRAME_MAX_BYTES_BY_TYPE`), sent instead of `command.result` (documented in
  `connection.ts`). Success: `summary?` (1 char..256 KiB UTF-8; omitted when larger, the entry is
  authoritative), `first_kept_entry_id` (`idSchema`), `tokens_before`, `estimated_tokens_after?`;
  Pi's `usage`/`details` dropped. Failure codes: `thread_busy`, `nothing_to_compact`,
  `compaction_failed`, `model_not_configured`, `pi_unavailable`, `internal`.
- Not touched: the server's `#sizeOk` / `frameMaxBytes` and the agent dispatch.

## Notes for KOBE-213 (from the #274 security review)

- Agent: check `thread.runId` before and inside `withLock`; the thread counts as busy for the
  whole compaction. Make the compaction run the thread's run (model file `run_id`, `#run`) and hand
  the token on request; kobe-models fetches it only on Pi `input`, which compact never fires, so add
  a fetch on `session_before_compact` or a lazy ask. Never write the token to disk or env.
- Stop/budget: `after_step` waits for `turn_end`, which compaction never emits; treat it as `abort`.
  Settle on the result or the 10 min slow timeout, then end the run and revoke the token.
- Map Pi errors: `Nothing to compact...`/`Already compacted` -> `nothing_to_compact`; else
  `compaction_failed`. Accept a result only for a `command_id` sent on that connection with a
  matching `thread_id`; add the type to `#sizeOk`.
- `sandbox_commands.kind` has a CHECK (`0016_sandbox_wire.sql`); a durable `thread.compact` row
  needs it widened. After success, `get_entries since` mirrors the `compaction` entry.
- Route: `withTeam()`, 404 across teams, only members who may post; audit `thread.compacted`;
  render the summary as sanitized markdown; mind proxy timeouts for a long synchronous 200.

## Evidence (acceptance criteria -> test or command output)

- ac-1: `packages/protocol/src/threads.test.ts`, `sandbox-wire/compact-frames.test.ts`, cap test in
  `sandbox-wire/frames.test.ts`; exported from `@kobe/protocol`.
- ac-2: this ledger, "Pi 1.0.0 compact RPC (verified)".
- ac-3: protocol-only diff; no server/agent/web source changed (only `compact` left the bridge
  allow-list, which the server never sent). `pnpm verify` green.
