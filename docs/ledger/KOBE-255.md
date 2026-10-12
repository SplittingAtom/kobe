# KOBE-255: Rename R2: Site replaces Install in the API and code

- **Status:** PR #246 (a: server, protocol, CLI) merged; PR #247 (b: web, e2e) in review
- **Branch / worktree:** `kobe-255-site-rename-api-code` (a), `kobe-255-site-rename-web` (b) in `../Kobe-wt255`
- **Depends on:** R1 KOBE-257 (merged). Followed by R3 KOBE-256 (database).

## Plan

Two PRs, each green on its own. (a) `services/*`, `packages/*` (db code, protocol, CLI), the API
paths in docs, and the web/e2e callers of every renamed API path or field (paths, `siteRole`,
`budgets.site`, `?level=site`), so the web keeps working. (b) the web app's own identifiers, files
and directories, the console kind, e2e names and the guard over `apps/` and `e2e/`. Renames were
done by rule (identifiers, paths, permission strings, file imports), then by hand where a value is
stored; `git mv` for every file.

## Decisions

- **API:** `/v1/install/*` → `/v1/site/*`, `GET/PUT /v1/memory/settings?level=install` → `level=site`.
  No aliases: only this repo's web app, e2e scripts and docs called them (no CLI or chart use).
  Operators' own scripts against `/v1/install` (if any) get 404; noted under open questions.
  `site-routes.db.test.ts` checks every site read answers on `/v1/site` and 404s on the old prefix.
- **API fields:** `/v1/me` and `/v1/site/users` say `siteRole` (was `installRole`); the team budgets
  view says `site` (was `install`). `ActorContext.site_role` in `@kobe/protocol` (in-process only).
- **Permissions:** `install.*` → `site.*` (`SITE_PERMISSIONS`, `requireSitePermission`); never stored.
- **OpenAPI:** `services/server/openapi.json` documents threads, runs and approvals only; it has no
  `/v1/install` path. Its only "install" strings are the stored policy codes below (R3).
- **Audit (ac-3):** new events use `site.settings.updated`, `identity.site_role.granted|revoked`,
  `memory.site_settings_changed`; the event visibility class is `site`. Historical rows keep their
  names (hash chain untouched): `HISTORICAL_AUDIT_ACTIONS` maps each old name to its successor,
  `audit()` refuses the old names, and the read API's `action`/`category` filters accept either
  name and match both (`inArray` over `auditActionNames` / `auditCategoryNames`; `install` category
  → `site`). Export and forwarding send each row's stored name. Tested in
  `packages/db/src/audit.db.test.ts` ("historical install.* rows next to new site.* rows": chain
  verifies, filters by old/new action and category find both) and `audit/events.test.ts`.
  Documented in `docs/audit-log.md` ("Historical names").
- **Export scope** (`ExportScope`) and the audit event scope are code-only values: now `site`.
- **Files:** `routes/install-*.ts` → `routes/site-*.ts`, `invitations/install-invites.ts` →
  `site-invites.ts`, `two-replicas-install.db.test.ts` → `two-replicas-site.db.test.ts`; web in (b).
- **Comments and test names:** "install" meaning the scope says "site" (rule-based pass over
  scope phrases). Left: the verb and an installation in the deployment sense ("a fresh install",
  "restored install", `helm install`, `pre-install` hooks, `docs/install.md`).
- **Guard:** `scripts/site-identifiers.mjs` (run by `check-site-wording.mjs`, so `pnpm verify`
  and CI) fails on camel/Pascal/UPPER identifiers with the scope, `/v1/install`, `level=install`,
  `install.<x>.<y>` permissions and `install-*`/`install/` file names, in code and tests. Allowed:
  snake_case DB names, the drizzle objects that mirror tables/enums/columns, the historical audit
  names, `installMemoryHooks` (a verb), and lines marked `site-identifiers: allow`. PR (a) scans
  `services`, `packages`; PR (b) adds `apps`, `e2e`.

## Deferred to R3 (KOBE-256): stored names and values

1. **Tables, enums, columns, constraints, indexes** `install_*` and the drizzle objects named after
   them: `installAgents`, `installAgentVersions`, `installAgentScope`/`InstallAgentScope`,
   `installRole` (pgEnum), `installRoles`, `installSettings`, `installToolRules`, `installSkills`,
   `installSkillVersions`, `installSkillScans`, `installModelLimits`, `installModelSpendDaily`,
   `installBudgetReservations`, `SUSPENDABLE_INSTALL_SCOPES`, `threads.installAgentId` (casing
   `snake_case`: the key is the column name). SQL in code and tests (`install_settings`, …).
2. **Budget scope `"install"`:** `BUDGET_SCOPES` (`budget_alerts` check), `BUDGET_STOP_SCOPES`
   (`runs.budget_stop_scope` check), `run.budget_stopped` event payload (`run_events`), model-gateway
   line keys and `SCOPE_WORDS`, web `budgets.ts`/`run-panel.tsx` scope unions.
3. **Policy:** stage `install_deny`, reason codes `install_deny_rule`, `install_ask_rule` (persisted in
   `run_events`; in `@kobe/protocol` and `openapi.json`), rule scope `"install"` (`PolicyRule.scope`,
   `RuleScope`, web `policy.ts`), tool manifest `floor: "install"` and `PublishFloor.scope` (frozen in
   published agent versions).
4. **Audit target values** `scope: "install"` (`policy.rule.*`, `models.budget.changed`,
   `run.budget_stopped`): hash-chained, never rewritten; after R3 readers must accept both.
5. **Break-glass** notification recipient role `install_admin` (check constraint).
6. **Web search** envelope context `recordId: "install"`: bound into the sealed key; renaming it
   needs a re-seal.
7. **External:** Bifrost customer name `kobe-install` (`SITE_CUSTOMER`): renaming orphans the live
   customer and its budget unless the reconcile migrates it.
8. `install_settings` keys, `packages/db/README.md`, migration comments.

## Open questions (for Chris or the coordinator)

- SIEM rules or scripts outside the repo keyed on `install.settings.updated`,
  `identity.install_role.*`, `memory.install_settings_changed` or on `/v1/install/*` must add the
  new names (documented in `docs/audit-log.md`). No in-repo consumer remains.

## Evidence (acceptance criteria → test or command output)

- **ac-1:** `services/server/src/site-routes.db.test.ts`; all server DB tests use `/v1/site`;
  web API clients and `e2e/*.sh`, `e2e/gate*/client.mjs` call `/v1/site`; web tests (`api.test.ts`).
- **ac-2:** `scripts/site-identifiers.mjs` passes over `services`, `packages` (a) and `apps`, `e2e` (b).
- **ac-3:** `packages/db/src/audit.db.test.ts` (mixed chain), `audit/events.test.ts`.
- **ac-4:** `pnpm verify` with DB tests; CI on both PRs (e2e included).
