# KOBE-325: B6: Eval runner: ephemeral sandboxes with and without the skill

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## Handoff (read first)

- **Branch:** `group-skills-b` in `../Kobe-skB`. 320–324 are committed and reviewed (324's
  contract: `packages/protocol/src/skill-evals/`, [docs/skill-evals.md](../skill-evals.md); the
  parser is `@kobe/protocol/skill-evals`).
- **Done here:** the migration part (see Progress). The previous agent stopped because its
  context was long; continue from "Next".
- **Migrations:** 0145 (generated) and 0146 (custom). With 0141–0144 they get renumbered at the
  coordinator's `db:rebase` (main has its own 0141/0142).
- **Startup work:** the runner and the reaper need the sandbox provider, so they start in
  `services/server/src/index.ts` beside the Orbit eval sweep (`agents/eval/`, a good pattern for
  a provider-backed sweep), **not** in `startup/jobs.ts`. On a fresh site they write nothing (no
  eval runs), so `startup-seeds.ts` needs nothing.
- **Next, in order:**
  1. **Wire slot plumbing.** `sandbox_connections` is keyed by a unique index (team, user, slot);
     `registry.ts` already upserts on it, but only for slot `''`. Add `slot` to `SandboxTarget`
     (default `''`) and to every query on `sandbox_connections`, `sandbox_commands` and
     `sandbox_run_leases`: `sandbox-wire/{commands,delivery,registry,router,run-state,sweeper}.ts`,
     `runs/{dispatch,sweeper,orchestrator,compaction,run-prompt}.ts`, `approvals/decide.ts`,
     `mcp/{approvals,run-context}.ts`, `egress/blocked-relay.ts`, `skills/materialize.ts`,
     `threads/{followups,title-source}.ts`, `offboarding/destroy.ts`, `routes/workspace-move.ts`,
     `cli/cold-start.ts`, `sandbox-lifecycle/store.ts`. A command takes its slot from its thread
     in `enqueueCommand` (`'e-' || thread.id` when `threads.skill_eval`). The connection's slot
     comes from the claim found at connect (`providerLiveness` / the bootstrap exchange in
     `sandbox/provider.ts`): claim `u-<user>` → `''`, `e-<thread>` → that slot after checking
     the eval row is live for that team and author. A wake for an `e-` slot never wakes the
     member's sandbox. Tests: two sandboxes of one member at once; a command for an eval thread
     never reaches the member's sandbox and the reverse.
  2. **Provider.** Per team: SandboxTemplate + SandboxWarmPool `kobe-eval-sandbox` (replicas 0;
     a claim requires `warmPoolRef`, checked on the cluster, agent-sandbox v1.0.4), workspace as
     an `emptyDir`, `KOBE_WORKSPACE_SYNC_INTERVAL_MS=0`. Claim `e-<thread>` with
     `spec.lifecycle {shutdownTime, shutdownPolicy: Delete}` (the claim CRD has these, plus
     `ttlSecondsAfterFinished`). `isolation.require()` before create, read-back check after.
  3. **Sandbox agent:** commands `eval.prepare` (fetch the fixtures zip over the sandbox
     listener with the run binding, unpack into `/workspace`) and `eval.snapshot` (the 324
     snapshot: walk roots, fixture paths only hashed, lstat, no links). New kinds need
     `SANDBOX_COMMAND_KINDS` in `@kobe/db` (its check constraint: a migration) and protocol frames.
  4. **Runner** (`services/server/src/skills/evals/`): start routes (draft / saved version), the
     scan and bundle like `skills/drafts/test-bundle.ts` but stored under the eval's own key
     (`skill_eval_runs.bundle_key`, a blob ref: retention must delete it with the run), the plan,
     a per-team queue (≤ `maxConcurrentSandboxes`, SKIP LOCKED), `withSkillEvals` resolver wrapper
     (`onlySkill` / no skills), checks with the 324 functions (`matches` under a VM timeout),
     one retry in a new thread and sandbox, `computeSkillEvalScorecard`, the judge seam (326; until
     then a `judge` check fails `judge_failed`), cancel, NOTIFY + SSE events.
  5. **Policy:** Kobe's `auto` mode already denies would-ask calls (`neverPromptReason`), but the
     team floor can clamp it stricter, so treat eval-thread runs like scheduled runs in
     `sandbox-wire/policy-check.ts` (deny with `eval_run_no_prompt`); never loosen the mode.
  6. **Threads:** eval threads stay out of lists and search, and refuse member sends.
  7. **Reaper:** every replica, advisory lock: delete eval claims (label) whose row is done, gone
     or past its deadline; end executions whose deadline passed.
  8. Retention and offboarding purges of `skill_eval_runs` (the hold trigger skips held rows
     silently) and their objects.
  9. Tests the 324 handoff asked for: protocol `EVAL_MODEL_ALIAS_PATTERN` equals `@kobe/db`
     `MODEL_ALIAS_PATTERN`; `SKILL_EVAL_RUN_STATES` / modes equal the protocol lists.
