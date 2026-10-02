# KOBE-35: Policy engine and tool rules

- **Status:** in review
- **Branch / worktree:** `kobe-35-policy-engine` in `../Kobe-wt35`
- **Depends on:** KOBE-14 (merged), contracts wave 0 (merged, `packages/protocol` policy/tools/glob)

## Acceptance criteria (derived from spec D6, D8, D19, D24, D27, D29, D32, §5.4, §6.1, §6.3; Hadron unreachable)

- **ac-1 Engine.** A server-side `PolicyEngine` (protocol contract) evaluates every tool call in the
  D29 order install deny → team deny → install/team ask → risk class → thread approval mode → user
  allow rules → prompt; returns allow / deny / require_approval with explainable reasons (stable
  codes, stage, rule id). Deterministic and fast; fails closed (deny) on any error.
- **ac-2 Server-derived tools.** The tool descriptor comes from the server's registry
  (`BUILTIN_TOOLS`, pinned MCP catalog); unknown tool → deny `unknown_tool`; invalid input → deny
  `invalid_input`. Nothing the sandbox claims about risk/scope/source is used.
- **ac-3 Modes.** `ask-on-write` (default), `ask-all`, `auto` (allow-listed only; would-prompt →
  deny). Scheduled runs never prompt (D32). No bypass mode.
- **ac-4 MCP exposure (D27).** Connector must be enabled in the team; drifted tools denied;
  exposure read-only / all / custom enforced.
- **ac-5 Agent tools (D19, §6.3).** `tools.deny` (incl. `bash:rm -rf*` shorthand) denies;
  `tools.allow` restricts the agent's tool set.
- **ac-6 Rule storage.** `tool_rules` (team + user scope, team table with RLS) and
  `install_tool_rules` (install floor, install-wide, least-privilege grants); `arg_pattern` =
  JSON Pointer → glob (jsonb), never a regex; validation on write.
- **ac-7 Admin CRUD (D8).** Install Owner/Admin manage install rules; team admins manage team rules;
  members read team rules and list/revoke their own remember-rules.
- **ac-8 Remember (D29).** Storage + validation for "approve and remember" user × tool glob ×
  optional arg pattern × expiry (write path called by KOBE-37).
- **ac-9 Tests.** Table-driven D29 order, glob/arg matching incl. adversarial inputs, modes,
  unknown tools, MCP exposure, route authz per role, cross-team isolation, DB tests, probe suite.

## Design

- `services/server/src/policy/`
  - `evaluate.ts` — the pure, synchronous D29 pipeline (`evaluatePolicy`).
  - `engine.ts` — `createPolicyEngine({ rules, registry?, connectors?, settings?, now?, onError? })`:
    re-validates input, re-resolves the tool from the registry, loads rules/connector
    state/settings in parallel, evaluates; any error → deny.
  - `gates.ts` — agent `tools.allow/deny` and MCP connector checks (team-deny stage).
  - `patterns.ts` — glob + arg-pattern matching with fail-closed bias; agent-file shorthand;
    `allowGlobScoped`.
  - `rules.ts` — engine rule type, expiry, deterministic matching order, built-in allow rules.
  - `settings.ts` — `riskClassPrompts` table + the `promptSandboxWrites` switch.
  - `registry.ts` — `createToolRegistry(mcpCatalog)`; `NO_MCP_TOOLS` default.
  - `rule-store.ts` — Postgres rule source, settings source (5 s cache), admin CRUD.
  - `remember.ts` — `insertUserAllowRule(tx, …)` for KOBE-37.
- Routes: `routes/install-policy.ts` at `/v1/install/policy` (`install.policy.manage`) and
  `routes/team-policy.ts` at `/v1/team/policy` (`team.read` / `team.policy.manage`), each mounted
  with one line in `app.ts` (team-policy before `/team` so `requireTeam` runs once).

| Route                                             | Who                                 |
| ------------------------------------------------- | ----------------------------------- |
| `GET/POST /v1/install/policy/rules`               | install Owner/Admin                 |
| `PUT/DELETE /v1/install/policy/rules/{id}`        | install Owner/Admin                 |
| `GET/PUT /v1/install/policy/settings`             | install Owner/Admin                 |
| `GET /v1/team/policy/rules`                       | any team member                     |
| `POST /v1/team/policy/rules`, `PUT/DELETE …/{id}` | team admin                          |
| `GET /v1/team/policy/my-rules`, `DELETE …/{id}`   | any member, own remember-rules only |

