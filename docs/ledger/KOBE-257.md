# KOBE-257: Rename R1: Site replaces Install in everything users see

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-257-site-rename-ui` in `../Kobe-wt257`
- **Depends on:** none. Followed by R2 KOBE-255 (API + code), then R3 KOBE-256 (database).

## Plan

R1 changes only what users and operators read: web text, titles, nav, the console URL, server
messages and emails, operator docs. Identifiers, file names, API paths, permission and audit names
and DB names stay for R2/R3.

## Decisions

- **URL:** the Next.js route folder moved `app/admin/install` → `app/admin/site`. The console kind
  stays `"install"` in code; `CONSOLE_SEGMENTS` (`lib/admin/nav/registry.ts`) maps it to the `site`
  segment, so `consoleHref`/`sectionHref` and every nav link produce `/admin/site/...`.
- **Redirects:** `next.config.ts` `redirects()`: `/admin/install` → `/admin/site` and
  `/admin/install/:path*` → `/admin/site/:path*`, `permanent: true` (308).
- **Casing:** titles say "Site console", "Site roles", "Site budget"; prose follows the old style
  ("the site console", "a site admin", "the site Owner", "this site").
- **Email links fixed along the way:** break-glass review link → `/admin/site/break-glass`; budget
  alert → `/admin/site/usage`; connector drift mail pointed at `/admin/connectors` (a 404 before)
  and now at `/admin/site/connectors`.
- **Docs:** `docs/audit-log.md` Scope column says `site` (with a note that the code says `install`);
  payload values such as `scope` (install, team, user) are data and stay.
- **Guard tests:** `apps/web/lib/admin/site-wording.test.ts` and
  `services/server/src/site-wording.test.ts` fail on scope wording ("install admin", "install's",
  "this install", "install-wide", "install roles/console/floor/ceiling/…") in any non-comment line
  of web or service sources. R2 can widen them to comments once identifiers are renamed.

## Kept "install" (for R2/R3)

1. **The verb / an installation:** `helm install`, "Helm install notes" (setup page), "Install
   gVisor…", "Install the agent-sandbox controller" (isolation page), server log hints "install
   with the Helm chart", "Install the chart's …" (sandbox provider), `docs/install.md` (the guide,
   its `## Install` section, pre-install hooks, install-time check), "a fresh install" (egress
   ceiling page, docs, e2e), "a test install" (model-providers banner), "an existing install"
   (values.yaml, S3 prefix), "one install per cluster", gallery "seeded at install and upgrade".
2. **API and data names (R2/R3):** `/v1/install/*`, `?level=install`, permissions `install.*`,
   audit actions (`install.settings.updated`, `identity.install_role.*`,
   `memory.install_settings_changed`), payload/scope values `"install"`, `install_settings`,
   `install_tool_rules`, policy reason `install_ask_rule`, Bifrost customer `kobe-install`,
   "install key" / "install key-encryption key" (chart, backup-restore.md).
3. **Identifiers and files (R2):** `ConsoleKind "install"`, `InstallAccess`, `installRole`,
   `components/admin/install/`, `lib/admin/nav/install/`, `lib/admin/api/install/`,
   `routes/install-*.ts`, `invitations/install-invites.ts`, HTML ids `install-budget`, test and
   describe names, all code comments.
4. **Docs left alone:** `docs/gates/gate-1.md`, `docs/gates/gate-2.md` (dated gate evidence),
   `packages/db/README.md` (schema doc: R3), `docs/ledger/*`, `docs/RUN-LEDGER.md`, e2e script
   comments ("throwaway install", "the install's keys").

## Open questions (for Chris or the coordinator)

- "a test install" (provider https banner) and "a fresh install" were read as "an installation"
  and kept; say if they should read "site" too.

## Evidence (acceptance criteria → test or command output)

- **ac-1:** guard tests above (web + services) pass; nav and page title read "Site console"
  (`registry.test.ts`, `overview.test.tsx`, `console-shell.test.tsx`, `app/admin/site/layout.tsx`).
  Server messages and mails: `account-lifecycle.db.test.ts` (deactivated message),
  `break-glass.db.test.ts` and `connectors/drift-notify.db.test.ts` (links), egress-proxy and
  model-gateway tests (blocked / budget text).
- **ac-2:** `apps/web/lib/admin/nav/redirects.test.ts` (redirect rules, every section links to
  `/admin/site/<id>`); `registry.test.ts` checks pages live under `app/admin/site`; e2e
  `e2e/run.sh` checks `GET /admin/install/users` → 308 with `Location: /admin/site/users`.
- **ac-3:** `pnpm verify` (with DB tests) and CI on the PR.
