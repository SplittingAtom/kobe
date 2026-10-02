# @kobe/protocol

Shared contracts between Kobe's processes: types, zod schemas for everything that crosses a process
or network boundary, a few pure helpers that _define_ a format (canonical JSON, SSE framing), and
in-memory fakes for tests. No behaviour: implementations live in the consuming services.

**Rule:** a published contract changes only in its own PR, never inside a feature PR
([docs/parallel-work.md](../../docs/parallel-work.md)). Additive, optional fields are still a
contract PR. Anything marked _SPECULATIVE_ in a doc comment is owned by the named ticket, which may
settle it in its contract PR.

| Contract              | Module                                                                          | Key exports                                                                                                                  | Consumers                                                 |
| --------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Sandbox ↔ server wire | `src/sandbox-wire/` (`connection.ts`, `frames.ts`, `pi-rpc.ts`, `codec.ts`)     | `sandboxToServerFrameSchema`, `serverToSandboxFrameSchema`, `decodeSandboxFrame`, `decodeServerFrame`, `SANDBOX_CLOSE_CODES` | KOBE-23, KOBE-24, KOBE-36, KOBE-41, KOBE-62               |
| Kobe Event Stream     | `src/events.ts`, `src/sse.ts`                                                   | `KOBE_EVENT_TYPES`, `EVENT_PAYLOAD_SCHEMAS`, `kobeEventSchema`, `KobeEvent<T>`, `formatSseEvent`, `resolveResumeCursor`      | KOBE-31, KOBE-32, KOBE-55, KOBE-30                        |
| Run orchestrator      | `src/runs.ts`, `src/run-orchestrator.ts`                                        | `RUN_STATUSES`, `RUN_TRANSITIONS`, `canTransition`, `RunOrchestrator`, `RunSnapshot`, §6.1 body schemas                      | KOBE-30, KOBE-26, KOBE-42, KOBE-64, KOBE-10 (and KOBE-29) |
| Policy decision       | `src/policy.ts`                                                                 | `policyInputSchema`, `policyDecisionSchema`, `PolicyEngine`, `riskFromAnnotations`, `approvalResolutionBodySchema`           | KOBE-35, KOBE-36, KOBE-37, KOBE-58, KOBE-65               |
| Approval signing      | `src/canonical-json.ts`, `src/approval.ts`, `src/node/` (`@kobe/protocol/node`) | `canonicalJson`, `approvalSigningBytes`, `approvalTokenSchema`, `signApproval`, `verifyApproval`                             | KOBE-37, KOBE-58, KOBE-36                                 |
| Test fakes            | `src/testing/` (`@kobe/protocol/testing`)                                       | `createInMemoryEventLog`, `createFakeRunOrchestrator`, `createFakePolicyEngine`, `EVENT_PAYLOAD_EXAMPLES`                    | tests of all of the above                                 |

Entry points: `@kobe/protocol` is browser-safe (the web app imports it); `@kobe/protocol/node`
uses `node:crypto` and must never be imported by sandbox code (the approval key never enters a
sandbox); `@kobe/protocol/testing` is for tests only.

## Approval canonicalisation (D29)

`mac = base64url(HMAC-SHA256(key, UTF-8(canonicalJson(["kobe.approval.v1", run_id, tool_call_id, input]))))`

`canonicalJson` is RFC 8785 (JCS): keys sorted by UTF-16 code units, ECMAScript number form, no
whitespace, `JSON.stringify` string escaping. On top: only plain JSON values (no `undefined`,
non-finite numbers, class instances, sparse arrays), lone surrogates rejected, **no Unicode
normalisation**, depth ≤ 128. Golden vectors are in `src/canonical-json.test.ts` and
`src/approval.test.ts` (MACs computed independently with Python's `hmac`).

## Pi RPC

Pi shapes in `src/sandbox-wire/pi-rpc.ts` were checked against the published
`@earendil-works/pi-coding-agent@1.0.0` tarball (pinned in `images/sandbox/pi`). The bridge validates
envelopes and passes Pi payloads through so Pi 1.0.x patches don't break it.
