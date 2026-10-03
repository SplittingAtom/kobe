# KOBE-37: Approvals: signing, TTL, remember, UI

- **Status:** in review
- **Branch / worktree:** `kobe-37-approvals` in `../Kobe-wt37`
- **Depends on:** KOBE-35 (engine, rules, `insertUserAllowRule`), KOBE-36 (kobe-policy), KOBE-24
  (wire, `ApprovalBroker` seam), KOBE-30 (orchestrator), KOBE-31 (event stream), KOBE-32 (web
  chat), KOBE-15 (audit), #42 (install approval floor). All merged.

## Acceptance criteria (spec D29, D6, D8, D14, D30, §5.2, §5.4, §6.1, §6.2; coordinator brief)

1. **ac-1** A real `ApprovalBroker` replaces `DENY_APPROVALS`: `require_approval` → pending row,
   `policy.pending`, wait, `policy.result` allow/deny.
2. **ac-2** Pending approvals in a team table (`team_id NOT NULL`, ENABLE + FORCE RLS, probe green).
3. **ac-3** HMAC over the canonical input, canonicalisation specified, tested against tampering
   (changed input, replayed tool_call_id, different run, expired).
4. **ac-4** TTL 1 h: expiry is a deny and the run ends visibly.
5. **ac-5** Remember rules as the spec scopes them (user × exact tool × optional arg pattern ×
   expiry; revocable).
6. **ac-6** Who may approve (D29, D8).
7. **ac-7** Approval events on the Kobe Event Stream + approve/deny UI in the web chat on
   assistant-ui's tool-call UI, with the existing protocol types.
8. **ac-8** Stop / interruption while pending.
9. **ac-9** An audit event for every request, decision and expiry.
10. **Gate 2** A sandbox with a tampered kobe-policy cannot execute an MCP write without a signed
    approval: proven by the server-side check; a verify seam for KOBE-58.
11. **E2E** A policy rule requiring approval pauses a tool call until an approval arrives through
    the API; denial ends it denied (`e2e/run.sh` "approvals (KOBE-37)").
12. **User decision** sandbox tools ask only when a policy rule says so.

## Design

Operator/developer doc: [docs/approvals.md](../approvals.md). Code in
`services/server/src/approvals/`:

