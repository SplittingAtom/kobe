# KOBE-91: 51b: Orbit export endpoint and UI actions

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-91-orbit-export-endpoint` in `../Kobe-wt91`
- **Depends on:** KOBE-90 (mapper, merged), KOBE-84 (builder, merged), KOBE-75/44 (model resolution)

## Plan

`GET /v1/agents/:id/versions/:version/orbit` on the team router (module
`services/server/src/agents/orbit/routes.ts`, mounted with one line in `routes/agents.ts`), the
pure model resolver `agents/orbit/model.ts`, and an "Export to Orbit" button in the builder.
No migrations.

## Decisions

- **Visibility and rights:** same `resolve` as the other version routes (404 for what the caller
  can't see) and `access.readDefinition` (403 for members), as `GET /versions/:n`. Published
  versions only exist once published, so an unknown version is `version_not_found` (404).
- **Model:** the version's pinned alias, else the team default, is resolved against the team's
  enabled models (`team_models` + catalog + provider) to an Inspect-style id: `<kind>/<model>`
  (openai, anthropic, gemini, ollama) or `openai-api/<provider id>/<model>` for OpenAI-compatible
  endpoints. Not enabled, or no pin and no default: 409 `model_not_resolvable` with a message, no
  file and no audit event. The mapper receives the resolved id through a copy of the definition
  (nothing mutated), so it needs no change.
- **MCP tools:** exported with none; the YAML starts with a `# Note:` comment saying so (plus any
  mapper warnings). `TODO(KOBE-62)` in `routes.ts` where the pinned snapshots' names go.
- **Response:** `application/yaml`, `Content-Disposition: attachment; filename="<slug>-v<n>.orbit.yaml"`,
  `X-Content-Type-Options: nosniff`. A mapper failure is 422 `orbit_export_invalid`.
- **Audit:** new event `agent.orbit_exported` (agentRef + `version`), written after a successful
  export like `agent.exported` (`recordAuditAfter`); `docs/audit-log.md` has the row. No migration:
  events are code-defined.
- **Team router only:** gallery agents are exported from a team (they are visible there, read-only);
  the install-admin gallery router has no team whose models could resolve the alias.
- **UI:** `OrbitExportButton` fetches the file (`apiTextFile`, new in `lib/api/client.ts`) and saves it
  as a download; a refusal shows the server's reason in the page and saves nothing (a plain link
  would download the JSON error). Shown under the form for the current version (also when the form
  is read-only) and per row in the version history.
- **Inventory (ac-1):** KOBE-86 had not landed on main when this was written, so the action is in
  the builder only. The inventory can reuse `OrbitExportButton` unchanged.

## Open questions (for Chris or the coordinator)

- Open point: the `openai-api/<provider id>/<model>` form for OpenAI-compatible endpoints follows
  Inspect's naming but is untested against a running Orbit. Coordinator: keep it; KOBE-92's eval
  image will exercise it.
- Answered: no export on the install gallery router; gallery agents export from a team context.
- Follow-up: once KOBE-86 (#75) merges, merge origin/main and add `OrbitExportButton` to the
  inventory rows (same permission check).

## Evidence (acceptance criteria -> test or command output)

- ac-1 builder: `apps/web/components/admin/agent-builder-pages.test.tsx` ("Export to Orbit"):
  toolbar, history row, refusal, never published. Inventory: not available yet (see above).
- ac-2 team-scoped and audited: `services/server/src/orbit-export.db.test.ts` (other team 404, member
  403, audit row with team and version, none on failure); model rules in
  `agents/orbit/model.test.ts`.
- `pnpm verify` and server `test:db`: see PR.
