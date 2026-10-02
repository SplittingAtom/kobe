# @kobe/protocol

Shared contracts between Kobe's processes: types, zod schemas for everything that crosses a process
or network boundary, a few pure helpers that _define_ a format (canonical JSON, glob grammar, SSE
framing, state tables), and in-memory fakes for tests. No behaviour: implementations live in the
consuming services.

**Rule:** a published contract changes only in its own PR, never inside a feature PR
([docs/parallel-work.md](../../docs/parallel-work.md)). Additive, optional fields are still a
contract PR. Anything marked _SPECULATIVE_ in a doc comment is owned by the named ticket, which may
settle it in its contract PR.

| Contract              | Module                                                                                                | Key exports                                                                                                                                                   | Consumers                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Sandbox ↔ server wire | `src/sandbox-wire/` (`connection.ts`, `frames.ts`, `pi-rpc.ts`, `pi-events.ts`, `codec.ts`)           | frame schemas, `decodeSandboxFrame`, `decodeServerFrame`, `parseTranslatedPiEvent`, `piGetEntriesDataSchema`, `SANDBOX_CLOSE_CODES`                           | KOBE-23, KOBE-24, KOBE-36, KOBE-41, KOBE-62 |
| Session tokens        | `src/session-token.ts`                                                                                | `SESSION_TOKEN_AUDIENCES`, `sessionTokenClaimsSchema`, `acceptsAudience`                                                                                      | KOBE-22, KOBE-24, KOBE-38, KOBE-40, KOBE-58 |
| Kobe Event Stream     | `src/events.ts`, `src/sse.ts`                                                                         | `KOBE_EVENT_TYPES`, `EVENT_PAYLOAD_SCHEMAS`, `kobeEventSchema`, `formatSseEvent`, `resolveResumeCursor`, `decideStreamOpen`                                   | KOBE-31, KOBE-32, KOBE-55, KOBE-30          |
| Run orchestrator      | `src/runs.ts`, `src/run-orchestrator.ts`                                                              | `RUN_STATUSES`, `RUN_TRANSITIONS`, `canTransition`, `ThreadStatus`, `nextThreadStatus`, `queueMayAdvance`, `checkRetry`, `RunOrchestrator`                    | KOBE-30, KOBE-26, KOBE-42, KOBE-64, KOBE-10 |
| Policy decision       | `src/policy.ts`, `src/tools.ts`, `src/glob.ts`                                                        | `policyInputSchema`, `policyDecisionSchema`, `PolicyEngine`, `BUILTIN_TOOLS`, `ToolRegistry`, `matchGlob`, `argPatternSchema`, `matchesArgPattern`            | KOBE-35, KOBE-36, KOBE-37, KOBE-58, KOBE-65 |
| Approval signing      | `src/canonical-json.ts`, `src/json-safety.ts`, `src/approval.ts`, `src/node/` (`@kobe/protocol/node`) | `canonicalJson`, `toolInputSchema`, `approvalSigningBytes`, `approvalTokenSchema`, `ApprovalStore`, `signApproval`, `verifyApproval`, `authorizeApprovedCall` | KOBE-37, KOBE-58, KOBE-36                   |
| Test fakes            | `src/testing/` (`@kobe/protocol/testing`)                                                             | `createInMemoryEventLog`, `createFakeRunOrchestrator`, `createFakePolicyEngine`, `EVENT_PAYLOAD_EXAMPLES`, `EXAMPLE_IDS`                                      | tests of all of the above                   |

Entry points: `@kobe/protocol` is browser-safe (the web app imports it); `@kobe/protocol/node`
uses `node:crypto` and must never be imported by sandbox code (the approval key never enters a
sandbox); `@kobe/protocol/testing` is for tests only.

## Database columns these contracts expect (beyond KOBE-29)

| Column                                        | Added by   | Contract                                                      |
| --------------------------------------------- | ---------- | ------------------------------------------------------------- |
| `runs.sandbox_seq integer NOT NULL DEFAULT 0` | KOBE-23/24 | durable inbound wire cursor, same transaction as `run_events` |
| `runs.approval_mode`                          | KOBE-30    | effective mode fixed at run creation (`RunSnapshot`)          |
| `runs.user_entry_id text NULL`                | KOBE-30    | the prompt entry a run answers                                |
| `runs.retry_of_run_id uuid NULL UNIQUE`       | KOBE-26    | at most one retry per run                                     |
| `approvals.consumed_at timestamptz NULL`      | KOBE-37    | single-use approvals (`ApprovalStore.consume`)                |
| `tool_rules.arg_pattern jsonb`                | KOBE-35    | `argPatternSchema` (JSON Pointer → glob), never a regex       |

## Approval signing (D29)

`mac = base64url(HMAC-SHA256(key, UTF-8(canonicalJson(["kobe.approval.v1", team_id, run_id, tool_call_id, tool, expires_at, input]))))`

`canonicalJson` is RFC 8785 (JCS): keys sorted by UTF-16 code units, ECMAScript number form, no
whitespace, `JSON.stringify` string escaping. On top: only plain JSON values (no `undefined`,
non-finite numbers, class instances, sparse arrays, `__proto__` keys), lone surrogates rejected,
**no Unicode normalisation**, depth ≤ 128. The executor forwards exactly
`JSON.parse(canonicalJson(input))`. Verification = stateless (`verifyApproval`: binding, expiry,
MAC) + stateful (`authorizeApprovedCall`: row `allowed`, matching `input_hmac`, run active,
consumed once). Golden vectors in `src/canonical-json.test.ts` and `src/approval.test.ts` (MACs
computed independently with Python's `hmac`).

## Pi RPC

Pi shapes in `src/sandbox-wire/pi-rpc.ts`, `pi-events.ts` and the built-in tool table in
`src/tools.ts` were checked against the published `@earendil-works/pi-coding-agent@1.0.0` tarball
(pinned in `images/sandbox/pi`). The bridge validates envelopes, narrows the events the server
translates, and passes other Pi payloads through so Pi 1.0.x patches don't break it.