| File         | Role                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `broker.ts`  | `ApprovalBrokerImpl` (the wire seam): canonicalise, insert pending, `running → waiting_approval`, `approval.requested`, audit; wait (hint/poll/TTL/abort) |
| `decide.ts`  | `POST /v1/approvals/{id}` (sign on allow, remember, `approval.resolved`, run back to `running`, hint, audit), get, list                                   |
| `expiry.ts`  | TTL expiry (`→ failed approval_expired`, durable abort, queue advance), aborted-connection expiry, the sweep                                              |
| `run-end.ts` | leaf: `expireRunApprovalsInTx` + `auditExpiredApprovals`, called by every run-ending path                                                                 |
| `verify.ts`  | **KOBE-58 seam**: `createApprovalVerifier().authorize(call)` and `enforceMcpCall(engine, verifier, input)`                                                |
| `store.ts`   | rows, `tokenOf(row)`, `loadApprovalRecord`, `consumeApprovalInTx` (the contract's one conditional UPDATE)                                                 |
| `keys.ts`    | `KOBE_APPROVAL_KEY` → `{kid: "a-"+sha256[0..12], secret}`                                                                                                 |
| `service.ts` | `ApprovalService` composes them; `deps.approvals`; late-bound router + `runs.onRunEnded`                                                                  |
| `view.ts`    | API view (zod) — never the token/MAC                                                                                                                      |

- **Table** `approvals` (`packages/db/src/schema/approvals.ts`, policy area, migrations
  `0030_approvals` + `0031_approvals_rls`): PK `(team_id, id)`, FK run/thread (cascade),
  `UNIQUE (team_id, run_id, tool_call_id)` (no second approval for a replayed id), `input_canonical`
  **text** (the signed bytes; not jsonb, which would re-normalise), token state (`token_kid`,
  `token_expires_at`, `input_hmac`), `consumed_at`, checks tying status ↔ decided/decided_by/token.
- **Run hooks:** `applyTransition` (orchestrator: Stop, budget, failures, TTL) and `endRunInTx`
  (wire: settled, failed, interrupted) expire the run's pending approvals before the terminal event;
  `stopForBudget` expires them for active runs and returns `waiting_approval → running` so the step
  can finish (D30). `endRunInTx` completes a run Pi settled while an orphaned approval was still
  `pending` (`waiting_approval → completed` via running).
- **Bus:** new hint kind `apr:<approval_id>` on the sandbox channel; `ApprovalBroker.onHint` /
  `onResync` (optional) added to the internal broker interface.
- **Wire fix:** `buildInput` now passes `context.connector_exposure: "all"` for MCP tools (required
  by `policyInputSchema`; the engine applies the stricter of it and the team's real exposure). Before
  this every MCP `policy.check` was `invalid_input`.
- **Config:** `KOBE_APPROVAL_KEY` (server process; optional; ≥ 32 chars). Chart: `approval-hmac` in
  the generated sandbox session-keys Secret, mounted on the server only, `optional: true`.
- **Web:** `components/chat/approval-card.tsx` inside the assistant-ui tool-call card
  (`ToolCallCard` → `ApprovalSlot`): tool, risk, reasons, the exact input, expiry, Allow / Deny,
  "Always allow <tool>" for 1 day / 30 days / until revoked; resolved/expired states by cause.
  `ChatApi.getApproval/decideApproval`; `input` is opaque in `camelizeKeys`.
- **API:** `GET /v1/approvals?status=&run_id=`, `GET /v1/approvals/{id}`, `POST /v1/approvals/{id}`
  (`team.chat`; `routes/approvals.ts`; OpenAPI `openapi/approvals.ts`).

## Decisions

- **User decision (Chris, 2026-10-03): sandbox tools (bash, file writes) ask for approval only
  when a policy rule says so; there is no default approval prompt for sandbox tools.** Defaults
  already match (KOBE-35 `promptSandboxWrites = false`, open question (b) there is hereby closed);
  the setting's doc comment, docs/approvals.md and the test "never prompts for sandbox tools unless
  a policy rule asks" record it. No rules are seeded. Reading: an explicit `ask-all` mode or the
  install switch `promptSandboxWrites: true` are policy choices an admin/user makes, so they still
  prompt (flagged below).
- **Who may approve: only the run's user** (thread owner). The call runs in their sandbox with their
  connector credentials (D11, D27); D8 gives no team or install role consent for another person;
  install admins can't read team content. Others get 404 (as for a thread they can't see).
- **Canonicalisation = the protocol's** (`canonical-json.ts`, RFC 8785 + Kobe strictness: no NFC,
  no `__proto__`, depth 128). Signed tuple `["kobe.approval.v1", team, run, tool_call_id, tool,
expires_at, input]` unchanged. Known-answer vector in `approvals/signing.test.ts`.
- **What is signed:** the input as the policy check received it, stored canonical; at decision time
  the server re-canonicalises the stored text and refuses to sign if it differs.