- **Gotchas:** drizzle orders a primary-key swap before the `ADD COLUMN` it needs (so the
  connection key is a unique index); `threads-plans.db.test.ts` counts break-glass policies (now
  18); the CLI's `catalog.db.test.ts` lists blob-ref tables newer than its old schema.

## Design

**What runs.** An eval run (`skill_eval_runs`) of one subject (a draft revision or a saved team or
personal version) plans executions with `planSkillEvalExecutions`. One execution
(`skill_eval_results`, one row per case × with/without) is one ordinary Kobe run in its own thread
(`threads.skill_eval = true`, owner = the author, the Kobe gallery agent like test chats), in its own
**ephemeral sandbox**. A retry (one, after failed / error / timed_out) is a new thread and a new
sandbox, so attempts never share history or files.

**Sandbox identity: slots.** Today every wire table is keyed by (team, user): one sandbox per member
(D11). An eval sandbox runs as the author but must not replace the author's own connection, so the
wire gets a **slot**: `''` for the member's sandbox, `e-<thread id>` for an eval thread's sandbox.
`sandbox_connections` (PK team, user, slot), `sandbox_commands` and `sandbox_run_leases` carry it.
The connection's slot comes from the claim the server finds at connect (claim `u-<user>` → `''`,
claim `e-<thread>` → that slot, after checking the eval row is live, of that team and author). A
command's slot comes from its **thread** (inside `enqueueCommand`, which already checks the thread
is the target user's), so no caller can route into another sandbox. A wake for slot `e-…` never
wakes the member's sandbox: the eval sandbox exists or the command fails.

**Kubernetes.** Per team namespace, reconciled with the rest: SandboxTemplate `kobe-eval-sandbox`
(the member pod spec with the workspace as an `emptyDir`, no volume claim templates, workspace
sync off) and SandboxWarmPool `kobe-eval-sandbox` with 0 replicas (claims need a pool ref). An
execution's SandboxClaim `e-<thread id>` carries the team, author and eval labels/annotations and
`lifecycle: {shutdownTime: now + case wall clock + 5 min, shutdownPolicy: Delete}`, so the cluster
deletes it even if every server replica is gone. Create goes through `isolation.require()` and the
read-back check (gVisor/Kata handler, never a bypass). The namespace NetworkPolicy applies (server
wire, model gateway, MCP proxy, egress proxy only); no Secret is mounted; tokens are the usual
session tokens; egress via the proxy under the team's list.

**Cleanup on every path.** (1) The runner deletes the claim when an execution ends (done, error,
timeout, cancel). (2) A reaper on every replica (advisory lock) deletes eval claims whose row is
done, gone, or past its deadline, and errors executions whose deadline passed (server crash
mid-run). (3) The claim's own `shutdownTime` is the cluster-side backstop.

**Isolation of the run.** `withSkillEvals` (resolver wrapper like `withDraftTests`): with the
skill, `onlySkill` = the eval's stored runtime bundle (scanned at start like a test chat's); without,
no skills at all (no Required, agent-named, offered or personal). Model: the suite's alias if the
team enabled it, else the team default (326 reports it). Would-ask tool calls are denied and
recorded (`eval_run_no_prompt`, like scheduled runs); the approval mode is never loosened.

**Fixtures and outputs.** Fixtures go to the sandbox as a zip object (never in the skill bundle,
which stays the runtime zip), fetched over the sandbox listener with the run binding, unpacked
into `/workspace` before the run (`eval.prepare` command). After the run, `eval.snapshot` walks the
glob roots (`EvalWorkspaceSnapshot`). Checks run on the server with the 324 contract.

**Events.** Progress lives in Postgres (`skill_eval_runs.progress_done`, result rows); every change
sends `NOTIFY kobe_skill_eval` with team and eval id only. `GET /v1/skill-evals/{id}/events` is an
SSE stream (same framing as the run stream) that re-reads on each hint (polling as the safety
net) and emits `skill.eval.progress` / `skill.eval.completed` (ids, statuses, numbers only).

## Progress

- [x] Migration (generated, 0145): eval tables, `threads.skill_eval*`, wire `slot` columns.
- [x] Migration (custom, 0146): RLS, break-glass read, silent legal hold, keys and checks;
      probes, `skill-evals.db.test.ts`, `skill-evals-upgrade.db.test.ts`; the member's connection
      upserts on the new key (slot `''`).
- [ ] Wire slot plumbing (connect, routing, leases, sweeps) with tests.
- [ ] Provider: eval template / pool / claim, reaper.
- [ ] Sandbox agent: `eval.prepare`, `eval.snapshot`.
- [ ] Runner, checks, routes, events; DB tests for ac-1..ac-4.
