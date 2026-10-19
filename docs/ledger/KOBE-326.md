# KOBE-326: B7: Eval judge and run model

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-b`, one PR for Phase B)
- **Branch / worktree:** `group-skills-b` in `../Kobe-skB`
- **Depends on:** KOBE-325 (handoff at the top of `KOBE-325.md`), contract KOBE-324

## Handoff (for the reviewer and KOBE-327)

- **Migrations:** 0147 (generated: `sandbox_commands_kind` + `eval.read`,
  `team_skill_settings.eval_judge_alias` with a length CHECK) and 0148 (custom: `run_usage_kind`
  and `run_usage_kind_shape` widened to `eval` / `eval_judge`, NOT VALID like 0100). Upgrade test
  `packages/db/src/eval-judge-upgrade.db.test.ts`. Renumbering at `db:rebase` is the coordinator's.
- **327 overlap:** the `eval` and `eval_judge` usage kinds land here (one CHECK change). The gateway
  writes `eval_judge` now; `eval` is allowed (as a sandbox call: sandbox id required) but nothing
  writes it yet: eval runs still bill as `run`, and `runner.ts` / `views` read `kind = 'run'`. 327
  switches eval sandboxes' calls to `eval` and does estimates and team eval caps.
- **Where things are:** `services/server/src/skills/evals/judge.ts` (the service),
  `judge-outputs.ts` (eval.read reply → judge outputs), `runner.ts` `#judgeFor`, `start.ts`
  `judgeModelFor`, `skills/settings.ts` (team judge), `routes/team-skill-review.ts`; agent
  `services/sandbox-agent/src/skill-eval/read.ts`; protocol `server-call.ts` (token purposes,
  limits, response formats), `sandbox-wire/eval-frames.ts` (`eval.read`), `skill-evals/scorecard.ts`
  (`requestedModel`); gateway `server-call.ts`. Shared DB test bench:
  `services/server/src/testing/skill-eval-bench.ts` (the 325 runner test now uses it too).

## Decisions

- **Judge choice (ac-1):** Site `judge_alias` if the team enables it → the team's choice
  (`team_skill_settings.eval_judge_alias`, set by a Team admin via
  `PUT /v1/team/skill-review/settings {evalJudgeAlias}` with permission `team.skills.review`; must
  be enabled, else 422 `model_not_enabled`; audited `skill.eval_judge.changed`; a model disabled
  since reads as null) → team default → the run model. Chosen at start (stored). At judge time
  the service resolves the alias again with `resolveRunModel(alias)` (no fallback): not enabled →
  no call, `judge_failed` with the reason in the check's `detail`. The gateway also refuses a model
  the team hasn't enabled.
- **Server call (ac-2):** a new token purpose `eval_judge` (`SERVER_CALL_TOKEN_PURPOSES`); the
  epilogue purposes (`SERVER_CALL_PURPOSES`, `ServerCallPurpose`) stay title / followups, so
  `run.completed.epilogue`, the SSE window and the append guard are unchanged. Limits: 512 / 2048
  output tokens, 60 s timeout, 400 000-char messages, 2 MiB body, temperature 0, skip at 100 %.
  The gateway accepts `response_format` only as exactly the purpose's
  (`SERVER_CALL_RESPONSE_FORMATS.eval_judge`, deep-equal) and checks the per-purpose message cap.
  The member is the eval's starter and the run is the execution's completed run (leased to them),
  so `serverCallRunMatches` holds and budgets are the member's lines as for the run.
- **Structured output:** sent only for provider kind `openai` (no catalog capability flag exists;
  an unsupported field would fail every judgement on that provider). Elsewhere the contract's
  instructions and strict parser alone. Open question below.
