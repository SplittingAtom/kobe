# KOBE-646: SMA14: Memory setting per agent version (all / Notes only / off)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (two local commits, not pushed)
- **Branch / worktree:** `kobe-646-sm-agent-memory` in `../Kobe-wt646`, on `kobe-378-sm-migration`
  (main + 0222, PR #538)
- **Depends on:** KOBE-377 (contract `agentMemorySettingSchema`), KOBE-645, KOBE-378 (0222)

## Plan

1. Migration alone: `0223_agent_version_memory` (generated) adds `memory text NOT NULL DEFAULT
'all'` + CHECK `<table>_memory` to `team_agent_versions` and `site_agent_versions`.
2. Feature: API `POST /v1/agents/{id}/memory`, `memory` on every version shape, run assembly
   helper, delivery + policy, agent editor, guide.

## Decisions

- **Column on both version tables** (team and site): personal and gallery agents have versions in
  `site_agent_versions`. `team_agent_versions` is a team table with RLS already; only a column.
  Mirrored list `AGENT_VERSION_MEMORY_SETTINGS` in `@kobe/db`; `semantic-contract.test.ts` keeps
  it equal to protocol `AGENT_MEMORY_SETTINGS`.
- **The draft has no memory setting.** A change is `POST /v1/agents/{id}/memory {memory}`: the
  current version's content (definition, frozen skills; tool manifest recomputed, as a rollback)
  is republished as a new version with the setting (`draftRevision: null`,
  `republishedFrom: <current>`), so the roster version rule applies unchanged (follow latest gets
  it, pinned entries and threads keep theirs). Publish from the draft (and the eval gate's
  publish) keeps the current version's setting; rollback restores the republished version's.
  Same rights, publish rate and Dangerous-mode rule as rollback; not eval-gated (definition and
  tools unchanged). Errors: 409 `unchanged` (same setting), 409 `not_published`, 400 bad value.
  Audit `agent.memory_changed` (`version`, `fromVersion`, `memory`), in `docs/audit-log.md`.
- **One helper:** `services/server/src/agents/run-memory.ts` — `readRunMemoryPlan(tx, run)` →
  `{setting, notes, semantic}` from the run's version (`runs.agent_version`, else the thread's
  pin); a test chat (`is_test`, no version) uses the agent's **current** version's setting (`all`
  before the first publish); no agent → `all`. KOBE-382/383/399 read `.semantic`.
  `memoryPlan(setting, isolation)`: skill eval → nothing; test chat → never semantic.
- **Run assembly today:** `delivery.ts` sends `run.start.memory` only when `plan.notes`
  (unreadable plan → no memory, fail closed). `off` also adds `remember`/`recall` to the run's
  `toolsDeny` in `loadRunAgentTools` (server line behind the sandbox, which lists the tools only
  when `run.start.memory` came). Always the runner's memory (target user), never the owner's.
- **Evals / test chats, verified not widened:** eval sandboxes (`evalThreadId`, KOBE-325) still
  get no `run.start.memory` and the policy still denies memory tools (`eval_run_isolated`);
  builder test chats keep Notes as today (now following the current version's setting) and are
  marked never-semantic for KOBE-382.
- **Web:** Memory section in the agent builder (team and personal agents, also via `/agents`):
  three radios + **Save as a new version**; hidden in roster view; "Publish the agent to choose
  its memory" before the first publish. Version history shows "Memory: …" for non-`all`
  versions and "Memory changed from vN" (a republish of the version just before; a rollback can
  never be that).
- **Docs:** `docs/guide/agents/agents.md` (Memory subsection + summary, which feeds `/llms.txt`),
  `docs/guide/memory.md`, `docs/guide/for-agents/working-in-a-sandbox.md`.

## Coordinator answers and review fixes (2026-11-13)

- Gallery editor gets the same Memory section (`MemorySetting` takes its read/save calls; gallery
  API `getGalleryVersion`, `setGalleryAgentMemory`); test in `gallery-agent-editor.test.tsx`.
- "Not evaluated" stays (memory changes behaviour, re-evaluate); said in the guide.
- Opus review (`review-646.md`, not committed): M1 adopt copies the adopted version's `memory`
  into v1 (`publishDraftIn` `memory` override; test in `agent-ownership.db.test.ts`); forks start
  at `all` (forker is the author; in the guide). L1 end-to-end test with the real engine: on an
  `off` run `policy.check` remember/recall → `agent_tool_deny`, `memory.put`/`memory.read` →
  `not_allowed`, nothing stored. L2 restore confirmation says "Memory: Off → All memory." when the
  setting changes. L3 Dangerous check moved into `setAgentMemory` after `lockAgent`
  (`dangerous_forbidden` → 403 `dangerous_mode_forbidden`); rollback's pre-lock check is
  unchanged (outside this ticket). L4 "Memory changed from vN" comes from the stored rows (source
  version on the page with a different setting; a restore copies the setting), not numbers.

## For KOBE-382/383/399 (review I3)

`notes_only` blocks semantic memory only through `readRunMemoryPlan(...).semantic`; it must be
enforced **server-side** there: the selector must not fill `run.start.memory.semantic`, and if
item recall reuses the `recall` tool name `toolsDeny` cannot tell the two apart, so `readMemory`
must check `plan.semantic` itself. Any new memory tool (e.g. `show_memory_item`) joins the `off`
deny list (`MEMORY_TOOLS` or its own list in `loadRunAgentTools`).

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/agent-version-memory-upgrade.db.test.ts` (existing team/personal/gallery
  versions read `all`, rest unchanged, still immutable, CHECK refuses other values).
- ac-2: `services/server/src/agent-memory-setting.db.test.ts` (API, contract parse, audit,
  publish/rollback carry-over, refusals, personal agents);
  `apps/web/components/admin/team/agent-builder/memory-setting.test.tsx`.
- ac-3: same server file, `it.each` over all/notes_only/off (plan, `run.start.memory` with the
  runner's Notes, memory tools in `toolsDeny`), test chat and no-agent cases;
  `services/server/src/agents/run-memory.test.ts`. Evals verified:
  `skill-eval-runner.db.test.ts` (bench now announces `memory`; `run.start` has none, `remember`
  denied `eval_run_isolated`).
- ac-4: guide pages above; `packages/guide` tests pass.
