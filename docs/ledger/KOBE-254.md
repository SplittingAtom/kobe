# KOBE-254: One gallery agent, Kobe, with every tool and every team connector

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review
- **Branch / worktree:** `kobe-254-single-kobe-agent` in `../Kobe-wt254`
- **Depends on:** KOBE-87 (seed, retire), KOBE-89 (the five agents it replaces), KOBE-111 (grants)

## Plan

1. Agent file: `connectors: all` (scalar literal, like `skills: exclusive`), `agentConnectors()`.
2. Manifest freezes `connectors: "all"`; resolver takes the team's enabled list for it; Orbit export.
3. Gallery: one definition `kobe` (generation 1); the seed archives (never deletes) retired keys.
4. Web: `DEFAULT_AGENT_GALLERY_KEY = "kobe"`; builder checkbox for every team connector.
5. Tests, e2e, docs.

## Decisions

- **User decision (2026-10-11):** one gallery agent, Kobe, replaces Assistant, Code Helper, Data
  Analyst, Document Drafter and Researcher. Not re-litigated.
- **`connectors: all` is stored as the string `all`** in frontmatter and in the frozen manifest
  (`toolManifestSchema.connectors` is now `string[] | "all"`; older manifests still parse). `[all]`
  stays a list naming a connector called `all`. No migration.
- **Never widens:** at run start `all` becomes the team's enabled, active connectors
  (`loadTeamFacts`), then the same filters as a list: team-enabled and user-connected
  (`resolveConnectors`), then `buildRunMcp` (exposure, pinned and undrifted tools, agent globs).
  The policy engine's live checks (enablement, exposure, drift, rules, approvals) are untouched.
  `manifestAllowsTool` admits any MCP tool for `all` (the ceiling is whatever the team enables);
  it is a necessary, never sufficient, check.
- **No omission notice for `all`:** a team connector the user has not connected is left out
  silently, since the agent named nothing; otherwise every Kobe run would list every unconnected
  team connector. Named connectors keep their `not_user_connected` notice.
- **Retire never hard-deletes:** `retireRemoved` now calls the new `archiveAgent` (archives even a
  never-published row) instead of `deleteOrArchiveAgent`. Audited `agent.archived` as system,
  `archived_by = 'seed'`. A restart does not revive them; only a release that lists the key again
  (rollback) restores one, as before (KOBE-87).
- **Kobe's file:** no `tools`, no `model`, no `approval_mode`; every built-in skill; `connectors:
all`; prompt folds in the five (research with the no-web-search notice from KOBE-114, data,
  documents with the Markdown preview artifact of KOBE-131 and share_file of KOBE-152, code,
  artifacts, skill-creator). About 3.3 KB.
- **Orbit export fixtures** renamed from "Data Analyst" to "Sales Analyst" (a team agent example,
  not a gallery key); `images/orbit-eval/test-image.sh` expectation follows.
- The upgrade DB test keeps the five old keys as fixture data (`gallery-kobe.db.test.ts`); no
  other code, test, e2e or doc names them (historic ledgers untouched).

## Open questions (for Chris or the coordinator)

- Should Kobe show a notice for team connectors the user has not connected? Chosen: no (see above).
- Schedules or project defaults that pointed at an old gallery agent now point at an archived one;
  their behaviour is the existing archived-agent path (no new thread). Not migrated to Kobe.

## Evidence (acceptance criteria → test or command output)

| AC   | Evidence                                                                                                                                                                                                                                                                                                                   |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 | `services/server/src/gallery-kobe.db.test.ts` (fresh install seeds only `kobe`, v1 published, `connectors: all`, no `tools`, only `unavailable` exclusions, new thread 201); `gallery/definitions.test.ts`; `apps/web/components/chat/default-agent.test.tsx`                                                              |
| ac-2 | `gallery-kobe.db.test.ts` (five archived by seed, audited once as system, never deleted or unarchived across three restarts, threads and entries readable, new thread 409; unpublished row archived not deleted)                                                                                                           |
| ac-3 | `packages/agent-file/src/agent-file.test.ts` (parse, round trip, export, API); `agents/manifest.test.ts`; `resolver/resolve.test.ts`; `runs-resolver.db.test.ts` "connectors: all" (team list only, exposure, grants per user, drift, disabled); `orbit-export.test.ts`; `form-model.test.ts`, `frontmatter-form.test.tsx` |
| ac-4 | grep of code, tests, e2e (`run.sh`, `scheduled-runs.sh`), docs; CI e2e on the PR                                                                                                                                                                                                                                           |