- **Cost:** the client returns text only, so the judge's cost is read back from `run_usage`
  (`kind = 'eval_judge'` for the attempt's run), waiting up to 10 s for the gateway's batched row
  after a reply. A retry is a new run, so per-run sums never mix attempts. A call that fails after
  reaching the provider may leave a row the scorecard doesn't count (timeout); 327's
  reconciliation should read the ledger.
- **eval.read:** new command (not a new capability: `skill_eval` and `eval.read` ship in the same
  release as 325). Request = paths + walked sizes (≤ 100 files); the agent opens with
  `O_NOFOLLOW | O_NONBLOCK`, lstat parents (Linux: `/proc/self/fd` must name the path), `fstat`
  regular file of exactly the walked size, ≤ 256 KiB each, ≤ 1 MiB total (later files `skipped`).
  The server re-checks the reply (same files in order, bytes ≤ cap and ≤ size), then
  `judgeOutputText`. Refused / skipped / binary / beyond 100 files → path and size only.
- **Run model (ac-3):** `executionFromAttempts` takes the stored `runModel`; an execution carries
  optional `requestedModel` when the suite's alias wasn't enabled (format 1, optional field). The
  scorecard schema now requires every execution's `model = runModel.used` and `requestedModel`
  exactly when `fellBack`. Reaper takeovers carry the run model too.
- **`EvalJudge` seam** unchanged in shape; `failed` / `unparseable` results may carry `detail`.
  The runner builds a per-attempt judge (read outputs, then call) only with a judge service and a
  stored judge model; `index.ts` passes `deps.skillEvalJudge` (made from the same server-call
  client as titles; absent when server calls aren't configured).
- **Web:** usage "By kind" labels for `eval` / `eval_judge`.

## Open questions (for the reviewer / coordinator)

- Structured output for `ollama` / `openai_compatible` (gate1's Ollama Cloud): add a catalog flag
  later, or keep prompt + strict parser only? Today only kind `openai` gets `response_format`.
- During a rolling upgrade an old gateway refuses `eval_judge` tokens (`judge_failed`); covered by
  install.md's "start evals only after every deployment rolled".

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skill-eval-judge.db.test.ts`: "judges on the Site's judge…"
  (`judge_model {judge, site}`), "falls back to the team's judge, then the default; never a model
  the team has not enabled" (Site judge not enabled → default; PUT refuses a non-enabled alias 422;
  team choice → `{judge-2, team}`, audited; disabled before judging → **zero gateway calls**,
  `judge_failed` with detail; settings read null).
- **ac-2** same file, first test: one call, token `purpose: eval_judge`, the execution's team,
  member, thread and run, `temperature: 0`, the verdict `response_format`, no tools; one
  `run_usage` row `eval_judge`, no sandbox, cost = execution and scorecard `judgeCostUsd`.
  Gateway: `services/model-gateway/src/server-call.test.ts` "the eval judge (KOBE-326 ac-2)" and
  `server-call-budget.db.test.ts` (a real ledger row of kind `eval_judge` through
  `kobe_reserve_budget`); `packages/db/src/usage.db.test.ts` (kind shapes); client
  `models/gateway-client.test.ts`.
- **ac-3** judge DB test "reports a missing run model on the case…" (`model: fast`,
  `requestedModel: huge`, card `fellBack: true`, `judgeModel {fast, team}`; rejection then retry:
  two calls on two runs, `judgeCostUsd` = both ledger rows); protocol `scorecard.test.ts`
  (fallback reported on every case, refused otherwise); `execution.test.ts`.
- **Judge input never reaches the sandbox:** first judge DB test: the only `eval.read` frame names
  `[{path, size}]`; no frame any eval sandbox received contains the nonce, the rubric or
  `BEGIN DATA`; the frame schema refuses extra keys (`eval-frames.test.ts`).
- **eval.read refusals:** `services/sandbox-agent/src/skill-eval/read.test.ts` (final symlink,
  symlinked parent, FIFO without blocking, directory, size changed, missing, reserved path,
  per-file cap 256 KiB truncated, 1 MiB total then `skipped`); end to end in
  `agent.skill-eval.test.ts`.
- **Timeouts / unparseable:** last judge DB test (gateway refusal → `failed` with code; a hanging
  client cut by the judge's own timeout; prose reply → `unparseable`).
- Commands (2026-10-18): `pnpm typecheck`, `pnpm lint`, license:check green; unit tests protocol
  912, server 2034, sandbox-agent 847, model-gateway 176, db 576; DB: `@kobe/db` 64 files / 1453
  tests; server eval / wire / usage / titles / follow-ups / enablements / review / offboarding /
  materialization files green; gateway `server-call-budget.db.test.ts` green.