Bodies: `{effect, tool_glob, arg_pattern?, note?, expires_at?}` (snake_case like the protocol's
`ToolRule`); PUT replaces the whole rule. 400 `invalid_request`, 404 `rule_not_found`, 409
`too_many_rules` (500 per install/team, 200 per user in a team).

## Decisions

- **(a) Ask rules beat allow rules.** A matching install or team ask rule always yields
  `require_approval` (deny in auto/scheduled). User (and team) allow rules only remove prompts that
  come from risk class or mode. Reading: D6 "team rules can only tighten", D29 order puts ask
  before user allow.
- **(b) Sandbox-scoped writes in `ask-on-write`: not prompted by risk class by default**, as one
  install switch `install_settings["policy.ask_on_write.prompt_sandbox_writes"]` (default false),
  flipped via `PUT /v1/install/policy/settings {promptSandboxWrites}` — no code change, no
  redeploy (engine cache 5 s). The table itself is `riskClassPrompts` in `policy/settings.ts`.
  Deny/ask rules and `ask-all` apply either way. **Awaiting Chris's confirmation.**
- **`auto` = ask-on-write's prompt set, denied.** Auto allows what ask-on-write would allow without
  asking (read risk, sandbox-bounded tools while the switch is off) plus allow-listed tools (user,
  team, built-in allow rules); anything that would prompt is denied with `mode_auto_not_allowlisted`
  followed by the reason it would have prompted. Scheduled runs (`actor.kind = schedule`) never
  prompt in any mode: `scheduled_run_no_prompt`.
- **`kobe`-scoped writes prompt in ask-on-write** (artifacts, share_file, memory): D23/D24 make
  project writes approval-gated. Personal `remember` is allowed by a **built-in allow rule**
  matching `{"/scope": "personal"}` (D24). KOBE-55/56 must give `remember` a required `scope`
  field (`personal` | `project`) or personal memory writes will prompt (fail-safe).
- **Storage split.** Spec §5.4's `tool_rules(team_id?, …)` is two tables so every team row has
  `team_id NOT NULL` + RLS: `install_tool_rules` (install-wide, effect deny|ask only — DB check) and
  `tool_rules` (team table; scope team|user; user rules effect allow only — DB check). User rules
  are per (user, team) — a remember in team A never loosens team B — and cascade away with the
  membership (FK `(team_id, user_id) → team_members`).
- **Team allow rules exist** (D6 "team ask/allow rules") and act like remember-rules for the whole
  team (same stage; can't beat deny/ask). Reason code `user_allow_rule` with "Allowed by a team
  rule" (no `team_allow_rule` code in the contract).
- **No blanket allow rules.** Allow rules (team and user) must name exactly one built-in or one
  connector's tools (literal `mcp__<server>__` prefix): `*`, `mcp__*`, `b*` are refused on write
  and ignored on read/evaluation. Otherwise one rule would switch off every prompt — a bypass mode
  in all but name. Deny/ask rules may be as broad as wanted. Remember-rules must additionally match
  the approved tool (built-ins: exact name).
- **Agent `tools.allow/deny`** are part of the team-deny stage: deny entries deny; a non-empty
  allow list restricts the agent's tools. Neither ever removes a prompt (an agent file is a
  builder's, not the user's consent). Shorthand `tool:argglob` matches the built-in's
  `primary_arg`; for tools without one, deny falls back to the tool name, allow doesn't match.
- **MCP exposure:** enabled/drift/exposure come from server state (`ConnectorStateSource`,
  KOBE-58/59); the exposure in the input must also allow the call (stricter wins).
- **Fail closed by effect.** Unmatchable subjects (over 16 384 UTF-16 units, non-serializable),
  malformed globs, unreadable stored rows: deny/ask rules match (or widen), allow rules don't.
  Unresolvable JSON pointers never match. Rule expiry uses the server's clock (`now`), not
  Postgres's.
