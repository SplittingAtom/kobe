# Kobe — Agent creator and Dangerous mode (KOBE-476)

Status: **decisions by Chris, 2026-10-22** (AC1 approved by Chris 2026-10-22; it amends D29 and
ships only after his sign-off at the next gate review). Ledger: `docs/ledger/KOBE-476.md`.

## 1. Summary

The agent creator (My Agents → New agent, and the team builder, which shares it) becomes two
tabs, **Identity** and **Behaviour**, with Create/Save on both. Connector tools are listed so a
builder can move each one between **Allowed** and **Denied**. Admins get a new approval mode,
**Dangerous**: the agent's allowed tools run without an approval card. It is a server-side policy
outcome, never a bypass: every tool call is still decided by the server.

## 2. Decisions

**AC1. Dangerous approval mode.** (Chris, approved by Chris 2026-10-22; amends D29 "there is no
bypass mode" and the 2026-10-03 rule "approvals only by policy rule".)

- **Where it lives.** Agent frontmatter `approval_mode: dangerous` only (`@kobe/agent-file`
  `AGENT_APPROVAL_MODES`). It is **not** a thread or run mode: `@kobe/protocol` `APPROVAL_MODES`,
  run commands, `runs.approval_mode` and the sandbox wire keep `ask-on-write`, `ask-all`, `auto`.
  A client can't ask for it on a thread.
- **Who may set it.** Site admins (Owner, Admin) and team admins (`team_admin` of the active
  team). Server-enforced (`403 dangerous_mode_forbidden`) on create, import, draft update,
  publish and rollback whenever the resulting definition is in Dangerous mode, so a non-admin can
  neither set it nor keep it nor publish a version that has it. A **fork** by a non-admin drops it
  (the copy uses the team default mode). Gallery agents are site-admin curated.
- **When it applies (per call, at both enforcement points: `policy.check` and the MCP proxy).**
  The run's agent version (`runs.agent_version`, a published version: a draft's test chat asks as
  usual) has `approval_mode.dangerous` in its tool manifest, **and** the site approval floor is
  `auto` (no minimum: any stricter site floor turns Dangerous off), **and** for a personal agent the
  run's user is still a site admin or a team admin of the run's team (checked live), **and** the
  run is interactive (scheduled runs keep D32; skill evals never use it).
- **What it decides.** In the D29 order: site deny → team deny (including the agent's
  `tools.deny`, a non-empty `tools.allow`, connector enablement, exposure and drift) → site/team
  ask rules → **Dangerous: allow** (reason `dangerous_mode`, stage `approval_mode`) → risk class,
  mode, user rules, prompt. Denied tools are still refused and site/team ask rules still ask.
  Egress, MCP proxy credentials, sandbox isolation and budgets are unchanged. HMAC approvals for
  every other mode are unchanged. It applies whatever the thread's own mode.
- **Audit.** `agent.dangerous_mode.changed` (`enabled` true/false) whenever a create, import,
  update or fork turns it on or off; `policy.dangerous_mode.applied` for every call it allowed,
  per enforcement point (no input recorded).
- **Visible.** A "Dangerous" badge on the agent in My Agents, in the chat's agent picker and in
  the composer while such an agent is the conversation's agent.

**AC2. Two tabs.** Identity: Slug (new agents), Name, Icon, Role, Description, System prompt.
Behaviour: Model, Approval mode, Skills picker, Connectors picker, Allowed/Denied tools,
Conversation starters, and the existing check boxes. Chris listed System prompt on both tabs; it
is on Identity only (one field, one place). Create/Save is on both tabs; on a failed save the form
switches to the first tab holding an error.

**AC3. Icon picker.** A searchable dropdown over the app's own icon set (lucide), stored as the
existing `icon` field (kebab-case name, e.g. `bar-chart`). A stored emoji or unknown name is kept
and shown as text.

**AC4. Connector tools Allowed / Denied.** Choosing connectors lists each one's pinned tools
(`/v1/team/connectors`) in **Allowed**; a tool moves to **Denied** and back with buttons (keyboard
accessible, not drag-only). Saved as the existing fields: Denied tools are `tools.deny` entries.
Allowed connector tools are written into `tools.allow` only when the agent already restricts its
tools (a non-empty `tools.allow`); otherwise the allow list stays empty, because a non-empty allow
list would also cut off the built-in tools. Typed globs still work in both boxes.
