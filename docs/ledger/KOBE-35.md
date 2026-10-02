# KOBE-35: Policy engine and tool rules

- **Status:** in review (PR #22)
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
`too_many_rules` (per install/team: 500 rules and 2 000 `arg_pattern` entries; per user in a
team: 200 rules and 800 entries; updates counted).

## Decisions

- **(a) Ask rules beat allow rules.** A matching install or team ask rule always yields
  `require_approval` (deny in auto/scheduled). No allow rule removes it. Reading: D6 "team rules
  can only tighten", D29 order puts ask before user allow.
- **(b) Sandbox-scoped writes in `ask-on-write`: not prompted by risk class by default**, as one
  install switch `install_settings["policy.ask_on_write.prompt_sandbox_writes"]` (default false),
  flipped via `PUT /v1/install/policy/settings {promptSandboxWrites}` — no code change, no
  redeploy (engine cache 5 s). The table itself is `riskClassPrompts` in `policy/settings.ts`.
  Deny/ask rules and `ask-all` apply either way. **Awaiting Chris's confirmation.**
- **Auto and scheduled runs = allow-listed only** (review 5; D29 "auto (allow-listed only)", D32
  "allow-listed and read-only-exposed tools"). Read-risk tools run; any other tool runs only if a
  user allow rule or a team allow rule lists it, else deny `mode_auto_not_allowlisted` /
  `scheduled_run_no_prompt` + the risk reason. bash/write/edit included, independent of switch
  (b). The agent's `tools.allow` only narrows. A scheduled run follows these rules in any mode.
- **Who lifts a prompt** (review 3/4). In interactive runs (ask-on-write, ask-all) **only the
  user's own allow rules** (approve and remember) lift a risk-class or mode prompt (D29 mode →
  user allow → prompt). **Team allow rules never lift a prompt** (D6 "can only tighten"); their
  only effect is to allow-list a tool for auto mode and scheduled runs. No built-in rule lifts
  anything; there are no built-in allow rules.
- **`kobe`-scoped writes prompt in ask-on-write** (artifacts, share_file, memory): D23/D24 make
  project writes approval-gated. Personal `remember` (input `scope: "personal"`) is exempt in the
  risk-class table (D24 "need no approval"), so it runs in ask-on-write, prompts in ask-all, and is
  denied in auto unless allow-listed. KOBE-55/56 must give `remember` a required `scope` field
  (`personal` | `project`) or personal memory writes will prompt (fail-safe).
- **Storage split.** Spec §5.4's `tool_rules(team_id?, …)` is two tables so every team row has
  `team_id NOT NULL` + RLS: `install_tool_rules` (install-wide, effect deny|ask only — DB check) and
  `tool_rules` (team table; scope team|user; user rules effect allow only — DB check). User rules
  are per (user, team) — a remember in team A never loosens team B — and cascade away with the
  membership (FK `(team_id, user_id) → team_members`).
- **Team allow rules** (D6 "team ask/allow rules") = the team's auto/scheduled allow-list (see
  above). Reason code `user_allow_rule` with "Allow-listed by your team for auto mode" (no
  `team_allow_rule` code in the contract).
- **No blanket allow rules.** Team allow rules must name exactly one built-in or one connector's
  tools (literal `mcp__<server>__` prefix): `*`, `mcp__*`, `b*` are refused on write and ignored on
  read/evaluation. **Remember-rules store the exact approved tool name** (review 6; optional
  `arg_pattern`), never `mcp__github__*`; a stored user rule with a wildcard is ignored. Deny/ask
  rules may be as broad as wanted.
