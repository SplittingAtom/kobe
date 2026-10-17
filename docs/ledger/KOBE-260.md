# KOBE-260: Thinking controls: per-model reasoning on/off and level in Site admin, per-chat level

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** done on branch, not pushed (group G2)
- **Branch / worktree:** `group-2-quality` in `../Kobe-g2`
- **Depends on:** KOBE-259 (catalog `reasoning`, output limits), KOBE-219 (server calls' low effort)
- **Migrations:** `0125_thinking_controls` (generated), `0126_thinking_level_checks` (custom)
- **Design:** [docs/design/thinking-controls.md](../design/thinking-controls.md) (levels, settings,
  the mapping per control, enforcement, limits)

## What it does

1. **Protocol** (`packages/protocol/src/thinking.ts`): levels `off < low < medium < high`;
   controls `none | reasoning_effort | anthropic_adaptive | anthropic_effort | anthropic_budget |
gemini_budget`, the ones each provider kind takes, and the rules (`thinkingPolicyProblem`,
   `narrowThinkingPolicy`, `teamThinkingProblem`, `effectiveThinkingLevel`,
   `selectableThinkingLevels`). `run.started.thinking_level` (optional).
2. **DB**: `model_catalog.thinking_control/allowed/default/max` (checks: control on a reasoning
   model only, levels exactly when allowed, default <= max, a no-off control always allowed);
   `team_models.thinking_max`; `threads.thinking_level` (the conversation's choice);
   `runs.thinking_level` (effective, fixed at start). The threads/runs checks are SQL-only and
   NOT VALID (0126; both tables are large and locked by the column add, every old row is NULL).
   `GatewayPrincipal.thinking` (per enabled alias: site policy + team max), `runThinkingLevelOf`.
   Audit: `models.catalog.changed.thinking`, `models.team.changed.thinkingMax`.
3. **Server**: the catalog API takes `thinking` (the whole policy; 400 `thinking_invalid` with a
   message when it does not fit the provider kind or the reasoning flag); `PUT /v1/team/models/:alias`
   takes `thinking_max` (refused above the site's); team models show `thinking`, `thinking_max`,
   `thinking_in_team {default, levels}`; threads take and show `thinking_level` (create, PATCH,
   copied on fork). At run start (`lifecycle.ts`) the level is clamped (`runThinkingLevel`), put in
   `run.start.config.thinking_level` and `run.started`, and written to `runs.thinking_level`; a
   recovery restart reuses the recorded level, clamped again. Per-run usage has `thinking_level`.
4. **Gateway** (`services/model-gateway/src/thinking.ts`): for every sandbox call to a model with
   a control, level = the run's recorded level (cached per run) or the model's default, clamped
   to the site/team settings in force; written in the control's form by appending JSON members
   (Bifrost/Go take the last key in any case), Gemini by rebuilding `generationConfig`. Another
   API for a controlled model: 400 `thinking_route_refused`. Span attribute `kobe.thinking_level`.
   Server calls untouched (still `reasoning_effort: low` and their caps).
5. **Fake LLM**: `think?` answers with `reasoning_content` unless `reasoning_effort: "none"`;
   `SeenRequest.thinking` records the thinking fields that arrived.
6. **Web**: Site → Models: a Thinking fieldset per reasoning model (control filtered by provider
   kind, allow, default, maximum; the table shows "Thinking low, up to medium"); Team → Models: a
   Thinking column (site maximum, lower levels, off for the team; disabled until enabled); chat:
   a thinking `<select>` beside the model picker, only when the model offers levels (new
   conversations send it on create; a level the team lowered shows as what runs get); the answer
   footer shows `thinking <level>`. Console primitives for the admin pages, the chat's own
   `.modelPicker` style for the chat (no new CSS).

## Decisions

- **Four levels.** Pi's `minimal`/`xhigh`/`max` are not offered: providers disagree on them.
- **"Thinking allowed" false = every run off** (only for controls that can turn it off). With
  `none` Kobe sends nothing and records no level, so "off" always means the provider was told.
- **Team narrowing is one ceiling** (`team_models.thinking_max`), validated on write and clamped
  again on read, so a later site change never widens a team.
- **The gateway decides, not the token**: the run token gets no new claim (strict schema, rollout
  order); the gateway reads `runs.thinking_level` by the attributed run id. A call naming no run
  gets the model's default. Several aliases of one gateway model: the strictest wins.
- **Append, don't parse** (except Gemini): same rule as `withStreamUsage`; `reasoning: null` goes
  first so Bifrost never sees `reasoning.effort` beside `reasoning_effort`. No passthrough header,
  so Pi's `think`/`enable_thinking`/`chat_template_kwargs` are dropped by Bifrost (checked in the
  Bifrost v2.2.5 source: unknown fields pass only with `x-bf-passthrough-extra-params`).
- **Anthropic** (current API): `anthropic_adaptive` = `{type: adaptive}` + `output_config.effort`,
  off = `disabled`; `anthropic_effort` for models that reject `disabled` (lowest `low`);
  `anthropic_budget` for older models (budget below `max_tokens`, < 1,024 = off).
- **Not offered**: vLLM/SGLang `chat_template_kwargs` (needs passthrough of every unknown field).
- **Pi**: `run.start.config.thinking_level` reaches Pi as `--thinking` (already wired); for
  `openai-completions` Pi sends no reasoning fields (`reasoning: false`), the gateway adds them.

## Open questions (for Chris or the coordinator)

- gate1: set glm-5.3 (Ollama Cloud) to reasoning + `reasoning_effort` on Site → Models after
  deploy, then run `e2e/browser` `thinking.spec.ts`. Ollama's `reasoning_effort: "none"` →
  `think: false` mapping is verified against the fake only.
- `anthropic_*` replace the caller's whole `output_config` (Pi sends none today).
- Contract changes (protocol `thinking.ts`, `run.started.thinking_level`, thread/team-model/usage
  fields) ride in this branch, not a separate PR.

## Evidence (acceptance criteria → test or command output)

- **ac-1** (site settings persisted, validated): `packages/db/src/models.db.test.ts` "thinking
  settings" (defaults, shapes, refusals 23514); `services/server/src/models.db.test.ts` "site admins
  set a model's thinking control…" (API, provider-kind fit, reasoning flag, audit);
  `models/thinking.test.ts` (db/protocol lists agree, catalog checks); web
  `models-pages.test.tsx` (two KOBE-260 site cases).
- **ac-2** (per-chat level, server clamp): `services/server/src/runs-model.db.test.ts` "a
  conversation picks a thinking level…" (PATCH, run.start, run.started and runs row: default,
  above-max clamped, off, team max low/off, site off, model without control, bad levels 400);
  gateway `thinking.test.ts` + `model-gateway.db.test.ts` (the clamp on every call, real store);
  protocol `thinking.test.ts`; web `model-picker.test.tsx` (4 KOBE-260 cases).
- **ac-3** (off → no reasoning): `services/sandbox-agent/src/thinking.real-pi.test.ts` (real Pi
  1.0.0 → real gateway → fake provider: off gives text only and `reasoning_effort: none` upstream;
  high is clamped to medium on the wire); gateway `thinking.test.ts` "with thinking off…";
  `fake-llm.test.ts`. Browser spec `e2e/browser/tests/thinking.spec.ts` for gate1 (later).
- **ac-4** (team only narrows): protocol `thinking.test.ts` "team narrowing";
  `services/server/src/models.db.test.ts` "team admins can only narrow…"; web
  `models-pages.test.tsx` team case; gateway db test (team off applies at once).
- Checks (2026-10-17): format, lint, typecheck green; unit tests green in every package (under
  turbo's parallel load a few web timing tests and sandbox-agent's `identities.test.ts` "slow
  reclaim" failed; each package alone: web 173 files / 1751 tests, sandbox-agent 97 files green);
  `test:db`: db 51 files / 1242 tests (probes included), model-gateway 6 / 20, server 118 files /
  1624 tests (one search case failed on the first run: search hits lacked `thinking_level`;
  fixed, `threads.db.test.ts` and neighbours rerun green);
  `license:check`, public hygiene and site wording ok. No new dependencies.
