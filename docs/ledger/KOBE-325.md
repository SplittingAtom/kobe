# KOBE-325: B6: Eval runner: ephemeral sandboxes with and without the skill

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## Handoff for KOBE-326 (the judge) — read first

- **Where it plugs in:** the `EvalJudge` type in `services/server/src/skills/evals/checks.ts`
  (`(input: {rubric, prompt, answer, outputs}) => Promise<EvalJudgeResult>`, result `passed` /
  `rejected` with a reason / `failed` / `unparseable`, each with `costUsd`). Pass it as
  `judge` in `SkillEvalRunnerOptions` (`runner.ts`); `index.ts` builds the runner without one
  today. `evalChecks` calls it last, only when every other check passed (the 324 estimate counts
  on that), and maps the result to `judge_rejected` / `judge_failed` / `judge_unparseable`.
- **Stubbed:** with no judge a `judge` check fails `judge_failed` (cost 0). `outputs` holds the
  matched files' entries (path, size, type) only: **no file contents reach the server yet**. 326
  needs a sandbox-side read of the matched files under the contract (`O_NOFOLLOW`, `fstat` a
  regular file of the walked size, at most 256 KiB, `judgeOutputText` for binary); the natural
  place is a new `eval.read` command beside `eval.prepare` / `eval.snapshot` (new command kind: a
  generated migration on `sandbox_commands_kind`, frames in `protocol/sandbox-wire/eval-frames.ts`,
  the agent's `skill-eval/` hooks, the delivery guard in `sandbox-wire/delivery.ts`).
- **Already decided:** the judge model is chosen at start (`judgeModelFor` in `start.ts`: the
  Site's `judgeAlias` if the team enabled it, else the team default; stored as
  `skill_eval_runs.judge_model`, on the scorecard). Use the protocol's `skillEvalJudgeMessages`
  (fixed system text + the rubric only, data between nonce lines, a fresh 128-bit nonce per call
  the sandbox never sees) and `parseSkillEvalJudgeVerdict`; temperature 0 and the structured-output
  schema where the model allows; no tools, no SKILL.md, no history. The judge is a server-side
  model call, so it goes through the KOBE-234 server calls (`createServerCalls`, deps.ts), never
  the sandbox. A retry re-judges (`judgeCostUsd` totals both attempts). Registry re-runs (Phase C)
  use the Site judge and run without the reviewer's personal keys.
- **Must:** the judge call carries its **own timeout**: the reaper ends only executions whose
  heartbeat stopped, so a beating runner stuck in a judge call is never cut short by anyone
  else. The runner keeps beating while it judges (state `collecting`).
- **Later (327):** `run_usage` kinds `eval` / `eval_judge`, estimates, team eval caps; today eval
  runs bill as kind `run` and the judge's spend is only on the scorecard.

## PR #316 CI fix (2026-10-19): scoped quotas

- The API server refused `kobe-skill-eval-quota` ("unsupported scope applied to resource"):
  a PriorityClass-scoped quota may count only `pods`, `cpu`, `memory` and their requests/limits.
  Probed on k3s 1.34.6: `ephemeral-storage` and its requests/limits are refused too (the earlier
  check used a smaller quota). Both scoped quotas now hold only `POD_SCOPED_QUOTA_KEYS`
  (`sandbox/eval-quota.ts`); ephemeral storage, storage, PVCs and counts stay in the unscoped team
  quota, which still adds the eval share (eval pods' ephemeral storage is bounded by their count).
- Real-cluster check (scratch namespace and a scratch PriorityClass, both deleted): the exact
  manifests the code generates from gate1's sandbox config were accepted; a member pod and an
  eval pod were admitted; used counts: team quota 2 pods, eval quota 1, member quota 1
  (requests.cpu 500m and limits.memory 4Gi each).
- The reconcile no longer stops on a scoped quota: each failure is logged, the rest of the
  namespace converges, the namespace counts as failed (`TeamQuotaDegradedError`), and
  `ensureTeam` still returns it, so members start under the team quota.

## Handoff (read first)

- **Branch:** `group-skills-b` in `../Kobe-skB`. **325 is complete** (step 1 DB layer reviewed and
  approved; step 2 built, see Progress). Ready for review.
- **Migrations (renumbered at the group rebase):** generated 0143 (was 0145, now with the
  branch's other schema: eval tables incl. `fixtures_key`, `bundle_size`;
  `sandbox_eval_connections`; `slot` on commands/leases; eval command kinds) and 0146 (custom, unchanged number: RLS,
  break-glass, silent hold, slot check + trigger, eval thread run fixed, eval lease sandbox fixed).
  `db:rebase` onto main (its own 0141/0142) merged the branch's generated migrations into 0143.
- **Where things are:** `services/server/src/skills/evals/` (start, store, runner, reaper,
  checks, execution, events, views, storage, fixture-routes), `routes/skill-evals.ts`,
  `routes/eval-thread-guard.ts`, `runs/eval-tests.ts` (`withSkillEvals`), `sandbox/eval-*.ts`,
  `sandbox-wire/slots.ts`, `retention/skill-evals.ts`, `offboarding/skill-evals.ts`; agent
  `services/sandbox-agent/src/skill-eval/`; protocol `sandbox-wire/eval-frames.ts`; chart
  PriorityClass `kobe-skill-eval`, `sandbox.skillEval.maxConcurrentPerTeam`, claims `list` verb.
- **Not here (later tickets):** the judge (326: a `judge` check fails `judge_failed` until then;
  seam `EvalJudge`), estimates and `eval`/`eval_judge` usage kinds and caps (327: runs bill as
  kind `run` today), the Workbench panel (328), OpenAPI paths for the eval routes.
- **Runner review (review-325-runner.md) fixed:** M1 members' scoped quota
  `kobe-team-member-quota` (PriorityClass NotIn matches pods without a class: checked on k3s
  1.34.6 with a scratch namespace, removed), M2 heartbeat + shutdown requeue + reaper by heartbeat,
  M3 retention skips held starters, M4 ≤ 3 open evals per member / 20 per team, L1–L9, L11, L12
  (coordinator: eval runs ignore the starter's remembered approvals; tested), the minor items.
  Re-review R1–R4 fixed too: takeovers counted (`skill_eval_results.takeovers`; the third
  records an error attempt), the reaper claims before it stops anything, departed starters' open
  evals are cancelled, streams re-check session, account and role every 30 s.
  **Not done:** L10 (UID precondition on claim deletes; optional, thread ids are never reused);
  the `/proc/self/fd` snapshot branch is untested on the Mac (CI's Linux runs it): verify one real
  eval with `outputs` on gate1 under gVisor.
- **Known limits:** `max_turns` is enforced by polling `run_usage`: the run is stopped once the
  turn past the limit is recorded (it fails `over_limit`), not before it starts. A shutdown or a
  dead replica requeues an execution without using its attempt (an execution that kills its
  replica each time would loop until its eval is cancelled).
- **Coordinator decisions (2026-10-18):** leases and claim checks by claim UID; per-team cap
  atomic across replicas (advisory lock); eval sandboxes have their own quota (never a member's);
  no personal connector or MCP credentials in evals (team connectors under team policy only), so
  **Registry re-runs (Phase C) run in the Registry team without the reviewer's personal keys**;
  the snapshot never follows a symlinked root or any link; offboarding deletes live eval
  sandboxes and cancels eval runs; cleanup on every path incl. a crash reaper.
- **Rollout:** no replica records its build, so nothing refuses eval starts during a rollout;
  docs/install.md says to start evals only after every Kobe deployment rolled (only evals can
  break meanwhile).
- **Startup jobs:** the runner and reaper need the sandbox provider, so they stay in `index.ts`
  beside the Orbit eval sweep, also after the merge with main's G5 (`startup/jobs.ts` keeps
  provider-backed jobs in index.ts).
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

**Kubernetes.** Per team namespace, reconciled with the rest: SandboxTemplate and SandboxWarmPool
`kobe-skill-eval` (the member pod spec, `/workspace` an `emptyDir`, sync off, PriorityClass
`kobe-skill-eval`: value -100, never preempts; replicas 0, a claim needs a pool ref). Quota: the
team quota is the members' `teamQuota` plus `maxConcurrentPerTeam` eval pods, and
`kobe-skill-eval-quota` (scoped to the PriorityClass) caps evals at that share, so members always
keep theirs; more evals wait in the DB queue. A claim `e-<thread id>` carries team, author, thread
and eval run, and `lifecycle {shutdownTime: deadline + 5 min, shutdownPolicy: Delete}`. Create
goes through `isolation.require()` and the read-back check (handler gVisor/Kata). The namespace
NetworkPolicy applies (server wire, model gateway, MCP proxy, egress proxy); no Secret; session
tokens carry `eval_thread`; workspace sync refuses them; egress via the proxy under team policy.

**Cleanup on every path.** (1) The runner deletes the claim in a `finally` (done, error, timeout,
cancel, turn limit). (2) The reaper (one replica, advisory lock) records past-deadline executions
as errors (a dead replica's), stops their runs, and deletes eval claims (by label) whose execution
no longer runs. (3) The claim's `shutdownTime` is the cluster-side backstop. (4) Offboarding
cancels the member's eval runs and deletes their eval sandboxes.

**Isolation of the run.** `withSkillEvals`: with the skill, `onlySkill` = the eval's stored runtime
bundle; without, no skills at all; never the owner's personal connector grants (the MCP grant
endpoint also refuses eval sandboxes). Would-ask calls are denied (`mode_auto_not_allowlisted`,
or `eval_run_no_prompt` when the floor clamps auto); memory and project tools are denied
(`eval_run_isolated`); no member workspace reconcile or memory index in `run.start`. Eval threads
stay out of lists and search and refuse every member write (`skill_eval_thread`, 409).

**Fixtures and outputs.** The cases' fixtures are a zip in the eval's tree (never in the runtime
zip); `eval.prepare` lists the case's files (path, sha256, size), the agent fetches each from
`GET /v1/sandbox/skill-evals/fixtures?path=` (only its own case's, while starting) and writes them
without following links. `eval.snapshot` walks the literal roots with `lstat` (a linked root or
parent is recorded, never entered). Checks run on the server (324 contract; regex under a VM
timeout).

**Events.** `NOTIFY kobe_skill_eval '<team>:<eval>'` on every change; `GET
/v1/skill-evals/{id}/events` (SSE) re-reads on each hint and every 5 s, emits
`skill.eval.progress` per execution done and `skill.eval.completed`, then ends.

## Progress

- [x] Migration (generated, 0145, now part of 0143): eval tables (`fixtures_key` too), `threads.skill_eval*`,
      `sandbox_eval_connections`, `slot` on commands and leases. No wire key or index changes.
- [x] Migration (custom, 0146): RLS, break-glass read, silent legal hold; slot check
      (`'' or 'e-'||thread_id`, NOT VALID) and slot-matches-thread trigger; eval connections and
      results tied to eval threads; `threads.skill_eval` fixed. Probes and DB tests, and the old
      release's wire SQL in `skill-evals-upgrade.db.test.ts`.
- [x] DB review (review-325a) B1, S1, S2, N1 fixed; N2 gone (no index rebuilds); N3 moot.
- [x] Wire slot plumbing (connect, routing, leases, sweeps): `sandbox-wire-eval.db.test.ts`.
- [x] Provider: eval template / pool / claim / quota (`provider.test.ts`); chart PriorityClass.
- [x] Sandbox agent: `eval.prepare`, `eval.snapshot` (`skill-eval/*.test.ts`).
- [x] Reaper (advisory lock), offboarding (cancel + delete eval sandboxes), retention (finished
      runs by start, RETURNING keys; departed starters).
- [x] Runner, checks, routes, events: `skill-eval-runner.db.test.ts` (ac-1 sandboxes per case
      and mode, baseline without skills; ac-2 cap of one, one retry; ac-3 stored, scored,
      streamed, denials recorded; ac-4 sandboxes deleted, eval threads hidden and write-guarded),
      `offboarding.db.test.ts`, `skills/evals/*.test.ts`.
