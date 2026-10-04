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

## Open questions (for Chris or the coordinator)

- The "Team agents" nav entry needs `team.agents.suspend`, so a builder who isn't a team admin has
  no nav link to the builder (direct URL works; the server decides access). Should the entry's
  permission widen to `team.agents.build`? That changes the console registry, so left alone here.
- Skill, connector and model fields are free text (the schema validates format). Pickers from the
  team's catalog would need KOBE-48's inventory endpoints.
- Unarchive (`POST /:id/unarchive`) exists but has no UI here.

## Evidence (acceptance criteria -> test or command output)

- ac-1 create, edit and publish from one page: `apps/web/components/admin/agent-builder-pages.test.tsx`
  ("create", "edit and publish"); validation in `lib/admin/agent-builder/form-model.test.ts`.
- ac-2 version history shows and restores: same file, "version history" (list, current marker,
  restore, declined confirmation, paging).
- `pnpm verify`: see PR.
