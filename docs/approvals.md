# Approvals

How Kobe asks a person before a tool call runs (spec D29; built in KOBE-37). The server decides
every tool call. An approval is signed so that exactly the approved input runs, once. There is no
bypass mode: the one exception, an admin-only agent mode **Dangerous** (decision AC1 in
[`specs/agent-creator.md`](specs/agent-creator.md), approved by Chris 2026-10-22), is itself a
server-side policy outcome (below).

## When a call asks

The policy engine (KOBE-35) evaluates every call in the D29 order: site deny, team deny,
site/team ask, risk class, approval mode, user allow rules, prompt. A call asks for approval
when:

- an **ask rule** (site floor or team) matches it, or
- its **risk class** prompts in the run's mode: in `ask-on-write` (the default), writes and deletes
  outside the sandbox (MCP tools, Kobe's own artifacts, shared files and project memory), or
- the run's mode is **`ask-all`**.

A user's remember-rule removes a risk-class or mode prompt. It never removes an ask rule. In `auto`
mode and in scheduled runs nothing asks: a call that would ask is denied instead.

**Dangerous agents** (AC1). When the run's published agent version is in Dangerous mode (published
by a site or team admin who still is one), the site floor is `auto` and the run is interactive
(`ask-on-write` or `ask-all`), a tool the agent's `tools.allow` names one by one is allowed without
a card where its risk class or mode would ask (reason `dangerous_mode`; audit
`policy.dangerous_mode.applied`). Deny rules, the agent's `tools.deny` (refused in every mode),
connector exposure, ask rules, Kobe-scoped write prompts and `auto`/scheduled refusals still win,
at the sandbox check and again at the MCP proxy.