- **The token never goes to the sandbox** (approval.ts: "neither the key nor the token ever enters
  a sandbox"): the broker's `allow` carries no `approval`; the MCP proxy finds the approval by
  (run, tool_call_id). Built-in/kobe tool approvals are marked consumed at allow time (their
  `policy.result` is the authorisation); MCP approvals stay consumable once.
- **Token TTL** stays `APPROVAL_TOKEN_TTL_MS` = 10 min from the decision (speculative constant kept).
- **TTL expiry ends the run `failed`** (`approval_expired`, `run.failed {code: approval_expired}`),
  durable abort (`runs.stop_mode`, re-sent by the orchestrator sweep), router `run.stop` with reason
  `approval_expired`, then `runs.onRunEnded` (queue advances). Other pending approvals of the run
  expire with cause `ttl`.
- **User denial does not end the run:** the call fails `policy.denied: … You denied this tool
call`, `policy.denied` is appended, the run goes back to `running` (Pi continues).
- **Connection lost while pending:** the agent denies locally (KOBE-23); the server expires the
  approval (`run_interrupted`) and returns the run to `running` (it resumes on reconnect or the wire
  interrupts it). On server shutdown the broker waits for those writes (`broker.close()`).
- **Input too large to review** (> 192 KiB canonical; the event payload cap is 256 KiB): denied with
  a clear message rather than storing by reference (needs a protocol change; flagged).
- **Remember:** allow only (400 with deny); `tool_glob` must equal the tool (KOBE-35
  `rememberGlobAllowed`); `arg_pattern`/`expires_in` passed through; same transaction; audited by
  `policy.rule.created` + `approval.decided {remember, ruleId}`. The UI offers exact-tool remember
  with an expiry choice (no arg-pattern editor in v1).
- **Deny reason codes:** the contract has no `approval_denied`/`approval_expired` code; denials
  repeat the prompting reasons with the explanation in `message` (budget uses `budget_exhausted`).
- **Audit actions** (new category `approval`): `approval.requested`, `.decided`, `.expired`,
  `.consumed`, `.rejected` (throttled per run+reason, 5 min). Requested/expired/consumed/rejected
  are system events; decided is the user's.
- **Sweep:** each replica sweeps every ~30 s (jittered) for pending approvals past `expires_at` + 5 s
  (the waiting replica's own timer goes first).

## For other tickets

- **KOBE-58 (MCP proxy) — the verify seam.** For each MCP `tools/call`, after `parseJsonStrict`,
  `toolInputSchema`, own registry: re-run the engine with `enforcement_point: "mcp_proxy"` and
  `connector_exposure`; on `require_approval` call
  `deps.approvals.verifier.authorize({teamId, userId, runId, toolCallId, tool, input})` (or the
  composed `enforceMcpCall(engine, verifier, policyInput)` in `approvals/verify.ts`) with the call
  as the proxy sees it (team/user from its verified session token). `{ok:true}` → forward exactly
  `JSON.parse(canonicalJson(arguments))`; `{ok:false, reason}` → refuse. The seam looks the approval
  up by (team, run, tool_call_id), checks the user, rebuilds the token from the row and runs
  `@kobe/protocol/node` `authorizeApprovedCall` with a DB `ApprovalStore`; it audits
  `approval.consumed` / `approval.rejected`. If the proxy is a separate process, reuse
  `authorizeApprovedCall` + the SQL in `approvals/store.ts` (`loadApprovalForCall`,
  `loadApprovalRecord`, `consumeApprovalInTx`) and mount `KOBE_APPROVAL_KEY` from the
  `approval-hmac` key of the session-keys Secret. The proxy needs `run_id` and `tool_call_id` of the
  call: Pi's MCP client must send them (e.g. `params._meta`), or the proxy must map its own request
  to them — the token itself is never in the sandbox.
- **KOBE-56 (memory):** project-memory writes prompt in `ask-on-write` (kobe-scoped write) and use
  this flow unchanged; personal `remember` with `scope: "personal"` doesn't prompt (KOBE-35).
  `memory.updated` is unaffected. If `remember`'s input can exceed 192 KiB, it will be denied when
  it needs approval.
- **KOBE-59:** MCP descriptors from the catalog flow through as is; risk comes from the registry.
- **KOBE-41/42 (budgets):** `stopForBudget` expires pending approvals for you.
- **KOBE-20 (policy console):** members can revoke remember-rules at `/v1/team/policy/my-rules`.

## Open questions (for Chris or the coordinator)

1. **`ask-all` and the install switch still prompt sandbox tools.** The user decision says sandbox
   tools ask only when a policy rule says so; I read an explicit `ask-all` mode or
   `promptSandboxWrites: true` as such policy. If `ask-all` should _not_ prompt sandbox tools, that
   is a one-line change in `policy/evaluate.ts` (KOBE-35).
2. **Contract gaps (protocol PR, not changed here):** no reason codes for "denied by the user" and
   "approval expired" (`approval_denied`, `approval_expired` suggested); `approval.requested.input`
   can't carry inputs over ~200 KiB (needs a `blob_ref`/`truncated` form or `GET /v1/approvals/{id}`
   as the source); no `approval.resolved` cause for "the connection closed" (used
   `run_interrupted`); `approval.ts` wording "kobe-policy passes the token on" (the token now never
   leaves the server); how Pi's MCP client gives the proxy `run_id`/`tool_call_id` (KOBE-58/62).
3. **Orphaned approval after a replica crash:** if the waiting replica dies, the agent denies the
   call locally on disconnect, but the row stays `pending` (run `waiting_approval`) until the
   sandbox's run settles (completes from `waiting_approval`) or the TTL sweep fails the run. Rare;
   a `waiter_replica` column could detect it earlier.

## Self-review (code-reviewer agent: 0 CRITICAL, 1 HIGH, 2 MEDIUM) — resolution

1. HIGH: a resumed card (input dropped from the resume point) showed `{}` while Allow was enabled.
   Allow now stays off until `GET /v1/approvals/{id}` returned the exact input. The card shows
   "Loading the exact input…" while it waits, and "could not be loaded" with Try again if the
   request fails. Deny stays available. Test: "keeps Allow off until the exact input is loaded…".
2. MEDIUM: a TTL expiry that found its run `running` threw on `approval_expired`, which only
   `waiting_approval` allows, so the expiry would roll back on every poll. Such a run now fails
   with cause `error`.
3. MEDIUM (accepted): an MCP approval allowed in the instant before the sandbox's connection closed
   stays `allowed`, unconsumed, until its 10-minute token or the run ends. Using it needs the exact
   approved input and tool call id, so this is what the user approved.

## Evidence (acceptance criteria → test or command output)

| AC        | Evidence                                                                                                                                                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1      | `approvals.db.test.ts` "allow: pending → card event → API on another replica → signed allow; run resumes; audited" (two replicas, bus hint), "deny: …"                                                                                                                                                                           |
| ac-2      | `@kobe/db test:db` 405/405 incl. probe suite with the `approvals` fixture; `0031_approvals_rls.sql`                                                                                                                                                                                                                              |
| ac-3      | `approvals/signing.test.ts` (known-answer vector; changed value, added arg, NFD, number, replayed id, other run, other tool, expired, rotated key); protocol `approval.test.ts`; db: "a replayed tool_call_id can't ask again"                                                                                                   |
| ac-4      | "TTL: past 1 h the call is denied and the run fails visibly …" (`run.failed approval_expired`, `run.stop approval_expired`, thread idle, audit, late decision 409); "the sweep expires an approval nobody waits on"                                                                                                              |
| ac-5      | "approve and remember writes a user allow rule for exactly this tool; the next call runs" (too broad → 400, expiry stored, audit `ruleId`, ask rule still wins)                                                                                                                                                                  |
| ac-6      | "only the run's user decides; others get 404; a decided approval is 409; bad bodies 400"                                                                                                                                                                                                                                         |
| ac-7      | `apps/web/components/chat/approvals.test.tsx` (10: card content, Allow + 30-day remember body, Deny, server expiry, server refusal, past-expiry, input read-back, causes); `lib/api/casing.test.ts`                                                                                                                              |
| ac-8      | "Stop while pending …", "a budget stop expires pending approvals (D30) …", "the sandbox connection closing while pending …"                                                                                                                                                                                                      |
| ac-9      | audit assertions in the db tests; `packages/db` `events.test.ts` (taxonomy + docs/audit-log.md)                                                                                                                                                                                                                                  |
| Gate 2    | `approvals.db.test.ts` "Gate 2 …" (6): proxy re-check requires approval; skipped check → `no_approval` (audited); changed input `bad_mac`, NFD, other user `record_mismatch`, pending `not_allowed`; canonical reorder allowed once then `not_consumable`; other id, other run, other tool, expired token, ended run; forged MAC |
| E2E       | `e2e/run.sh` "approvals (KOBE-37)": ask rule → `policy.pending` → `waiting_approval` → API allow → `policy.result allow` (no token) → second call → API deny → `deny`; 409 on re-decide; events and audit rows (runs in CI's `e2e` job)                                                                                          |
| user dec. | "defaults (user decision 2026-10-03) › never prompts for sandbox tools unless a policy rule asks"                                                                                                                                                                                                                                |

Commands: see the PR body.