- **Agent `tools.allow/deny`** are part of the team-deny stage: deny entries deny; a non-empty
  allow list restricts the agent's tools. Neither ever removes a prompt (an agent file is a
  builder's, not the user's consent). Shorthand `tool:argglob` matches the built-in's primary
  argument on the prepared input (canonical paths); grep/find use `/path` (server-side override of
  the protocol's `/pattern`, review 8). For tools without one, or an input without it, deny falls
  back to the tool name, allow doesn't match.
- **Input checks before rules** (review 1, `policy/tool-inputs.ts`). Pi 1.0.0 built-ins are
  validated against strict schemas copied from the published tarball (read, write, edit, bash,
  powershell, ls, grep, find, codemode, tool_search): unknown or alias keys → deny `invalid_input`
  (incl. edit's legacy top-level `oldText`/`newText`, which Pi folds into `edits[]`). kobe-tools have
  no schema yet (KOBE-55/56) and pass as objects. MCP inputs are the MCP proxy's job (pinned schema).
- **Canonical paths** (review 7). File tools' `path` (read/write/edit/ls/grep/find, share_file) is
  resolved like Pi does against the sandbox cwd `/workspace` (relative → absolute, `//`, `.`, `..`
  collapsed); an omitted ls/grep/find path is the cwd. Paths Pi rewrites opaquely (`~`, leading `@`,
  `file:`, Unicode spaces) are denied. Rules match the canonical view; the call runs with the
  original (signed) input. Assumes Pi's cwd is `/workspace` (KOBE-23/36 must keep it so). Pi's read
  fallbacks (NFD / curly-quote / AM-PM filename variants when the exact file is missing) are not
  modelled: deny rules on exact filenames can miss those variants.
- **MCP resource tools denied in v1** (review 2): `list_mcp_resources`,
  `list_mcp_resource_templates`, `read_mcp_resource` bypass per-connector gating; D27 lists MCP
  resources as "Later". Reason `connector_not_enabled` ("not available"; no `not_available` code in
  the contract).
- **MCP exposure:** enabled/drift/exposure come from server state (`ConnectorStateSource`,
  KOBE-58/59); the exposure in the input must also allow the call (stricter wins).
- **Fail closed by effect.** Unmatchable subjects (over 16 384 UTF-16 units, non-serializable),
  malformed globs, unreadable stored rows: deny/ask rules match (or widen), allow rules don't.
  **Unresolvable JSON pointers fall the same way** (review 1): a deny/ask rule whose pointer is
  missing from the input applies; an allow rule doesn't. JSON Pointer has no array wildcard
  (`/edits/0/oldText` is one element). Rule expiry uses the server's clock (`now`), not Postgres's.
- **Shell-command patterns are not a security boundary.** `bash:rm -rf*` and arg patterns on
  `/command` are best effort (`rm  -rf`, `/bin/rm`, quoting, `sh -c` all dodge globs); the sandbox
  and egress proxy are the boundary (D29).
- **Deterministic:** matching rules reported in id order; same inputs → same decision.
- **Engine re-resolves the tool** by name from the registry and ignores the input descriptor's
  risk/scope/source; the MCP catalog can't shadow a built-in.

## For KOBE-36 / 37 / 58 / 59 / 45 / 15

- **KOBE-36 (policy.check):** build `createPolicyEngine({ rules: createDbRuleSource(db), settings:
createDbSettingsSource(db), registry: createToolRegistry(catalog), connectors })` once per process.
  Call `decide` **outside** any `withTeam` transaction (nested withTeam is refused → deny).
  Before calling: **verify the actor is still a member of the team** and **clamp
  `run.approval_mode` to the install floor / team settings** (the engine trusts the effective mode
  it is given). **Hook every codemode nested call individually** (Pi ids `<parent>/<n>`): the engine
  checks `codemode` itself as a read-risk tool and relies on each nested call being decided on its
  own. Keep Pi's cwd at `/workspace` (path canonicalisation assumes it).
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
2. Contract gaps (for a protocol PR, not changed here): no `policy_error` reason code (internal
   errors report `install_deny_rule` at stage `install_deny` with an explanatory message); no
   `team_allow_rule` or `not_available` code; `unknown_tool`/`invalid_input` have no stage of their
   own (reported as `install_deny`); `BUILTIN_TOOLS.grep/find.primary_arg` should be `/path`
   (overridden server-side); built-in input schemas could live next to `BUILTIN_TOOLS`.
3. Strict schemas deny edit's legacy `oldText`/`newText` form. If Pi's `tool_call` hook sees
   arguments before `prepareArguments`, models using the legacy form get a clear deny; KOBE-36 to
   confirm which form the hook sees.

## Contract gaps (for the coordinator's contracts follow-up PR; not changed here)

- Reason codes missing from `POLICY_REASON_CODES`: `policy_error` (internal errors currently
  report `install_deny_rule` at stage `install_deny`), `team_allow_rule` (team allow-listing
  reports `user_allow_rule`), `not_available` (MCP resource tools report `connector_not_enabled`).
- `BUILTIN_TOOLS.grep.primary_arg` and `BUILTIN_TOOLS.find.primary_arg` should be `/path`, not
  `/pattern` (overridden server-side in `policy/patterns.ts`).
- Optional: `unknown_tool` / `invalid_input` have no stage of their own; built-in input schemas
  (`policy/tool-inputs.ts`) could move next to `BUILTIN_TOOLS`.

## Review round 1 (coordinator, 2 HIGH + 5 MEDIUM + 4 LOW) — resolution

1. HIGH unresolvable pointers / aliases: fail closed by effect + strict built-in schemas
   (evaluate rows "unknown key…", "edit's legacy…", "…unresolvable pointer…"; `tool-inputs.test.ts`).
2. HIGH MCP resource tools: denied (rows "MCP resource tools are not available…"; DB test).
3. MEDIUM team allow: never lifts a prompt; auto/scheduled allow-list only (rows "team allow does
   not lift…", "team allow allow-lists…"; invariant "a team allow rule never lifts a prompt";
   DB test).
4. MEDIUM only user allow lifts prompts; no built-in lifts ask-all (row "ask-all prompts for
   personal remember"; invariant "in ask-all, only a user allow rule…").
5. MEDIUM auto/scheduled allow-listed only, incl. bash/write/edit (rows "auto denies bash…",
   "scheduled run denies bash…"; invariant "non-read tools run only when allow-listed").
6. MEDIUM remember stores the exact tool (`remember.test.ts`; DB test "stores the exact tool").
7. MEDIUM path canonicalisation + docs (rows "deny path rule…", "user allow path pattern…").
8. LOW grep/find primary arg `/path`; omitted ls/grep/find path = cwd (rows "agent tools.deny grep…",
   "…find shorthand…", "ls with no path…").
9. LOW KOBE-36 obligations (membership, mode clamp) — ledger above.
10. LOW caps: rules and arg entries per scope (DB tests "caps rules…", "caps arg-pattern entries…").
11. LOW codemode nested calls — ledger above; codemode itself is decided as a read-risk built-in.

## Evidence (acceptance criteria → test or command output)

- ac-1/ac-3: `src/policy/evaluate.test.ts` — 87 table rows (each D29 layer winning and losing),
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