**The viewed file** (KOBE-493). When the run carries a viewed file (`runs.viewing`, set when the
member sends while a file is open, and again on Retry and regenerate; only the path is kept when
the file could not be read, and the guard still applies), Pi's `write` and `edit` on that file
never change it directly, in every mode, Dangerous and remembered approvals included (a
member-protection rule, like `tools.deny`; `policy/viewed-file-guard.ts`, applied after the engine
at the sandbox check; reason code `viewed_file`). When the agent can propose instead (the sandbox
announced `file_edits` and the agent's tool lists leave `propose_file_edit`), the call is denied
with a tool error the model can act on ("The user is viewing notes.md. Propose the change with
propose_file_edit instead; nothing was written."). Otherwise the member is asked; that approval
offers no "remember" (it would be ignored: the guard asks again) and is left out of "Approve all
waiting"; where nobody can be asked (`auto`, scheduled, skill eval) it is denied. Paths are
compared as normalised strings (Pi's path resolved against `/workspace`: absolute or relative,
`./`, `../`, `//`, trailing slash; case-sensitive).

Not covered: `bash`, `powershell` and `run_python` (which can also write a viewed `.ipynb` or
`.py`), any other tool that writes files, and other names for the same file: symlinks and hard
links are not followed. `propose_file_edit`, `open_file` and other files are unaffected.

**Sandbox tools ask only when a policy rule says so** (user decision, 2026-10-03). `bash`, `write`,
`edit` and the other sandbox built-ins have no default prompt. The sandbox, its egress policy and
the audit log bound them (D29). To ask for them, a team admin adds an ask rule, for example
`{"effect": "ask", "tool_glob": "bash"}` in `POST /v1/team/policy/rules`, or a site admin adds
one to the site floor. The site switch `promptSandboxWrites` (`PUT
/v1/site/policy/settings`, default `false`) is the explicit opt-in to prompting every sandbox
write. Kobe seeds no rules.

## The flow

1. kobe-policy (the Pi extension) sends `policy.check`. The server builds the decision from its own
   state and gets `require_approval`.
2. The broker stores a pending `approvals` row. It moves the run to `waiting_approval`, appends
   `approval.requested` (the card: tool, the exact input, risk, reasons, `expires_at`), audits
   `approval.requested`, and answers the sandbox `policy.pending`.
3. The run's user answers in the chat card, or with `POST /v1/approvals/{id}
{decision, remember?}` (or several at once: "Approve all waiting", below). The decision can reach any replica; a Postgres `NOTIFY` hint
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
site admins cannot read team content (D8, D10). Any other caller gets `404
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
- **Only the connection that asked can take an answer.** The row records the asking sandbox
  connection. A decision is refused (`409 approval_unavailable`) and the approval expired when
  that connection is no longer the sandbox's open, live one, so an approval with nobody waiting can
  never be allowed. If the connection closes after an allow but before it was delivered, the allow
  is voided (`expired`, token cleared), unless an MCP approval was already consumed by the proxy.

## Limits

A compromised sandbox could loop `policy.check`s to grow rows, events and audit. Per run:

- at most **100 approvals** (`APPROVALS_MAX_PER_RUN`); further calls needing approval are denied
  and audited `approval.rejected` `too_many_approvals`;
- no new approval once the run is within 3 events of its event cap (`runMaxEvents`, 100 000),
  audited `run_event_cap`;
- inputs over 192 KiB (canonical) are denied before anything is stored;
- a reused `tool_call_id` is denied and audited `replayed_tool_call_id`.

## Remember

A remembered approval is a user allow rule (`tool_rules`, scope user) in the active team for
exactly the approved tool (`tool_glob` must equal it, `glob_too_broad` otherwise). It lifts later
risk-class and mode prompts for this member in **interactive** runs only. Site and team deny and
ask rules still win, and it never applies to another member.

Two rules are Chris's own requirements (KOBE-289) and hold without exception:

- **Scheduled and auto runs never use remembered approvals** (D32: there a call that would ask is
  denied, not queued; only team allow rules allow-list). Before KOBE-289 a member's remembered
  rule also allow-listed the tool for their own schedules and auto-mode threads. **Existing
  schedules that relied on that now skip those calls** (reported as skipped actions on the run);
  a team admin who wants a tool to run unattended adds a team allow rule.
- **Destructive tools are never remembered.** The server refuses it (`remember_not_allowed`) and
  the engine ignores a stored rule for one. Older rules for destructive tools (`bash`, and every
  MCP tool without annotations, which counts as destructive) stop applying; the Approvals pages
  show them as "No longer applies" with the reason and offer only Remove.

`remember: {tool_glob, scope, exact?}` is accepted with `allow` only (KOBE-289; the spec §6.1
shape `{tool_glob, arg_pattern?, expires_in?}` is no longer accepted: an old client gets
`invalid_request`). The server works out everything else from its own state, never from the
client:

| Scope     | Card label         | Holds                                                                     |
| --------- | ------------------ | ------------------------------------------------------------------------- |
| `thread`  | this conversation  | calls of this thread; ends for good when it is archived, trashed or moved |
| `today`   | until end of today | until midnight in the member's stored time zone (`/v1/me/time-zone`)      |
| `run`     | this run only      | calls of this run; ends with the run (a regenerate or next message asks)  |
| `day`     | for 1 day          | 24 hours                                                                  |
| `month`   | for 30 days        | 30 days                                                                   |
| `forever` | until revoked      | until revoked                                                             |

- **Enforcement.** The engine (`evaluate.ts`) checks a `thread` rule's thread id and a `run`
  rule's run id against the call. The rule source reads a bound rule only while its thread exists,
  is not deleted or archived, is still the member's and in a project they can open, and while its
  run is active (`live-rule.ts`). The MCP proxy decides every other active run of the sandbox on
  its own whenever a remembered rule allowed the named run, so a thread's rule never allows a call
  while another thread of the sandbox runs. Expiries are computed on the server.
- **Ended for good.** Archiving, moving to Trash or moving to another project deletes the
  thread's rules (audited `policy.rule.deleted`, system actor) in the same transaction, so
  unarchive, restore or moving back never revive them. Losing access to the thread's project
  (removed from it, the project made selected-members, no longer team admin) ends them the same
  way. A rule whose run ended is pruned when the member makes a new one.
- **Only this exact action** (`exact: true`). The server derives `arg_pattern` from the approval's
  stored canonical input as the engine sees it (validated, paths canonical), each value a literal
  glob (`*`, `?` and `\` escaped; no regular expressions), shown before saving (`GET
/v1/approvals/{id}/remember`). For MCP and Kobe tools it pins **every** top-level argument and
  the rule matches only an input with exactly the same keys (`exact_keys`: no extra or missing
  argument). For a built-in file tool it pins only the path: the card says "Only this path", and
  the content may differ. Not offered when no pattern fits (`exact_unavailable`). A pattern sent
  by the client is refused.
- **Admin limits.** The site floor (`/v1/site/policy/remember-limits`) and each team
  (`/v1/team/policy/remember-limits`) set which scopes members may use, a max duration, whether
  MCP tools may be remembered, exact actions only, and whether "Approve all waiting" is offered.
  A team's effective limits are both, tightened field by field; a team save looser than the floor
  is refused (`limits_above_floor`). The card offers only allowed choices, the server refuses
  others (`remember_not_allowed`), and the engine applies the limits at evaluation too: a rule a
  tightened limit no longer allows stops applying at once (max duration counts from its creation;
  under exact-only, only rules whose patterns are all literal count, never an older wildcard).
- **Visibility.** A call a remembered rule allowed is recorded before it runs: the rule's
  `last_used_at`, an audit row `policy.rule.applied` naming the rule (at the sandbox's check and
  again at the MCP proxy, whose `mcp.tool_call` row carries `ruleId`), and the run event
  `policy.rule_applied`, shown on the tool card as "Allowed by your rule (<scope>)". A rule
  revoked or ended in between denies the call.
- **Revoking.** Members list and revoke their own rules on My area, Approvals (`GET`/`DELETE
/v1/team/policy/my-rules`); team admins see and revoke every member's in their own team on the
  team Policy page (`/v1/team/policy/member-rules`, under the team's RLS). Both lists mark a rule
  the engine ignores as "No longer applies" with the reason. **D18:** an admin sees the tool, the
  scope, the pattern's shape (its argument names) and the expiry, never a private thread's title
  ("a conversation") or the argument values, unless the thread is shared. Revoking takes effect at
  the next call.

Creating a rule is audited as `policy.rule.created` (with `rememberScope`, and the thread or run),
in the same transaction as the decision.

## Approve all waiting

When several approvals of one run wait, `POST /v1/approvals/approve-all {run_id, approval_ids}`
allows the listed ones in one action. Nothing is shared between them: each is checked as a single
decision would be (the caller's, of this run, pending, unexpired, its asking connection live), then
signed over its own canonical input, marked, announced (`approval.resolved`) and audited
(`approval.decided` with `approveAll: true`) on its own, in one transaction that refuses the whole
set if any one fails. It is not offered, and refused (`approve_all_not_allowed`), when any of them
is destructive or open-world by the server's own descriptor, writes a project's shared state
(project memory, `propose_project_file`), or when the team's limits turn it off. If the
connection that asked for one of them is gone, that one expires (as for a single decision) and
nothing is approved. It never writes a remember-rule. Readers of a shared thread get 404, as for a single decision.

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
  The `kid` is `a-` plus the first 12 hex digits of HMAC-SHA256(key, "kid") (no offline guess check on a weak key), so a token from a rotated
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
`run_inactive`, …), throttled per tool call and reason (repeats counted as `suppressed`). The proxy forwards exactly
`JSON.parse(canonicalJson(arguments))`. KOBE-58 can call this in process, or move the same
`@kobe/protocol/node` `authorizeApprovedCall` plus the SQL in `approvals/store.ts` into the proxy.
The proxy needs `KOBE_APPROVAL_KEY`, which is the same Secret key as above.

**How KOBE-58 calls it.** The MCP proxy's re-check runs in the server (internal listener), so the
verifier is called in process and the approval key never leaves the server. The run is never taken
from the sandbox: the proxy forwards the sandbox's thread (`Kobe-Thread-Id`), and the server uses
that thread's active run only if it belongs to the token's user and is leased to the token's
sandbox. The tool call id is `_meta["kobe.dev/tool_call_id"]` when sent, otherwise the server finds
the run's allowed, unconsumed approval of that user for that tool whose `input_canonical` equals
the call's canonical input (Pi's MCP client has no per-call id). See `docs/ledger/KOBE-58.md`.

## Audit

| Action               | When                                                 |
| -------------------- | ---------------------------------------------------- |
| `approval.requested` | a call waits for its user                            |
| `approval.decided`   | the user allowed or denied it (`remember`, `ruleId`) |
| `approval.expired`   | TTL, or its run ended (`cause`)                      |
| `approval.consumed`  | the MCP proxy used the signed approval               |
| `approval.rejected`  | the MCP proxy refused a call needing one             |

None of these record the tool input or the token ([audit log](audit-log.md)).
