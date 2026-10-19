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
- **Done (step 2 so far):** wire plumbing (commands follow their thread; eval connections in
  `sandbox_eval_connections`; leases, `hello.ack`, frame authority and the lost-run sweep per
  sandbox; eval leases by claim UID; no wake for eval threads; no member workspace or memory in
  an eval sandbox; tokens carry `eval_thread`; liveness and the model gateway accept an eval
  sandbox only while its execution runs), the provider (eval template, empty pool, claims with
  `shutdownTime`, own quota), the agent's `eval.prepare` / `eval.snapshot`, the pure checks and
  executions (`skills/evals/{checks,execution}.ts`), the contract mirrors.
- **Next, in order:** (1) sandbox-listener auth option `allowEval` (workspace sync refuses eval
  tokens, skill bundles and `GET /v1/sandbox/skill-evals/fixtures?path=` accept them) and
  `locateBundle` serving the eval's `bundle_key`; (2) `withSkillEvals` resolver (`onlySkill` or no
  skills; no personal grants) and `createThread({skillEvalRunId})`; policy-check deny
  `eval_run_no_prompt`; MCP grant refused for eval principals; (3) start routes + prepare (scan,
  bundle and fixtures zip under `teams/<team>/skill-evals/<id>/`, plan rows); (4) runner: claim under
  a per-team advisory xact lock (count `starting|running|collecting` ≤ min(site
  `maxConcurrentSandboxes`, chart `maxConcurrentPerTeam`)), thread, sandbox, connect, prepare,
  submit (auto), wait (deadline, cancel, turns), snapshot, checks, delete claim, retry/finalize,
  scorecard; (5) events (NOTIFY `kobe_skill_eval`, SSE); (6) threads hidden + member sends
  refused; (7) reaper (advisory lock; claims by label whose row is done/gone/late; executions past
  deadline); offboarding (delete live eval claims, cancel runs) and retention (RETURNING keys).
- **Coordinator decisions (2026-10-18):** leases and claim checks by claim UID; per-team cap
  atomic across replicas (advisory lock); eval sandboxes have their own quota (never a member's);
  no personal connector or MCP credentials in evals (team connectors under team policy only), so
  **Registry re-runs (Phase C) run in the Registry team without the reviewer's personal keys**;
  the snapshot never follows a symlinked root or any link; offboarding deletes live eval
  sandboxes and cancels eval runs; cleanup on every path incl. a crash reaper.
- **Rollout:** no replica records its build, so nothing refuses eval starts during a rollout;
  docs/install.md says to start evals only after `rollout status` (an old pod could hand an
  eval's stop or steer to the member's own sandbox).
- **Startup jobs:** the runner and reaper need the sandbox provider, so they start in
  `index.ts` beside the Orbit eval sweep; main's G5 `startup/jobs.ts` is the place once this
  branch merges with it (renumbered at PR time): the reaper is a lock-guarded periodic job that
  slots in there.
- **Gotchas:** never change a key the previous release's SQL infers (`ON CONFLICT`): rolling
  upgrades and `helm rollback` run it on the new schema; `threads-plans.db.test.ts` counts
  break-glass policies (18); the CLI's `catalog.db.test.ts` lists blob-ref tables newer than its
  old schema.

## Design

**What runs.** An eval run (`skill_eval_runs`) of one subject (a draft revision or a saved team or
personal version) plans executions with `planSkillEvalExecutions`. One execution
(`skill_eval_results`, one row per case × with/without) is one ordinary Kobe run in its own thread
(`threads.skill_eval = true`, owner = the author, the Kobe gallery agent like test chats), in its own
**ephemeral sandbox**. A retry (one, after failed / error / timed_out) is a new thread and a new
sandbox, so attempts never share history or files.

**Sandbox identity: slots.** Today every wire table is keyed by (team, user): one sandbox per member
(D11). An eval sandbox runs as the author but must not replace the author's own connection, so the
wire gets a **slot**: `''` for the member's sandbox, `e-<thread id>` for an eval thread's sandbox,
on `sandbox_commands` and `sandbox_run_leases`. Eval connections live in their own table
`sandbox_eval_connections` (key team, thread; FK to the thread): `sandbox_connections` keeps its
(team, user) key, which the previous release's connect upsert needs (rolling upgrade, rollback).
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

- [x] Migration (generated, 0145): eval tables (`fixtures_key` too), `threads.skill_eval*`,
      `sandbox_eval_connections`, `slot` on commands and leases. No wire key or index changes.
- [x] Migration (custom, 0146): RLS, break-glass read, silent legal hold; slot check
      (`'' or 'e-'||thread_id`, NOT VALID) and slot-matches-thread trigger; eval connections and
      results tied to eval threads; `threads.skill_eval` fixed. Probes and DB tests, and the old
      release's wire SQL in `skill-evals-upgrade.db.test.ts`.
- [x] DB review (review-325a) B1, S1, S2, N1 fixed; N2 gone (no index rebuilds); N3 moot.
- [x] Wire slot plumbing (connect, routing, leases, sweeps): `sandbox-wire-eval.db.test.ts`.
- [x] Provider: eval template / pool / claim / quota (`provider.test.ts`); chart PriorityClass.
- [x] Sandbox agent: `eval.prepare`, `eval.snapshot` (`skill-eval/*.test.ts`).
- [ ] Reaper.
- [ ] Runner, checks, routes, events; DB tests for ac-1..ac-4.
