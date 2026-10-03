# Approvals

How Kobe asks a person before a tool call runs (spec D29; built in KOBE-37). The server decides
every tool call. An approval is signed so that exactly the approved input runs, once. There is no
bypass mode.

## When a call asks

The policy engine (KOBE-35) evaluates every call in the D29 order: install deny, team deny,
install/team ask, risk class, approval mode, user allow rules, prompt. A call asks for approval
when:

- an **ask rule** (install floor or team) matches it, or
- its **risk class** prompts in the run's mode: in `ask-on-write` (the default), writes and deletes
  outside the sandbox (MCP tools, Kobe's own artifacts, shared files and project memory), or
- the run's mode is **`ask-all`**.

A user's remember-rule removes a risk-class or mode prompt. It never removes an ask rule. In `auto`
mode and in scheduled runs nothing asks: a call that would ask is denied instead.

**Sandbox tools ask only when a policy rule says so** (user decision, 2026-10-03). `bash`, `write`,
`edit` and the other sandbox built-ins have no default prompt. The sandbox, its egress policy and
the audit log bound them (D29). To ask for them, a team admin adds an ask rule, for example
`{"effect": "ask", "tool_glob": "bash"}` in `POST /v1/team/policy/rules`, or an install admin adds
one to the install floor. The install switch `promptSandboxWrites` (`PUT
/v1/install/policy/settings`, default `false`) is the explicit opt-in to prompting every sandbox
write. Kobe seeds no rules.

## The flow

1. kobe-policy (the Pi extension) sends `policy.check`. The server builds the decision from its own
   state and gets `require_approval`.
2. The broker stores a pending `approvals` row. It moves the run to `waiting_approval`, appends
   `approval.requested` (the card: tool, the exact input, risk, reasons, `expires_at`), audits
   `approval.requested`, and answers the sandbox `policy.pending`.
3. The run's user answers in the chat card, or with `POST /v1/approvals/{id}
{decision, remember?}`. The decision can reach any replica; a Postgres `NOTIFY` hint
   (`apr:<id>`) wakes the waiting broker, which also polls.
4. On allow, the sandbox gets `policy.result` `allow`, and the run returns to `running`. On deny,
   the call fails with `policy.denied: … You denied this tool call`, and the run continues.

| Event                  | Run status                             | Sandbox gets             |
| ---------------------- | -------------------------------------- | ------------------------ |
| requested              | `running → waiting_approval`           | `policy.pending`         |
| allowed                | `→ running` (once none waits)          | `policy.result` allow    |
| denied                 | `→ running`                            | `policy.result` deny     |
| TTL (1 h)              | `→ failed` (`approval_expired`), abort | deny                     |
| Stop / budget / failed | ends as usual; approval `expired`      | deny                     |
| connection lost        | `→ running`; approval `expired`        | (agent denied it itself) |

## Who may approve

Only the **run's user**, the thread owner, may approve. The call runs in that user's sandbox with
that user's connector credentials. D8 gives no role the power to consent for someone else, and
install admins cannot read team content (D8, D10). Any other caller gets `404
approval_not_found`, the same answer as for a thread they cannot see. The caller must still be an
active member of the team (`team.chat`).

## Expiry and run ends

- **TTL:** a pending approval expires 1 hour after it was requested (`APPROVAL_TTL_MS`). The call is
  denied, the run fails visibly (`run.failed` `approval_expired`), Pi is told to abort, and the
  thread's queue moves on. The replica that waits has a timer. Every replica also runs a sweep
  every 30 s for approvals that no replica waits on.
- **Run ends while pending:** Stop (`run_cancelled`), budget (`budget_exhausted`, D30; the step then
  finishes), failure (`run_failed`) or interruption (`run_interrupted`). Every path that ends a run
  expires its pending approvals first, so `approval.resolved` comes before the terminal event.
- **The sandbox connection closes while pending:** the agent denies the waiting call itself. The
  server marks the approval `expired` (`run_interrupted`) and returns the run to `running`.
- A late decision answers `409 approval_resolved` or `approval_expired`.

## Remember

`remember: {tool_glob, arg_pattern?, expires_in?}` is accepted with `allow` only. It writes a user
allow rule (`tool_rules`, scope user) in the active team. It is written in the same transaction as
the decision and is audited as `policy.rule.created`. `tool_glob` must be exactly the approved tool
(`glob_too_broad` otherwise). `arg_pattern` narrows it further, and `expires_in` is in seconds. The
rule lifts future risk-class and mode prompts for this user in this team only. Members list and
revoke their rules at `GET`/`DELETE /v1/team/policy/my-rules`.

## Signing

An allowed approval carries an HMAC token (`@kobe/protocol` `approval.ts`):

```
mac = base64url(HMAC-SHA256(KOBE_APPROVAL_KEY,
        UTF-8(canonicalJson(["kobe.approval.v1", team_id, run_id, tool_call_id, tool,
                             expires_at, input]))))
```

- **The tuple:** D29 names run, tool call and canonical input. `tool` stops an approval for one tool
  from authorising another tool with the same ids. `team_id` adds defence in depth. `expires_at` is
  the token's own lifetime: 10 minutes from the decision, ISO 8601 with milliseconds. The domain tag
  keeps the MAC from being replayed as any other Kobe HMAC.
- **Canonical JSON** (`canonical-json.ts`) is RFC 8785 (JCS) with these rules:
  - Only JSON values are allowed: no `undefined`, functions, symbols, bigints, `NaN`/`±Infinity`,
    class instances, sparse arrays or `__proto__` keys, and nesting is at most 128 deep.
  - Object keys are sorted by UTF-16 code units, recursively, with no whitespace.
  - Numbers use ECMAScript's shortest form (`2.50` becomes `2.5`, `1E3` becomes `1000`).
  - Strings are escaped like `JSON.stringify`. Lone surrogates are rejected.
  - There is **no Unicode normalisation**: NFC and NFD are different inputs.
- **What is signed:** the input exactly as the policy check received it. It is stored as canonical
  text (`approvals.input_canonical`, never jsonb), so the stored form cannot drift from the signed
  one. The server refuses to sign if re-canonicalising the stored text changes it.
- **Known-answer vector:** `services/server/src/approvals/signing.test.ts`. Another
  implementation can check its bytes and MAC against it.
- **The key:** `KOBE_APPROVAL_KEY` (at least 32 bytes) is generated by the chart as `approval-hmac`
  in the sandbox session-keys Secret. The server and the MCP proxy hold it; a sandbox never does.
  The `kid` is `a-` plus the first 12 hex digits of SHA-256 of the key, so a token from a rotated
  key fails as `unknown_key`. Without the key, every call that needs approval is denied.
- **Never in the sandbox:** the `policy.result` the sandbox gets carries no token; the row holds it.
- **Single use:** built-in and Kobe tools have no verifier after the server, because the
  `policy.result` itself authorises them. Their approval is marked used (`consumed_at`) when it is
  allowed. An MCP approval stays usable exactly once, by the MCP proxy.

## The MCP proxy seam (KOBE-58; Gate 2)

A tampered kobe-policy could skip `policy.check`, change the input after approval, reuse a tool
call id, borrow another run's approval, or wait out the token. The MCP proxy therefore never takes
an approval from the sandbox. For every MCP `tools/call` it:

1. parses the body (`parseJsonStrict`), validates `params.arguments` (`toolInputSchema`), and
   resolves the tool from its own registry;
2. re-runs the policy engine with `context.enforcement_point: "mcp_proxy"` (and
   `connector_exposure`). `allow` and `deny` stand as they are;
3. on `require_approval`, calls the verifier with the call as **it** sees it: team and user from
   its verified session token, run and tool call id from the request, tool from its registry, and
   the parsed arguments it is about to forward:

```ts
import { enforceMcpCall } from "services/server/src/approvals/verify.ts";
// deps.approvals.verifier: ApprovalVerifier (server process)
const out = await enforceMcpCall(engine, deps.approvals.verifier, policyInput);
// or, the approval half alone:
const check = await deps.approvals.verifier.authorize({
  teamId,
  userId,
  runId,
  toolCallId,
  tool,
  input,
});
// check: { ok: true, approvalId } | { ok: false, reason }
```

The verifier finds the approval by (team, run, tool_call_id) under RLS. It checks that the row
belongs to the same user, rebuilds the token from the row, and runs `authorizeApprovedCall`:

- binding (team, run, call, tool), key known, token not expired, and the MAC over
  `canonicalJson(input)` checked in constant time;
- then the row is `allowed`, its MAC equals the token's, the run is active, and the approval is
  consumed with one conditional `UPDATE`.

A successful use is audited as `approval.consumed`. Every refusal is audited as `approval.rejected`
with its reason (`no_approval`, `bad_mac`, `binding_mismatch`, `expired`, `not_consumable`,
`run_inactive`, …), throttled per run and reason. The proxy forwards exactly
`JSON.parse(canonicalJson(arguments))`. KOBE-58 can call this in process, or move the same
`@kobe/protocol/node` `authorizeApprovedCall` plus the SQL in `approvals/store.ts` into the proxy.
The proxy needs `KOBE_APPROVAL_KEY`, which is the same Secret key as above.

## Audit

| Action               | When                                                 |
| -------------------- | ---------------------------------------------------- |
| `approval.requested` | a call waits for its user                            |
| `approval.decided`   | the user allowed or denied it (`remember`, `ruleId`) |
| `approval.expired`   | TTL, or its run ended (`cause`)                      |
| `approval.consumed`  | the MCP proxy used the signed approval               |
| `approval.rejected`  | the MCP proxy refused a call needing one             |

None of these record the tool input or the token ([audit log](audit-log.md)).
