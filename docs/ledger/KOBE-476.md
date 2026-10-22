# KOBE-476: My Agents two-tab creator, icon picker, connector tool allow/deny, admin Dangerous mode

- **Status:** in review (not pushed; coordinator opens the PR)
- **Branch / worktree:** `group-39-agent-creator` in `../Kobe-wt476`
- **Spec:** [`docs/specs/agent-creator.md`](../specs/agent-creator.md) (AC1–AC4); approvals doc amended.
- **Migration:** none (frontmatter and tool manifest are jsonb; audit actions are an allowlist in code).

## Decisions

- **AC1 Dangerous mode** recorded as a numbered decision, "approved by Chris 2026-10-22"; ships only
  after his sign-off at gate review (with an Opus security review of this diff).
- It is an **agent-file** mode only (`AGENT_APPROVAL_MODES`); `@kobe/protocol` `APPROVAL_MODES`, run
  commands, `runs.approval_mode` and the wire are unchanged, so no client can ask for it on a thread.
- **Who:** site Owner/Admin or the active team's `team_admin` (`mayUseDangerousMode`,
  `services/server/src/policy/dangerous-mode.ts`). Enforced in `routes/agents.ts` (create, import,
  update → 403 `dangerous_mode_forbidden`; fork by a non-admin strips `approval_mode`) and
  `agents/version-routes.ts` (publish, rollback of a Dangerous definition).
- **Policy path:** the manifest freezes `approval_mode.dangerous: true` (requested null, effective
  the default). Per call, `createDbRunContextSource` → `loadRunDangerousMode` reads the run's
  **published** version (`runs.agent_version`; test chats of drafts ask as usual), requires an
  interactive non-eval run, and for personal agents re-checks the user is still an admin in the run's
  team (superseded by the review fixes below: `loadRunAgentTools`, `dangerousToolsFor`,
  `agent.dangerous_tools`).
- **Audit:** `agent.dangerous_mode.changed` (store, on create/update when it flips) and
  `policy.dangerous_mode.applied` per allowed call at the sandbox check and at the MCP proxy (a
  failed write denies the call). MCP sibling-run dedupe key includes the flag.
- **Badges:** My Agents row, builder header, chat agent picker (option + chip), composer agent chip
  (thread read gains `agent_dangerous` from the pinned version).
- **System prompt** is on the Identity tab only (Chris listed it on both).
- **Connector tools:** Allowed is `tools.allow`, Denied is `tools.deny`; connector tools are written
  one by one (review fix below).
- **Icons:** curated lucide subset (68 names) in `agent-icons.ts`, searchable dropdown; unknown
  stored values (emoji) kept as text.
- The team builder shares the component, so it gets the same two tabs.

## Review fixes (Opus review, 2026-10-22)

- **HIGH 1, allow-list only:** Dangerous needs `tools.allow` entries naming tools one by one
  (`explicitToolNames`, agent-file schema → 400 `invalid_agent` at `frontmatter.tools.allow`).
  The policy input carries `agent.dangerous_tools` (replaces the boolean); the engine allows only a
  tool in that list. `tools.allow` is still not enforced per call otherwise.
- **KOBE-481 (closes with this PR):** `policy/run-agent-tools.ts` loads the run's version's
  `tools.deny` (the draft's for a test chat) for every run, at `policy.check` and the MCP proxy;
  `checkAgentTools` refuses matching calls, built-in or MCP, in every mode
  (`evaluate.test.ts` "tools.deny in every mode", `dangerous-mode.db.test.ts`).
- **HIGH 2, floors win:** Dangerous never lifts a Kobe-scoped write's prompt or an auto/scheduled
  refusal; it only replaces a risk-class/mode prompt in ask-on-write/ask-all.
- **MEDIUM 3:** per call, the version's `published_by` (only an admin can publish Dangerous) must be
  active and still a site admin or this team's admin, for every scope; no column needed. Gallery
  versions seeded without a publisher never run in Dangerous mode.
- Creator writes chosen connectors' tools into `tools.allow` one by one; removing a connector
  removes them.

## Open questions (for Chris or the coordinator)

1. The gate1 browser spec was written and typechecks but was not run: gate1 runs main; it needs a
   deploy of this branch.

## Evidence

- ac-1/ac-2: `apps/web/components/admin/team/agent-builder/agent-creator.test.tsx` (tabs, Create on
  both, error tab switch, icon search, allow/deny moves, payload), `tool-lists.test.ts`,
  `form-model.test.ts`; updated builder and skill-reach tests.
- ac-3: `services/server/src/policy/evaluate.test.ts` (Dangerous block), `manifest.test.ts`,
  `fan-out.test.ts`, `agents-dangerous.db.test.ts` (who may set/keep/publish/roll back, fork drops,
  audit, runnable flag), `dangerous-mode.db.test.ts` (allow + audit, deny list, ask rule, site floor,
  draft, schedule, demoted personal owner, thread `agent_dangerous`).
- ac-4: full `@kobe/server test:db` green; web unit tests green; `e2e/browser/tests/agent-creator.spec.ts`.
