# KOBE-97: Agent builder for personal agents

Status: PR open (branch `kobe-97-personal-agent-builder`).

## Decisions

- No member area existed in `apps/web`, so a small one was added at `/me/agents` (list, `new`,
  `[id]`), linked as "My agents" from the chat header next to the team switcher.
- The admin `AgentBuilderPage` gained a `scope` prop (`team` default, `personal`). Only the
  heading, the back link and the post-create redirect differ; create sends `scope: "personal"`.
  Edit, publish, rollback and export gating still come from the server's `canEdit`, `canPublish`
  and `canExport` flags, so owner-only behaviour is the server's, not a client copy.
- `MyAgentsShell` loads `/v1/team` (needs only `team.read`, held by every member) and provides the
  existing team access context, so the builder components (model field, publish dialog, version
  history) are reused unchanged. It checks no admin permission.
- Inventory and suspend stay in the team console; personal agents have `setStatus: false`.
- No migrations, no new endpoints, no server changes.

## Server check (ac-2)

`agentAccess` returns NONE for another user's personal agent and the store pins every
`install_agents` query to the owner. Existing `services/server/src/agents.db.test.ts` ("keeps
personal agents private to their owner...") covers GET, PUT and DELETE by non-owners (404) and
list filtering; `agent-versions.db.test.ts` covers publish for the owner. Nothing missing.

## Evidence

- `apps/web/components/me/my-agents.test.tsx`: list, create (scope personal, redirect), edit and
  publish as a plain member (no team.agents.* permission), 404 for someone else's agent, shell.
- `pnpm verify` before push.

## Open questions

- Personal agents have no Orbit-export copy tweaks; the button shows when the server says
  `canExport`.
