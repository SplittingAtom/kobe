# KOBE-58: MCP proxy core: auth, exposure, policy re-check

- **Status:** in review (PR #47)
- **Branch / worktree:** `kobe-58-mcp-proxy` in `../Kobe-wt58`
- **Depends on:** KOBE-35 (policy engine), KOBE-24 (sandbox wire), KOBE-22 (sandbox provider),
  KOBE-38 (egress proxy), KOBE-15 (audit), KOBE-5 (scaffold); all merged. KOBE-37 (approvals) in
  progress in parallel: coded against a narrow seam with a deny-by-default stub (see below).

## Acceptance criteria (spec D27, D29, D6, non-negotiables; coordinator brief; Gate 2)

1. **ac-1 Auth.** Sandboxes authenticate with their `kobe.mcp-proxy` session token → (team, user,
   sandbox); the run comes from the thread the call names, checked server-side.
2. **ac-2 Remote-only Streamable HTTP** to the sandbox and to remote MCP servers; no stdio.
3. **ac-3 Exposure.** Which connectors and tools a (team, user, agent) sees: minimal data model,
   in-DB registry fixtures for tests.
4. **ac-4 Policy re-check** of every tool call by the server (`enforcement_point: mcp_proxy`).
5. **ac-5 Signed approvals** for calls that need approval: never allow without verification.
6. **ac-6 Audit** of tool calls, metadata only. **ac-7 Limits.**
7. **ac-8 Chart:** Deployment/Service, NetworkPolicy (ingress only from sandboxes; egress to remote
   MCP servers, direct or via the egress proxy, justified).
8. **Gate 2:** a tampered `kobe-policy` cannot execute an MCP write without a signed approval:
   unsigned, forged, replayed, changed input and expired approvals are all refused; e2e against a
   fake remote MCP server.

## Design

```
sandbox (Pi MCP client) ──POST /v1/mcp/<connector_id>──▶ mcp-proxy ──POST :8082 /internal/v1/mcp/…──▶ server
   Bearer <kobe.mcp-proxy token>, Kobe-Thread-Id          (no DB)        internal key + the sandbox token     (decides, audits)
                                                            │
                                                            └── allow only ──▶ remote MCP server (Streamable HTTP, direct)
```

- **`services/mcp-proxy`** (Hono, no database): `mcp.ts` the sandbox-facing endpoint
  `POST /v1/mcp/{connector_id}` (stateless Streamable HTTP, JSON answers, no `Mcp-Session-Id`;
  `initialize`, `ping`, `tools/list`, `tools/call`; resources/prompts → method not found; GET/DELETE
  405); `auth.ts` (token pre-check with the proxy's own key); `jsonrpc.ts` (`parseJsonStrict`, no
  batches); `server-client.ts` (internal API client, fail closed); `upstream.ts` (MCP client:
  `initialize` → `notifications/initialized` → `tools/call` → `DELETE`, JSON or SSE answers,
  `undici` Agent with a checked `lookup`); `address-policy.ts` (copy of the egress proxy's ranges);
  `credentials.ts` (KOBE-61 seam, `NO_GRANTS`); `limits.ts`; `config.ts` (zod).
- **Server** `services/server/src/mcp/`: `catalog.ts` (`loadTeamConnector`, `exposedTools`,
  `createDbMcpCatalog` = the engine's `McpToolCatalog` + `ConnectorStateSource`), `decide.ts`
  (`decideMcpCall`), `approvals.ts` (the KOBE-37 seam), `principal.ts` (token + liveness +
  account + membership), `service.ts`; `routes/internal.ts` (`createInternalApp`, the internal
  listener on port 8082, started in `index.ts` only with `KOBE_MCP_PROXY_INTERNAL_KEY`).
  `deps.ts` now builds **one** policy engine with the MCP catalog and gives it to the sandbox wire
  and the MCP service, so kobe-policy's own `policy.check` resolves pinned MCP tools too (they were
  `unknown_tool` before).
- **DB** (`packages/db`, area `connectors`): `connectors` † (name, url, auth_kind, status,
  `tools_snapshot` jsonb of pinned tools, `tools_hash`) and `team_connectors` (team table, RLS:
  exposure `read_only|all|custom`, `enabled_tools`, `enabled_by`). Migrations `0030_connectors`,
  `0031_connectors_rls`; probe fixture; `parseToolsSnapshot` (fail closed per entry).
- **Audit:** `mcp.tool_call` (team; `sandboxId`, `userId`, `connectorId`, `tool` (Pi name),
  `runId?`, `threadId?`, `toolCallId?`, `decision`, `reason`, `risk?`, `approvalId?`,
  `approvalFailure?`), category `mcp`; docs/audit-log.md.
- **Chart:** `_mcp.tpl`, `mcp-proxy-internal-key.yaml` (generated, kept; or
  `mcpProxy.internalKeySecret`), `mcp-proxy-networkpolicy.yaml`; server gets port/Service port
  `internal` 8082 + the key; `not-from-sandboxes` now admits non-team namespaces on 8080/8081 only
  and 8082 only from MCP proxy pods.

### Per call (normative order)

Proxy: token (own key) → per-sandbox rate → connector id → `MCP-Protocol-Version` → JSON content
type, body cap → strict JSON-RPC parse → `tools/call` params: `toolInputSchema`, then
`canonical = canonicalJson(arguments)` → concurrency slot → server decides → on allow, check the
answer is for exactly this connector, tool and `sha256(canonical)` → credential (KOBE-61 seam) →
forward `JSON.parse(canonical)` upstream → result passed through (JSON-RPC errors too).

Server: verify the sandbox token itself (`kobe.mcp-proxy` key) → sandbox live (KOBE-22 claim) →
account active → member → connector enabled in the team and active → tool in the pinned snapshot
(by upstream name) → input `toolInputSchema` → the thread's active run, owned by the user and
**leased to this sandbox** (`sandbox_run_leases`) → run context (floor clamp, scheduled = auto, as
`policy.check`) → engine (`enforcement_point: mcp_proxy`, team exposure; drift/exposure/rules/mode)
→ `require_approval` → `McpApprovalVerifier.authorize` (verify + consume) → audit → answer. Every
error is a deny; an allowed call whose audit row fails is refused.

## Decisions

- **The server decides; the proxy has no database.** The brief says "the server decides every
  call"; the engine, rules, run state and approvals all live server-side. The proxy calls a
  dedicated internal listener (port 8082), keyed with a chart-generated internal key, and passes
  the sandbox's own token, which the server verifies with the `kobe.mcp-proxy` key (the proxy cannot
  speak for a sandbox whose token it has not seen). **Least-privilege DB role: not needed** — the
  proxy holds no DB credentials at all (KOBE-38's open question 3 remains for the egress proxy).
- **Approval verification at the server, not in the proxy process.** `@kobe/protocol` approval.ts
  says the MCP proxy verifies + consumes. The MCP enforcement point is the proxy _and_ its
  server-side re-check; verifying there keeps the approval HMAC key in the server only (KOBE-37
  signs there) and gives the stateful half (`ApprovalStore`) a DB. The MAC is checked over the exact
  input the proxy then forwards (the proxy refuses an allow whose `input_sha256` differs from its
  own canonical bytes). The protocol functions are used unchanged (`authorizeApprovedCall`); only
  the doc comment's "where" differs — flagged for the contracts follow-up, no contract changed.
- **No tool_call_id from Pi.** Pi 1.0's built-in MCP client has static per-server headers and no
  per-call `_meta` hook (docs/mcp.md). The proxy therefore takes the **thread** from a per-session
  header `Kobe-Thread-Id` (one Pi process per thread; KOBE-62 sets it) and the run is the thread's
  single active run leased to the token's sandbox. `_meta["kobe.dev/tool_call_id"]` is used when
  present (then the approval must bind it). Without it, the verifier tries the run's allowed
  approvals for this tool (`ApprovalTokenSource.candidates`, ≤ 8) and the approval authorises
  exactly its run, tool and canonical input, once. Consequence: an approval for call A can be
  consumed by an identical call B of the same run (same tool, same input) — same effect as
  approved; replays across runs, tools or inputs fail.
- **Egress: direct, not through the egress proxy.** D28's egress proxy authenticates sandboxes
  and enforces team allowlists of the sandbox's own traffic; connectors are governed by the
  install registry (D27 ceiling = registered + pinned) and team enablement, and the MCP proxy is
  a Kobe service, not a sandbox. Routing it through the egress proxy would need egress tokens for
  a non-sandbox and team-level domain enablement for every connector (two ceilings for one thing).
  The same protections are applied in the proxy: HTTPS only (`allowInsecureHttp` for dev/CI),
  allowed ports (443), every resolved address checked against the egress proxy's ranges
  (private, loopback, metadata, …; `allowedInternalCidrs` for on-prem servers), connect only to the
  checked address, no redirects, size/time caps; and its own NetworkPolicy allows only DNS, the
  server's internal port and public IPv4 on the allowed ports.
- **tools/list from the pinned snapshot**, never the live upstream list (D27 pinning: a server
  cannot change descriptions/schemas under an agent). Drifted tools are not listed and are denied
  `tool_drifted` by the engine.
- **One short upstream session per call** (initialize, initialized, call, DELETE). Simple, holds no
  per-user upstream state between calls (revocation is immediate); costs two extra round trips.
  Upstream protocol `2025-11-25` (the newest the ecosystem SDK knows; 2026-07-28's OAuth rules are
  KOBE-61's), sandbox side answers 2025-11-25 / 2025-06-18 / 2025-03-26 (`pi-mcp` speaks 2025-11-25).
- **Denials are `isError` tool results** ("Kobe denied this call: …") so the model sees why;
  transport/auth problems are HTTP errors (401/403/429/503), upstream JSON-RPC errors pass through.
- **Audit volume:** every allowed call is recorded (before forwarding); denied calls per sandbox
  burst 20 then 1/3 s (rest logged), like KOBE-38's flood guard.
- **Limits** (per replica): 1 MiB request, 4 MiB upstream answer, 55 s upstream (under Pi's 60 s),
  8 concurrent calls per sandbox / 256 total, 60-request burst then 10/s per sandbox; server call
  10 s timeout.
- **Grants on `connectors`:** full DML for the app role (KOBE-59's admin API needs it; the probe
  fixture inserts it); the cascade into `team_connectors` is documented in `tenancy/connectors.ts`.
- **Release NetworkPolicy tightened:** `not-from-sandboxes` rule 1 now lists ports 8080/8081, and
  8082 is admitted only from MCP proxy pods (NetworkPolicies are additive, so without the port list
  any release-namespace pod could reach 8082). The internal key is still required.

## For other tickets

- **KOBE-37 (approvals) — what to swap.** Production wires `DENY_UNVERIFIED_APPROVALS`
  (`services/server/src/mcp/approvals.ts`), so every MCP call that needs approval is refused today.
  To enable approvals, pass `mcp: { approvals: createSignedApprovalVerifier({ tokens, store, keyFor }) }`
  to `createServerDeps` (in `services/server/src/index.ts`), where:
  - `tokens: ApprovalTokenSource` — `candidates({teamId, runId, tool, toolCallId?, limit})`: tokens
    (`ApprovalToken`) of this run's **allowed** approvals for this Pi tool name, newest first,
    rebuilt from the `approvals` row (`kid`, `approval_id`, `team_id`, `run_id`, `tool_call_id`,
    `tool`, `expires_at`, `mac` = `input_hmac`); filter by `tool_call_id` when given.
  - `store: ApprovalStore` — the protocol interface (load + the one conditional `consume`).
  - `keyFor(kid)` — the verification key(s) (the server's own signing key; never leaves it).
    `services/server/src/testing/approval-fixtures.ts` (`MemoryApprovals`) is the reference behaviour;
    `mcp.db.test.ts` "Gate 2" is the suite to keep green with the real store.
- **KOBE-59 (registry, pinning, drift):** owns writes to `connectors` (admin API, `tools/list`
  snapshot, SHA-256 per tool, `tools_hash`, `status: drifted` + re-approval). Snapshot entry shape:
  `packages/db/src/connectors/snapshot.ts` (`name`, `pi_name` incl. any Pi collision suffix,
  `description`, `input_schema`, `output_schema?`, `annotations`, `sha256`, `status`). Register only
  Streamable HTTP URLs; the proxy enforces HTTPS/ports/addresses again. Add icon/creator columns as
  needed; keep `parseToolsSnapshot` fail-closed. Audit registry changes.
- **KOBE-60 (team enablement):** writes `team_connectors` (exposure, `enabled_tools` = Pi names)
  under `withTeam`, audited. No row = not enabled (D27 off by default).
- **KOBE-61 (grants):** implement `CredentialResolver.headersFor({teamId, userId, connector})` in
  the proxy (`services/mcp-proxy/src/credentials.ts`; wired in `index.ts`, today `NO_GRANTS`:
  `auth_kind: none` only, others "not connected"). The credential store is yours; if the proxy
  should fetch decrypted credentials from the server, add an internal route next to
  `routes/internal.ts` (same key + sandbox token). Upstream `auth_required` (401/403) is reported
  as "reconnect". MCP 2026-07-28 OAuth rules (PRM discovery, CIMD, PKCE, RFC 8707/9207) are yours.
- **KOBE-62 (Pi MCP wiring):** configure each exposed connector in Pi as a Streamable HTTP server
  at `<KOBE_MCP_PROXY_URL>/v1/mcp/<connector_id>` (`KOBE_MCP_PROXY_URL` is already in the sandbox
  env: `http://mcp-proxy.kobe.internal:80`) with headers `Authorization: Bearer <kobe.mcp-proxy
token>` and `Kobe-Thread-Id: <thread_id>`; server name = connector name (Pi tool names then
  match the pinned `pi_name`). The token rotates every 15 min: use a `!command` header reading the
  agent-rotated token file (or re-register the server), and expect a 401 on an expired token.
  If an extension can attach `params._meta["kobe.dev/tool_call_id"]`, the approval is bound to the
  exact tool call. Exposure in Pi can be `direct`/`deferred`; the proxy only lists exposed tools.

## Open questions / flags (for Chris or the coordinator)

1. **Protocol doc comment** (`approval.ts`: "Verify + consume: … the MCP proxy") vs this ticket's
   server-side verification (see Decisions). No contract type changed; the contracts follow-up
   could reword it and drop the SPECULATIVE `APPROVAL_TOKEN_MCP_META_KEY` (unused: approvals are
   found server-side).
2. `tool_call_id` binding needs a Pi-side hook (KOBE-62); until then approvals bind run + tool +
   input (see Decisions).
3. The egress proxy's least-privilege DB role (KOBE-38 open question 3) is not addressed here:
   the MCP proxy needs no DB.

## Risks

- **Pi interop not yet exercised end to end** (KOBE-62): the proxy follows Streamable HTTP
  2025-11-25 in stateless mode (no session id, JSON answers only, GET 405); Pi's client must accept
  that (spec-compliant). Tested with our own client and a fake server, and in e2e with curl.
- The internal listener is guarded by NetworkPolicy + key; a release-namespace pod that obtains the
  key and a sandbox's token could ask for decisions (it still cannot mint approvals or tokens).
- Address checks are a copy of the egress proxy's list: keep both in sync (shared package later).
- One upstream session per call adds latency (two round trips) for chatty MCP use.
- An allowed call whose audit write fails is refused after its approval was consumed: the user must
  approve again (fail closed by design).

## Evidence (acceptance criteria → test or command output)

| AC                   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 auth            | `mcp-proxy/src/mcp.test.ts` "refuses a missing, forged, expired or other-audience token"; `auth.test.ts`; server `mcp.db.test.ts` "internal listener authentication" (internal key, forwarded headers, forged/expired/other-audience token, not live, not a member); run binding: "denies a call that names no thread, another user's thread, or a run not leased here", "denies once the run has ended" |
| ac-2 Streamable HTTP | `mcp.test.ts` transport suite (POST only, JSON, no batches, notifications 202, version negotiation); `upstream.test.ts` (JSON + SSE answers, session id + DELETE, protocol version check, no redirects); e2e `tools/list` + `tools/call` through the proxy                                                                                                                                               |
| ac-3 exposure        | `mcp.db.test.ts` "tools/list exposure (D27)" (all / read_only / custom, drifted hidden, not enabled / other team / disabled → 404), "denies a tool outside the team's exposure", "denies a tool that is not pinned (unknown) and one that drifted"; catalog tests; db `connectors.db.test.ts` (names, URLs, RLS), probe suite                                                                            |
| ac-4 re-check        | `mcp.db.test.ts` "allows a read tool…", team deny rule, auto mode; proxy `mcp.test.ts` "asks the server first…", "runs nothing upstream when the server denies / cannot be reached", "refuses an allow that is not for exactly this call"                                                                                                                                                                |
| ac-5 / Gate 2        | `server/src/mcp/approvals.test.ts` (15: unsigned, forged, tampered MAC, replayed, changed input, expired, other tool/run/team, tool_call_id binding, run ended, unknown kid, row not allowed, source failure, stub); `mcp.db.test.ts` "Gate 2: …" (unsigned, valid once + replay, forged, changed input, expired, other tool, other run, deny-by-default stub)                                           |
| ac-6 audit           | `mcp.db.test.ts` audit rows (metadata only, no input), denied audit throttle; db `events.test.ts` documented; e2e audit allowed + denied                                                                                                                                                                                                                                                                 |
| ac-7 limits          | `limits.test.ts`; `mcp.test.ts` rate limit, concurrency cap, body cap; `upstream.test.ts` size cap, deadline                                                                                                                                                                                                                                                                                             |
| ac-8 chart           | `charts/kobe/tests/mcp-proxy.test.ts` (env + config schema, keys, no DB, internal key Secret, server port, NetworkPolicy ingress/egress), `sandbox.test.ts` (keys per service, release policy with 8082)                                                                                                                                                                                                 |
| e2e (k3d)            | `e2e/run.sh` "MCP proxy (KOBE-58)": forged token 401, pinned tools listed, read call reaches the fake server with the exact input, **write without approval refused and never reaches the fake server**, no sandbox token upstream, audit allowed + denied, sandboxes cannot reach server:8082, release namespace cannot reach the proxy                                                                 |
| commands             | `pnpm build typecheck lint format:check license:check`, `pnpm test --concurrency=2`, server + db `test:db`, `db:check`, `scripts/check-public-hygiene.sh`: see PR                                                                                                                                                                                                                                        |
