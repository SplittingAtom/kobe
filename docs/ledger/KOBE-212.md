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

- `threads.ts`: `CAPABILITY_THREAD_COMPACT = "thread_compact"`, `threadCompactFocusSchema`
  (1..1000 chars, not blank, no C0/DEL except tab/LF/CR, kept as sent), request/response/error
  schemas, `COMPACT_THREAD_ERROR_CODES` + HTTP status (`thread_busy` 409, `sandbox_unavailable` 503,
  `nothing_to_compact` 409, `compaction_failed` 502). `nothing_to_compact` is an addition to the
  ticket's three codes: Pi's commonest refusal is not a failure, and the web wants to say so.
- `thread.compact` (server -> sandbox): `command_id`, `thread_id`, `focus?`, plus optional
  `run_id`, `model`, `model_limits`, `run_token` (the latter three require `run_id`). Reason: outside
  a run the agent hands Pi no gateway token and no run to bill (`#answerRunToken` cancels), so the
  summary call would fail; KOBE-213 decides how it mints the run, the contract just carries it.
- Reply is its own frame `thread.compact_result` (sandbox -> server, strict, own 1 MiB entry in
  `SANDBOX_FRAME_MAX_BYTES_BY_TYPE`), sent instead of `command.result` (documented in
  `connection.ts`). Success carries `summary?` (<= 256 KiB UTF-8; omitted when larger, the entry is
  authoritative), `first_kept_entry_id`, `tokens_before`, `estimated_tokens_after?`; Pi's `usage`
  and `details` are dropped. Failure codes: `thread_busy`, `nothing_to_compact`,
  `compaction_failed`, `model_not_configured`, `pi_unavailable`, `internal`.
- Not touched: the server's `#sizeOk` / `frameMaxBytes` and the agent dispatch. Until KOBE-213 the
  server sends no `thread.compact` and refuses a large `thread.compact_result` as before.

## Notes for KOBE-213

- Refuse `thread_busy` before sending (Pi's compact aborts a live run); the agent re-checks.
- Map Pi errors: `Nothing to compact...`/`Already compacted` -> `nothing_to_compact`; else
  `compaction_failed`. Use the slow-command timeout (agent `SLOW_COMMANDS` has `compact`, 10 min).
- `sandbox_commands.kind` has a CHECK (`0016_sandbox_wire.sql`); a durable `thread.compact` row
  needs a migration, an internal (connection-bound) command does not.
- After success, `get_entries since` to mirror the `compaction` entry.

## Evidence (acceptance criteria -> test or command output)

- ac-1: `packages/protocol/src/threads.test.ts`, `sandbox-wire/compact-frames.test.ts`, cap test in
  `sandbox-wire/frames.test.ts`; exported from `@kobe/protocol`.
- ac-2: this ledger, "Pi 1.0.0 compact RPC (verified)".
- ac-3: protocol-only diff; no server/agent/web source changed. `pnpm verify` green.
