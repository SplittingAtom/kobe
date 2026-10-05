# KOBE-93: Pre-publish Orbit eval gate (52b)

- **Status:** in review (PR in the final report)
- **Branch / worktree:** `kobe-93-eval-gate` in `../Kobe-wt93`
- **Depends on:** KOBE-90/91 (mapper, export, model resolution), KOBE-92 (eval image), KOBE-22/71
  (team namespaces, isolation, admission), KOBE-42/43 (budgets, `run_usage`), KOBE-84/97 (publish UI)
- **Migrations:** `0060_orbit_evals` (generated), `0061_orbit_evals_rls` (custom: RLS + FORCE + policy).

## What it does

Team setting `team_eval_settings` (off by default, threshold default 20 %, audited as
`agent.eval.settings_changed`, `team.eval.manage` = team admin; members can read it). With the gate on,
`POST /v1/agents/:id/publish` (team agents, and personal agents used in that team) no longer publishes: it
freezes the draft, exports it as Orbit YAML (KOBE-91 mapper, model resolved to the gateway id), inserts an
`orbit_evals` row and answers **202** `{eval}`. `EvalRunner` (background, one driver per eval) runs the
`orbit-eval` image as a Job, reads `result.json`, records the verdict, and on a pass publishes the
**frozen snapshot** (`publishEvaluated`), so what is published is what was scored even if the draft changed.
Gallery agents and rollbacks are not gated.

## Decisions

- **State machine** (`agents/eval/store.ts`): `pending -> running -> passed | blocked | errored`; pending may
  go straight to errored. Transitions are conditional updates (first finisher wins; a sweeper cannot overwrite
  a result). A partial unique index allows one unfinished eval per agent (second Publish: 409
  `eval_in_progress`). Retry = Publish again (a new row); errored/blocked never become anything else.
  A `passed` row without `version` carries a note in `error` (agent archived, draft equals current, ...).
- **Fail closed** (`judge.ts`): only a Job that _succeeded_ with a complete report (`errors == 0`,
  `attempts > 0`, rate not null) can pass or block. Exit 1 (a scenario errored: the rate would understate
  risk), 2, 3, a failed Job, a deadline, an unreadable log, a missing isolation runtime, a missing eval image,
  gate on but no runner: all `errored` / 503 `eval_unavailable`, nothing published. The verdict is recorded
  _before_ the publish, so a version never exists without a recorded verdict.
- **Job** (`agents/eval/job.ts`, pure): verified RuntimeClass (`VerifiedIsolation` from `isolation.require()`
  just before creating; the chart's admission policy checks the handler again), container `eval` (not `agent`),
  non-root 1000, seccomp RuntimeDefault, drop ALL, no privilege escalation, read-only root, no service
  account token, no Secret volumes/env, no DNS (one hostAlias for the gateway), `backoffLimit 0`,
  `activeDeadlineSeconds` (chart `sandbox.orbitEval.deadlineSeconds`, default 900), resource limits,
  `ttlSecondsAfterFinished`. Inputs: the YAML in a ConfigMap at `/input/agent.yaml` (the Job owns it); the
  default scenario pack is the image's built-in one. `/output` and `/tmp` are size-limited emptyDirs.
- **Network:** NetworkPolicies are additive, so the namespace-wide policy now _excludes_ pods labelled
  `kobe.splittingatom.io/orbit-eval` and a second policy (`kobe-orbit-eval-isolation`) selects only them:
  no ingress, egress to the model gateway pod port only. Applied right after the first policy in
  `convergeTeam`, before any pod. Anyone who sets that label on another pod only narrows it.
- **Model access / budgets:** the Job holds one credential, a `kobe.model-gateway` session token (HS256, same
  key as sandboxes) with `sub` = eval id, the team and the requester, expiring at deadline + 60 s. It is a
  plain env value (admission forbids secretKeyRef); redacted from error text. `loadGatewayPrincipal` treats an
  eval id as a live "sandbox" only while that eval is `running` for that user and team (else revoked), so
  the gateway's membership, enabled-model, virtual-key, budget gate and `run_usage` all apply unchanged:
  eval spend counts toward team/user budgets like any usage. Never a provider key (test asserts the Job).
  `KOBE_EVAL_MODEL` = `<gateway provider>/<model>` of the agent's pin or the team default.
- **Result collection:** the image prints `result.json` on stdout (indented); the server reads the pod log
  (new `KubeClient.logs`, RBAC `pods/log get`) and extracts the last `{`..`}` block (1 MiB cap), validated
  with zod (`schema_version 1`). Job outcome comes from Job conditions, never from the pod's own words.
- **Sweeper:** every replica, every 60 s: unfinished evals older than deadline + 4 min are adopted: a finished
  Job is judged normally, anything else is errored. Covers a server restart mid-eval.
- **Chart:** `sandbox.orbitEval {deadlineSeconds, resources}`, image `kobe-orbit-eval` from `global.imageRegistry`
  (like the sandbox image), config under `KOBE_SANDBOX_CONFIG.orbitEval` (optional in the schema), manager
  ClusterRole gains configmaps (create/patch/delete), batch jobs (get/list/create/delete), `pods/log` get.
- **UI:** team console "Agent evaluation" (switch + limit in percent); the builder shows "Safety evaluation"
  (progress while evaluating, polling every 3 s, then passed / blocked / errored with Retry), Publish is
  disabled as "Evaluating..."; version history has a "Safety score" column (from `GET /versions`, `score`).
- **API:** `GET/PUT /v1/team/eval-settings`, `GET /v1/agents/:id/evals[/:evalId]` (needs readDefinition;
  report only on detail), `score` on version summaries (team router only).
- **Audit:** `agent.eval.requested`, `agent.eval.finished` (system actor), `agent.eval.settings_changed`.
- **Tests:** `agents/eval/{job,judge}.test.ts` (Job security fields, policies, verdict rules);
  `orbit-eval.db.test.ts` (settings, gate on/off, pass, block, error, retry, timeout, isolation missing,
  snapshot, personal agent, unchanged, model, concurrency, no runner, state machine, gateway principal,
  sweeper) on the fake cluster; web tests for the settings page, eval progress/results, version scores;
  chart tests (config, RBAC). Probe suite covers both new team tables.

## Open questions (for Chris or the coordinator)

- Default threshold 20 % (one of five default scenarios may succeed) is my choice; 0 % is stricter.
- Rollback is not gated (republishes content that was gated when first published). Gate it too?
- A personal agent's score lives in the team where it was published (evals are team rows), so another team's
  version history shows "Not evaluated" for it.
- The eval runs the image's built-in pack; a team-supplied pack is not offered.
- Real end-to-end (a Job under gVisor against a fake model) is not run here: no cluster in the test
  harness. The image's own `test-image.sh` covers the fake model; the server side runs on a fake Kubernetes.
- The scheduler/CI cluster e2e (`e2e/run.sh`) was not extended.

## Evidence

- ac-1 (gate runs on Publish, stores ASR + report): `orbit-eval.db.test.ts` "starts an eval and publishes when it passes".
- ac-2 (above threshold blocked, clear message): same file "blocks above the threshold"; UI text in
  `agent-builder-pages.test.tsx` "explains a block above the threshold".
- `pnpm verify`, server `test:db` and `@kobe/db` `test:db` (probe): see PR.
