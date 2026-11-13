# KOBE-381: SMA6: Switches — memory.enabled as master, new switches and settings

- **Status:** in review (local commit; coordinator opens the PR)
- **Branch / worktree:** `kobe-381-sm-switches` in `../Kobe-wt381` (on `kobe-380-sm-stewards`)
- **Depends on:** KOBE-376 (merged), KOBE-377 contract (merged), KOBE-380 (permissions). v1.3 wave A3.

## Plan

One feature commit, no migration: server switches + Site settings + learning model, route and admin
MCP tools on one shared wire schema, Site console and Workspace settings UI, guide and upgrade note.

## Decisions

- **Storage (no migration).** Site switches: one `site_settings` key each (`memory.enabled`,
  `memory.project_enabled`, new `memory.memories_enabled`, `memory.portable_enabled`,
  `memory.learn_enabled`, `memory.site_proposals_enabled`; `false` = off, absent = on). Site
  settings: one JSON key `memory.settings`, read field by field over defaults (a bad field reads as
  its default, logged). Workspace: the D24 columns of `team_memory_settings` stay the master and
  project switches; the v1.3 switches and the learning model override are `teams.settings.memory`
  (JSON; missing/non-boolean = on), like `remember_limits`. Defaults On on upgrade by construction.
- **AND rules** (`memory/switch-model.ts`, pure): master = Site ∧ Workspace `memoryEnabled` (gates
  Notes **and** Memories: the widening); memories = master ∧ both Memories; scopes user = memories,
  portable = memories ∧ Site portable, team = memories ∧ Workspace memories, site = memories ∧
  Workspace site-memories; **policy = memories** (ignores only "Site memories reach this
  Workspace's runs", per SM27); learn = memories ∧ both Learn; siteProposals = memories ∧ Workspace
  memories ∧ both propose switches. `readSwitches().effective` keeps the Notes shape for existing
  callers; `.memory` carries the rest for KOBE-382/393/397.
- **Site settings** (`memory/site-settings.ts`): learning model, embedding model (Phase D, unused),
  `context_budget_kib` 4–16 (default 8), `scope_limits` per scope 1–1000 (default 1000),
  `version_cap` 5–500 (50), `stale_after_days` 7–3650 (90), `rate_limits`
  {`learn_passes_per_hour` 1–100 (10), `saves_per_minute` 1–600 (30)}, `retention_days` 30–3650
  (365). No FTS language (Q11; a test asserts none). Ranges and rate-limit names are mine (brief
  names the settings, not bounds).
- **Learning model** (`memory/learning-model.ts`): judge pattern exactly as `judgeModelFor`
  minus its fallbacks: Site alias if enabled in the Workspace → Workspace override if enabled →
  unavailable (`no_learning_model` / `learning_model_not_enabled`; `learnAvailability` adds
  `memory_off` / `learn_off`). `pickLearningModel` takes no thread/default model at all. Saving a
  Workspace override requires it enabled there (400 `model_not_enabled`); a Site alias must be in
  the catalog (400 `unknown_alias`, nothing written).
- **Route** `/v1/memory/settings`: team level returns all Workspace values; PUT any subset;
  `expected` is now the **full** Workspace before-state (409 `changed_since_approval`). Site level
  returns switches + `settings`; PUT switches and/or a partial `settings`. `effective` adds
  `memories_enabled`, `scopes`, `policy`, `site_proposals_enabled`, `learn` {available, alias,
  source | reason, message}. Old two-key bodies still work (they are subsets).
- **Wire schemas server-local** (`memory/settings-wire.ts`), shared by route and MCP tools; the
  published protocol `memorySettingsSchema` is untouched (contract PRs stay separate).
- **Admin MCP** `team_memory_get/set`: output/input are the route's wire schema; `from` needs every
  key (the old two-key `from` is refused, tested); `before` compares all keys; summary in plain
  labels. Permission stays `team.memory.manage`. Contract test
  `kobe-mcp/tools/team-memory.test.ts`; DB case updated in `kobe-mcp-team.db.test.ts`.
- **Audit:** `memory.settings_changed` / `memory.site_settings_changed` gain optional fields (old
  rows still parse); Site settings are audited by name (`settings: [...]`), not value.
- **UI:** Workspace settings › Memory: seven switches with explanations (prerequisites disable
  dependants), learning model select (enabled models only, "None"), live "Learn uses X / is
  unavailable: reason" line. Site console › Settings › Memory: six switches + Site memory settings
  form with client range checks. Labels say "workspace" (WS5).
- **Docs:** `docs/guide/memory.md` (switches, learning model, Site settings), `admin/site-admin.md`,
  `admin/team-admin.md`, `admin/admin-from-a-conversation.md` (served at /docs and /llms.txt);
  release/upgrade note in `docs/install.md` › Upgrade notes.

## Open questions (for Chris or the coordinator)

1. **Context budget > 8 KiB:** the merged contract caps `run.start.memory.semantic` at
   `SEMANTIC_MEMORY_BLOCK_MAX_BYTES` = 8 KiB, so 9–16 KiB can be saved but the selector (KOBE-382)
   must clamp to 8 until a contract PR raises the cap.
2. **Policy vs. Workspace master/Memories off:** implemented literally (Policy ignores only the
   Site-memories switch, so a Workspace that turns memory off gets no Policy). Confirm.
3. **Learning model order:** "Site alias → Workspace override" read as the judge order (Site wins
   when enabled; the Workspace's model is used only when the Site's isn't usable there). If the
   Workspace override should win, swap two lines in `pickLearningModel`.
4. Retention window meaning (archived items/history?) and rate-limit names are provisional; the
   enforcing tickets (386, 393) may rename before anything reads them.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/memory/switches.test.ts` (per-switch rows, all Site×Workspace pairs
  AND-ed, master widening) + `memory-switches.db.test.ts` "effective".
- ac-2: `switches.test.ts` "Policy" + db "Policy reaches a Workspace that opted out".
- ac-3: `apps/web/components/admin/memory-switches.test.tsx` (every switch shown and saved, Site
  settings saved, no language field, range refusal); release note in `docs/install.md`.
- ac-4: `switches.test.ts` "learning model" + db "learning model (ac-4)" (a Workspace default
  model exists and is never used).
- ac-5: `kobe-mcp/tools/team-memory.test.ts` (contract), `team-tools.test.ts`,
  `session-contract.test.ts`, `kobe-mcp-team.db.test.ts`.
- ac-6: guide pages above.
- Off deletes nothing: db "turning switches off deletes nothing".
