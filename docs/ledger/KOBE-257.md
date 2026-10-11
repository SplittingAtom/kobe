# KOBE-257: Rename R1: Site replaces Install in everything users see

- **Status:** in review (PR #242)
- **Branch / worktree:** `kobe-257-site-rename-ui` in `../Kobe-wt257`
- **Depends on:** none. Followed by R2 KOBE-255 (API + code), then R3 KOBE-256 (database).

## Plan

R1 changes only what users and operators read: web text, titles, nav, the console URL, server
messages and emails, operator docs. Identifiers, file names, API paths, permission and audit names
and DB names stay for R2/R3.

## Decisions

- **URL:** the Next.js route folder moved `app/admin/install` → `app/admin/site`. The console kind
  stays `"install"` in code; `CONSOLE_SEGMENTS` (`lib/admin/nav/paths.ts`, re-exported by the
  registry) maps it to the `site` segment, so `consoleHref`/`sectionHref` and every link (nav,
  isolation banner, error notice, users page) produce `/admin/site/...`.
- **Redirects:** `next.config.ts` `redirects()` returns `consoleRedirects()` built from
  `RETIRED_CONSOLE_SEGMENTS`: one rule `/admin/install/:path*` → `/admin/site/:path*`,
  `permanent: true` (308); `:path*` also matches the bare `/admin/install`. R2 keeps the
  `install` entry when it renames the console kind.
- **Casing:** titles say "Site console", "Site roles", "Site budget"; prose follows the old style
  ("the site console", "a site admin", "the site Owner", "this site").
- **Email links:** all console paths in emails come from `CONSOLE_PATHS`
  (`services/server/src/mail/console-paths.ts`). Break-glass review → `/admin/site/break-glass`;
  site budget alert → `/admin/site/usage`; connector drift mail pointed at `/admin/connectors` (a
  404 before), now `/admin/site/connectors`. Bug fixed from review: a member's alert about their
  own budget linked to `/admin/team/budgets`, which members can't open; it now links to the chat
  (`/`), whose budget banner shows it (`budgetAlertPath`, `budgets/outbox.test.ts`).
- **Docs:** `docs/audit-log.md` Scope column says `site` (with a note that the code says `install`);
  payload values such as `scope` (install, team, user) are data and stay.
- **Guard:** `scripts/check-site-wording.mjs`, run from the repo root by `pnpm verify` and the CI
  `checks` job (not a package test, so turbo never caches it). Scans `apps/*`, `services/*` and
  `packages/*` sources (not tests), drops comments, normalises whitespace per file (catches
  prose wrapped over lines), one pattern list: "install <noun>" (admin, owner, role, console,
  floor, ceiling, catalog, budget, policy, rules, settings, key, …), "install's" (also ’ and
  `&apos;`), "this/your/one … install", "a fresh/new/test/existing install", "install-wide/-level",
  bare `<h2>Install</h2>` / `"Install"` labels. It self-tests its patterns on each run. R2 can
  extend it to comments once identifiers are renamed.
- **Rule (review):** "install" stays only for the act of installing; "a fresh install", "a test
  install", "an existing install", "one install per cluster", "the install key" now say "site"
  (UI, docs, chart comments).

## Kept "install" (for R2/R3)

1. **The verb / an installation:** `helm install`, "Helm install notes" (setup page), "Install
   gVisor…", "Install the agent-sandbox controller" (isolation page), server log hints "install
   with the Helm chart", "Install the chart's …" (sandbox provider), `docs/install.md` (the guide,
   its `## Install` section, pre-install hooks, install-time check), gallery "seeded at install
   and upgrade".
2. **API and data names (R2/R3):** `/v1/install/*`, `?level=install`, permissions `install.*`,
   audit actions (`install.settings.updated`, `identity.install_role.*`,
   `memory.install_settings_changed`), payload/scope values `"install"`, `install_settings`,
   `install_tool_rules`, policy reason `install_ask_rule`, Bifrost customer `kobe-install`.
3. **Identifiers and files (R2):** `ConsoleKind "install"`, `InstallAccess`, `installRole`,
   `components/admin/install/`, `lib/admin/nav/install/`, `lib/admin/api/install/`,
   `routes/install-*.ts`, `invitations/install-invites.ts`, HTML ids `install-budget`, test and
   describe names, all code comments.
4. **Docs left alone:** `docs/gates/gate-1.md`, `docs/gates/gate-2.md` (dated gate evidence),
   `packages/db/README.md` (schema doc: R3), `docs/ledger/*`, `docs/RUN-LEDGER.md`, e2e script
   comments and check names ("throwaway install", "the install's keys", "fresh install").

## Open questions (for Chris or the coordinator)

- None.

## Evidence (acceptance criteria → test or command output)

- **ac-1:** `scripts/check-site-wording.mjs` passes; nav and page title read "Site console"
  (`registry.test.ts`, `overview.test.tsx`, `console-shell.test.tsx`, `app/admin/site/layout.tsx`).
  Server messages and mails: `account-lifecycle.db.test.ts` (deactivated message),
  `break-glass.db.test.ts` and `connectors/drift-notify.db.test.ts` (links), egress-proxy and
  model-gateway tests (blocked / budget text).
- **ac-2:** `apps/web/lib/admin/nav/redirects.test.ts` (the redirect rule, every section links to
  `/admin/site/<id>`); `registry.test.ts` checks pages live under `app/admin/site`; e2e
  `e2e/run.sh` checks `GET /admin/install/users` → 308 with `Location: /admin/site/users`.
- **ac-3:** `pnpm verify` (with DB tests) and CI on the PR.
