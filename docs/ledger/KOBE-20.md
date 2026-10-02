# KOBE-20: Admin consoles: install and team (shell + navigation)

- **Status:** in review
- **Branch / worktree:** `kobe-20-admin-consoles` in `../Kobe-wt20`
- **Depends on:** KOBE-14, KOBE-13, KOBE-12, KOBE-9, KOBE-45 (all merged)

## Acceptance criteria (derived from spec D4, D6, D7, D8, D9, D19, §4 stories, §5.3, §6.1; Hadron unreachable)

- **ac-1 Two consoles.** `apps/web` has an install console (`/admin/install`, install Owner/Admin)
  and a team console (`/admin/team`, team admins of the active team), each a shell with grouped
  side navigation covering the D6/D8 areas and every `/v1/install/*` and `/v1/team/*` area of §6.1.
- **ac-2 Role-gated routing, server-decided.** Who may open a console or section comes from the
  server (`GET /v1/me` install role, `GET /v1/team` role + permissions), never from client state.
  The shell renders no page (so no page fetches) unless the role covers the section; every page's
  data comes from an API that enforces the same rule, and the page renders the API's 401/403/404/
  409/503 as the answer. Install roles never open the team console (D8).
- **ac-3 Pages for existing APIs.** Install: users (deactivate/reactivate), invitations
  (invite/resend/revoke), install roles (Owner grants/revokes Admin, transfers ownership), teams
  (create with first team admin, rename, roster), settings (required 2FA), isolation status with
  the fix (D4), gallery agents (import/export/suspend/delete). Team: members and roles (change
  role, remove, leave), team invitations (invite with role, revoke), team agents (list, suspend).
- **ac-4 Placeholders through one registry.** Sections whose APIs don't exist yet are registered
  with their ticket ("Coming in KOBE-xx") and served by one dynamic route; a later ticket adds one
  page directory and flips one entry, without touching shared lists (one file per section).
- **ac-5 Errors.** 403 (`forbidden`, `not_a_team_member`), 404, 409 (`no_active_team`,
  `team_mismatch`, domain conflicts), 503 `isolation_runtime_missing`, network failures and 5xx
  render as people-readable alerts with the way out (sign in, choose a team, reload, isolation fix);
  5xx bodies are never shown except for codes meant for people.
- **ac-6 Accessibility and layout.** Keyboard reachable (skip link, native controls, focus
  outline), labelled controls and tables, `aria-current` on the current section, alerts/status
  regions; responsive from phone width (folded nav on narrow screens); light and dark schemes.
- **ac-7 Casing.** The client sees camelCase only, whatever the route sends; request bodies use
  each route's own wire casing. No server route changes.
