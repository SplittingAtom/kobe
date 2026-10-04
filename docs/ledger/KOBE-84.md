# KOBE-84: 48a: Agent builder: form, prompt editor, publish dialog, version history

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-84-agent-builder` in `../Kobe-wt84`
- **Depends on:** KOBE-45/46 (agent and version APIs, merged), KOBE-20 (team console)

## Plan

UI only, in the team console, on the existing `/v1/agents` routes. No server endpoints, no migrations.

- `/admin/team/agents/new` and `/admin/team/agents/[id]` render `AgentBuilderPage`; the team agents
  list links to both.
- `lib/admin/agent-builder/form-model.ts`: form state <-> frontmatter, validation with
  `validateAgentDefinition` from `@kobe/agent-file` (the schema the server applies), issues mapped
  back to form fields.
- `components/admin/team/agent-builder/`: form, prompt editor, publish dialog, version history.
- `lib/admin/api/team/agent-builder.ts`: the calls (get, create, save with `If-Match`, publish,
  versions, rollback).

## Decisions

- Built in the team console, styled with `admin.module.css` tokens (`--admin-*`). The shadcn tokens
  from #65 are chat-scoped, so the console doesn't use them; no global preflight added.
- `@kobe/agent-file` added as a web dependency (Apache-2.0, already a server dependency); the web
  bundle pulls in `yaml` through its index, which is small and pure JS.
- Frontmatter keys stay snake_case in requests and responses (`frontmatter` is an opaque key in
  `camelizeKeys`), so `approval_mode` round-trips untouched.
- Publish is only offered for a saved draft (`If-Match` carries the revision the person reviewed);
  the dialog never saves on its own. Server errors (412 conflict, `unchanged`, rate limit) show in
  the dialog.
- Rollback asks for confirmation (native, like other console pages), republishes the old version as
  the newest, then replaces the form with the server's draft. The confirmation warns about
  unsaved edits.
- Archived agents and agents the caller can't edit open read-only.
- Team agents only. Personal agents are created from the chat app (not part of the console).

- Review fixes: notices use the version number from the publish/rollback response; history is
  remounted (re-fetched) after each. Agent summaries gain `canPublish` (= `access.publish`, the
  check `/publish` and `/rollback` use), so Publish and Restore are hidden without that right.
  This is the one server change (an additive response field, tested in `agents/http.test.ts`).

## Open questions (for Chris or the coordinator)

Answered by the coordinator on PR #70, now implemented:

- "Team agents" nav entry and the builder open for `team.agents.build` (builders); suspend stays
  behind `team.agents.suspend`. The console opens for builders and shows them that one section.
- Model field is a picker of the team's enabled aliases (`GET /v1/team/models`) with "None (use
  team default)"; a stored alias that is no longer enabled stays selectable; free text if the
  catalog fails to load. Skills and connectors stay free text (pickers: KOBE-78, KOBE-59).
- No unarchive UI; team agents only (personal agents are a follow-up).

## Evidence (acceptance criteria -> test or command output)

- ac-1 create, edit and publish from one page: `apps/web/components/admin/agent-builder-pages.test.tsx`
  ("create", "edit and publish"); validation in `lib/admin/agent-builder/form-model.test.ts`.
- ac-2 version history shows and restores: same file, "version history" (list, current marker,
  restore, declined confirmation, paging).
- `pnpm verify`: see PR.