- **Deterministic:** matching rules reported in id order; same inputs → same decision.
- **Engine re-resolves the tool** by name from the registry and ignores the input descriptor's
  risk/scope/source; the MCP catalog can't shadow a built-in.

## For KOBE-36 / 37 / 58 / 59 / 45 / 15

- **KOBE-36 (policy.check):** build `createPolicyEngine({ rules: createDbRuleSource(db), settings:
createDbSettingsSource(db), registry: createToolRegistry(catalog), connectors })` once per process.
  Call `decide` **outside** any `withTeam` transaction (nested withTeam is refused → deny).
- **KOBE-37 (approvals):** on `remember`, call `insertUserAllowRule(tx, { teamId, userId,
approvedTool, remember, now })` inside your withTeam transaction after verifying the approval is
  the caller's; map `glob_too_broad` / `invalid_rule` / `too_many_rules` to 400/400/409.
  `approval_granted` and `budget_exhausted` reasons are yours.
- **KOBE-58 (MCP proxy):** same engine, `context.enforcement_point = "mcp_proxy"`, and pass
  `connector_exposure`. Provide `ConnectorStateSource` (enabled, exposure, enabled_tools, drifted).
- **KOBE-59:** implement `McpToolCatalog.resolve(teamId, piToolName)` over pinned snapshots
  (`scope: "external"`, `riskFromAnnotations`). Until then every MCP tool is `unknown_tool`.
- **KOBE-45:** pass agent `tools.allow/deny` strings as-is (shorthand supported here).
- **KOBE-15 (audit):** hook rule create/update/delete in `routes/install-policy.ts`,
  `routes/team-policy.ts`, and the settings PUT.

## Open questions (for Chris or the coordinator)

1. **(b)** Confirm sandbox-scoped bash/write/edit are not prompted in ask-on-write (switch default
   `false`).
2. Should team allow rules exist at all, given D6 "can only tighten"? Implemented, scoped to one
   tool/connector, never beating deny/ask.
3. Contract gaps (for a protocol PR, not changed here): no `policy_error` reason code (internal
   errors report `install_deny_rule` at stage `install_deny` with an explanatory message); no
   `team_allow_rule` code; `unknown_tool`/`invalid_input` have no stage of their own (reported as
   `install_deny`).
4. Arg-pattern deny rules on shell commands are best effort (`rm  -rf`, `/bin/rm`, quoting
   bypass globs): the sandbox and egress proxy are the boundary, as D29 says.

## Evidence (acceptance criteria → test or command output)

- ac-1/ac-3: `src/policy/evaluate.test.ts` — 55 table rows (each D29 layer winning and losing),
  plus invariants over 1 512 mode × trigger × switch × rule-set × tool combinations (auto/schedule
  never `require_approval`; install deny always wins; ask never yields allow; determinism) and a
  1 000-rule × 1 000-call timing check (< 5 ms per decision). Every decision parsed with
  `policyDecisionSchema`.
- ac-2: `src/policy/engine.test.ts` — unknown/forged tools, lied-about risk, invalid inputs
  (U+0000, `__proto__`, unsafe integers, extra keys), fail-closed on every dependency error,
  registry shadowing.
- ac-4/ac-5: evaluate table rows "MCP …", "agent tools.…"; `patterns.test.ts`.
- Glob/arg matching: `src/policy/patterns.test.ts` — anchoring, canonical JSON for non-strings,
  RFC 6901 escapes and array indices, inherited properties, Unicode code points without
  normalisation, escapes, regex syntax inert, worst-case `*a*a…*b` at the cap (< 500 ms), over-long
  subjects fail closed per bias.
- ac-6/ac-7/ac-8: `src/policy.db.test.ts` (34 tests, real Postgres) — install/team route authz per
  role, validation 400s, blanket allow refused, cross-team 404s and decisions, caps, D29 order end
  to end with rules from Postgres, remember-rules (owner-only, team-only, expiry, cascade on member
  removal), switch round-trip.
- Probe suite + catalog check: `pnpm --filter @kobe/db test:db` (tool_rules fixture, RLS policy).
- `pnpm build test typecheck lint format:check` green (chart lint: pre-existing Helm 4 failure).