- **ac-8 Tests.** Unit tests for the registry and role gating, component tests that pages call the
  right APIs (method, path, body, `X-Kobe-Team`) and render errors; console smoke flows (Owner sees
  the install console, member doesn't, team admin sees the team console).

## Plan

1. `lib/api` (fetch wrapper + casing), `lib/admin/nav` (registry), `lib/admin/api` (resources),
   `lib/admin/rules.ts` (which buttons to offer).
2. `components/admin` (shell, nav, overview, placeholder, pages), `app/admin/**` routes.
3. Tests (vitest + happy-dom + Testing Library), screenshots, ledger.

## Nav registry: how a later ticket adds its page

Each section is one file, `apps/web/lib/admin/nav/{install,team}/<id>.ts`:

```ts
export default defineInstallSection({
  id: "models", // URL segment: /admin/install/models
  label: "Models and providers",
  description: "…",
  group: "Models and connectors", // typed: INSTALL_GROUPS / TEAM_GROUPS in nav/types.ts
  order: 10, // within the group; leave gaps
  minRole: "admin", // team sections: permission: "team.models.manage"
  status: comingIn("KOBE-44"), // → READY when the page exists
});
```

- **Building a placeholder section** (e.g. KOBE-44): add
  `apps/web/app/admin/install/models/page.tsx` (a static route wins over `[section]`), change the
  entry's `status` to `READY`, update the "wires the pages whose APIs exist" test list in
  `lib/admin/nav/registry.test.ts`.
- **A new section**: add its file and one `export { default as x } from "./x";` line to the
  folder's `index.ts`. Both barrels use git's `union` merge driver (`.gitattributes`), like the db
  schema index; order comes from `group`/`order`, never line order. `registry.test.ts` validates
  ids, duplicates and that team permissions exist in the server's matrix at team-admin level.
- Page data: add functions to `lib/admin/api/{install,team}.ts` (or a new module per area to avoid
  conflicts) using `apiRequest`; team calls pass `teamId` (sends `X-Kobe-Team`). Render with
  `useResource` / `useMutation` / `ResourceView` / `MutationStatus` from `components/admin`.

## Decisions

- **Routes:** `/admin` (links to the consoles you can open), `/admin/install/<section>`,
  `/admin/team/<section>`. The home page shows "Install console"/"Team console" links when the
  server says you can open them.
- **Gating is client-rendered from server answers, not done in Next server components.** The web
  pod has no internal URL for the API (the ingress routes `/v1` to the server, and the web pod's
  NetworkPolicy/chart don't wire web → server), so a server-side check would need chart changes.
  It would also add nothing to security: the authorization is the API's, and every page's data
  comes from an API that checks the same rule. The shell asks the server first and mounts no page
  (no page request) unless the role covers the section; a 403 from any API is rendered as the
  answer.
- **Console access rule:** a console opens if the caller can see at least one of its sections.
  Install sections declare a minimum install role (all `admin` today; `owner` supported). Team
  sections declare the `team.*` permission their API needs, checked against the permission list
  `GET /v1/team` returns, so the team console follows the server's matrix (today: team admins
  only; builders and members are refused). Install roles grant nothing in the team console (D8).
- **No install-wide permission list in the API:** `/v1/me` returns only the install role, so the
  registry carries `minRole` rather than mirroring `INSTALL_PERMISSIONS` (no server change).
- **Team audit view** uses `team.members.manage` until KOBE-15 adds a `team.audit.read` permission
  (comment in `nav/team/audit.ts`).
- **Placeholder ticket mapping** (best fit from the implementation prompt's ticket titles): models
  KOBE-44, connector registry KOBE-59, web search KOBE-63, policy floor + team policy KOBE-35,
  egress ceiling KOBE-38, team egress + access requests KOBE-39, skill blocklist + skill review
  KOBE-49, audit KOBE-15, break-glass KOBE-16, legal hold KOBE-17, retention KOBE-18, usage
  KOBE-43, budgets KOBE-42, team connectors KOBE-60, inventory KOBE-48, backup status KOBE-11.
- **Casing (no server changes):** the server's KOBE-13/14/45 routes answer in camelCase, spec
  §6.1 and KOBE-34+ use snake_case. `apiRequest` camelizes every response's keys
  (`lib/api/casing.ts`), skipping opaque documents (`frontmatter`) and dropping `__proto__` keys;
  request bodies are written per route in its own wire casing in `lib/admin/api/*`. Pages never
  see snake_case. Tests feed snake_case bodies (isolation, deactivation) through pages.
- **Errors:** server `message`s are shown for 4xx (they are written for people, ≤ 300 chars);
  5xx bodies are replaced by a generic message except `isolation_runtime_missing`. Network
  failures don't throw. Same-origin absolute paths only (`apiRequest` refuses `//host` and URLs).
- **`X-Kobe-Team` on every team call**, reads included, so a stale tab gets `team_mismatch`
  (rendered with a Reload button) rather than data from another team.
- **Buttons mirror server rules** (`lib/admin/rules.ts`): deactivation (Admins act on Users,
  Owner on Admins, nobody on the Owner or themselves), Owner-only role changes and transfer,
  Owner-only turning required 2FA off. Courtesy only; the server decides and its refusal is shown.
- **Install admins get no member-management UI for existing teams** (KOBE-14 decision): the teams
  page creates teams with a first team admin, renames, and shows read-only rosters.
- **Isolation (D4):** the isolation page shows state, RuntimeClass, handler, last check, the
  server's message, the fix steps from `docs/install.md#isolation`, and "Re-check now"
  (`POST /check`). Every install console page shows a banner while agents are disabled.
- **Gallery:** import (agent `.md` file, ≤ 128 KiB checked before upload), export (download link),
  suspend/reactivate, delete. Creating/editing agents is the builder (KOBE-48).
- **Styling:** the web app had no styles; the consoles use one CSS module
  (`components/admin/admin.module.css`, system fonts, light/dark, grid layout, nav folded behind a
  toggle below 48rem) plus a two-line global (`app/admin/admin-global.css`, body margin only on
  console pages).
- **Test deps (dev only, MIT):** `happy-dom`, `@testing-library/react`, `@testing-library/dom`,
  `@testing-library/user-event`. Component tests opt in with `// @vitest-environment happy-dom`.
- **Fresh sessions:** the switcher picks a team on first load (KOBE-14) and now fires
  `kobe:active-team`; the team console and the home page's console links listen and ask again, and
  the team console shows the switcher when no team is active (or the role is refused) so someone
  who is a team admin elsewhere can switch from there.
- **Role changes need Save** (a select alone changes nothing: keyboard users arrow through
  options); focus moves to the section on client navigation and follows inline forms.
- **Code review (subagent):** 0 CRITICAL/HIGH; MEDIUM 1–3 (active-team race, select firing a
  privileged change, focus management) and LOW (rename reset, file read outside the mutation,
  stale isolation banner, create button silently disabled) fixed; LOW "`useResource` ignores a
  changed `teamId`" noted: safe because switching teams reloads the page.
- **No browser e2e:** the repo has no web e2e harness (`e2e/run.sh` checks the cluster with curl,
  and the gating lives in the browser). The smoke flows run as component tests over the real
  shell and registry (`console-shell.test.tsx`); server-side authz is covered by the server suites.

## Open questions (for Chris or the coordinator)

- Should the API expose the caller's install permissions (like `/v1/team` does) so the install
  registry can use permission names instead of `minRole`? Small server change, not done here.
- Should `/v1/team` (or `/v1/me`) return the caller's user id with the team, saving the console a
  second request? Not needed; noted.
- Builders currently can't open the team console (no section requires a builder permission).
  If inventory (KOBE-48) should be visible to builders, give its entry a builder permission.
- `team.audit.read` doesn't exist; KOBE-15 should add it (team audit view, D6) and update
  `nav/team/audit.ts`.

## Evidence (acceptance criteria → test or command output)

- ac-1, ac-4: `apps/web/lib/admin/nav/registry.test.ts` (valid unique entries, ready vs
  placeholder set, §6.1 coverage, order independent of barrel order, permissions exist in the
  server matrix at team-admin level); `components/admin/overview.test.tsx` (overview and
  placeholder "Coming in KOBE-16"); `next build` route table lists `/admin/install/*`,
  `/admin/team/*` and the two `[section]` routes.
- ac-2: `registry.test.ts` › "role gating" (Owner/Admin yes, User no; team admin yes, builder and
  member no; consoles never cross); `components/admin/console-shell.test.tsx` (smoke: Owner and
  Admin see the install console; a plain user is refused and the page never mounts; team admin
  sees the team console; member and builder refused; section outside the role not mounted; 401
  → sign in; `no_active_team` → choose a team); `overview.test.tsx` › home page links.
- ac-3, ac-5, ac-7: `components/admin/install-pages.test.tsx` (22 tests) and
  `components/admin/team-pages.test.tsx` (12 tests): exact method/path/body per action,
  `X-Kobe-Team` on every team call and never on install calls, 403/404/409 (`last_team_admin`,
  `slug_taken`, `user_exists`, `team_mismatch` with Reload)/503 `isolation_runtime_missing` with
  the isolation link/500 without internals; `lib/admin/api/api.test.ts` (every resource route);
  `lib/api/client.test.ts`, `lib/api/casing.test.ts`; `lib/admin/rules.test.ts`.
- ac-6: native controls with labels/captions/`scope`, `aria-current`, skip link, `role=alert` /
  `role=status`; nav toggle test in `console-shell.test.tsx`; screenshots (desktop light/dark,
  390 px wide, keyboard skip link) attached to the PR.
- ac-8: `pnpm build test typecheck lint format:check license:check` green except the known
  `@kobe/chart#lint` failure on Helm 4 (pre-existing); web suite 173 tests.
