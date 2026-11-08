# KOBE-564: Create kobe.skill.yaml with the chosen model when a version is promoted without one

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in progress
- **Branch / worktree:** `kobe-564-skill-manifest-generate` (main checkout; Chris's direct ask
  on 2026-11-07, no parallel lane)
- **Depends on:** KOBE-333 (Promote to Site), KOBE-234/326 (server calls), KOBE-322 (forks)

## Plan

Chris, 2026-11-07: "create a function that automatically creates the kobe.skill.yaml file when the
user wants to promote a skill. Use the currently selected model to create the file."

- **Protocol:** purpose `skill_manifest`, the first run-less server call
  (`RUNLESS_SERVER_CALL_PURPOSES`): claims `thread_id`/`run_id` optional, present for every
  run-bound purpose and absent for this one (refine); own limits (1024/3072 tokens, 60 s, 120 000
  chars, 512 KiB, 0.2).
- **Gateway:** `serverCallAttribution` skips `runMatches` for a run-less purpose; usage row with
  `run_id` NULL. Span placement guards the optional thread id.
- **DB:** `USAGE_KINDS` + `skill_manifest`; custom migration 0192 widens `run_usage_kind` and
  `run_usage_kind_shape` (NOT VALID, like 0100/0147); audit event `skill.manifest.generated`.
- **Server:** `skills/manifest/` (prompt with nonce delimiters, lenient parse + cleaning to the
  contract, YAML round-tripped through `readManifest`), `registry/promote-manifest.ts` (version
  files → generate → `startFork` with the file as an extra start file → audit),
  `POST /v1/skills/promotions/manifest`, `POST /v1/skills/drafts/:id/manifest`, `deps.skillManifests`.
- **Web:** `CreateManifest` under the Promote panel's refusals when `no_manifest`: model select
  (team default preselected, enabled models only), license select (Proprietary preselected), then
  the Workbench opens on the new draft.

## Decisions

- **"Currently selected model":** the Skills page has no conversation, so the member picks in the
  panel; the team default is preselected (the same resolution `run.start` uses). A model the team
  does not enable is refused (422), never swapped for another (D30 rule as for agents).
- **A new draft, not an edit of the version:** versions are immutable (hashes are identity); the
  manifest changes the package hash, so the evals must run again before promotion (SK20
  freshness). The route forks into a draft at one revision rather than writing a version itself.
- **License is the author's:** the model never sets `license`; the panel offers `Proprietary`
  (preselected, the promote-check's own suggestion), `Apache-2.0`, `MIT`, `BSD-3-Clause`.
- **Never the model's name, version, apiVersion, maintainers, compatibility, changelog:** forced
  from the version or dropped (`parse.ts`); the save writes the changelog.
- **Unparseable reply → seed manifest** (SKILL.md's description), reported as `source: seed`; a
  failed call → 502 with the gateway's code (the member retries or picks another model).
- **Run-less server call:** the design doc's run check exists so a server bug cannot charge another
  member; a member-started call has no run to check, and the token still binds team and user from
  the session. Accepted and documented in server-model-calls.md.

## Open questions (for Chris or the coordinator)

- Should the draft editor itself (Define tab) also show "Create kobe.skill.yaml"? The route
  `POST /v1/skills/drafts/:id/manifest` exists; no editor button yet.
- A tags vocabulary with many entries: the prompt lists up to 200 slugs.

## Evidence (acceptance criteria → test or command output)

- ac-1 protocol: `packages/protocol/src/server-call.test.ts` ("carries the skill manifest's
  purpose without a run…").
- ac-2 gateway + db: `services/model-gateway/src/server-call.test.ts` ("server calls: the skill
  manifest"), `packages/db/src/usage.db.test.ts` ("takes a skill_manifest row…").
- ac-3 generator: `services/server/src/skills/manifest/{parse,generate}.test.ts`.
- ac-4 route: `services/server/src/skill-manifest.db.test.ts`.
- ac-5 web: `apps/web/components/admin/skill-promotion.test.tsx` (Create kobe.skill.yaml).
- ac-6 docs: skill-package.md, design/server-model-calls.md, audit-log.md, this ledger.
