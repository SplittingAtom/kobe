# KOBE-41: Pi model wiring in sandboxes

- **Status:** in review (PR #54; CI green: checks, db, images, sandbox-image; k3d e2e run
  37164920766 green via `workflow_dispatch` — the e2e workflow triggers only for PRs onto `main`)
- **Branch / worktree:** `kobe-41-pi-models` in `../Kobe-wt41` (based on `kobe-40-bifrost`, PR #51)
- **Depends on:** KOBE-40 (Bifrost + model gateway shim, PR #51), KOBE-23 (sandbox agent),
  KOBE-24/25/30/32 (merged)

## Acceptance criteria (coordinator brief, spec D13/D14/D30)

1. **ac-1 Working path.** A user's message is answered by a real model, streamed through Pi in the
   user's gVisor sandbox, via the model gateway and Bifrost.
2. **ac-2 Token rotation.** Pi calls the gateway with the `kobe.model-gateway` session token;
   the token is rotated before expiry without breaking a streaming call.
3. **ac-3 Model per run.** The thread's or agent's model, else the team default from the server.
4. **ac-4 Attribution.** `x-kobe-run-id` per run (KOBE-42).
5. **ac-5 Errors.** Gateway errors become clear run errors in the chat (403 `model_not_enabled`,
   Retry-After waits for 503, …).
6. **ac-6 Tests.** Unit tests; a real-Pi integration test through the real model gateway against
   a fake upstream; e2e: a message gets a streamed answer from a fake model behind Bifrost.
7. **ac-7 Gate 1** measures real first token (hibernated → first `text.delta`).

## Design

```
server ── run.start {config.model: {alias, gateway_model, api}} ──▶ kobe-sandbox-agent
                                                                      │ per Pi process: mkdtemp 0700
                                                                      │   agent/      PI_CODING_AGENT_DIR (Pi writes auth.json here)
                                                                      │   model.json  {gateway_url, model, token, run_id}  0600
                                                                      ▼
                                      pi --mode rpc -e kobe-models -e kobe-policy  (KOBE_MODEL_FILE)
                                                 │ provider "kobe": reads model.json per request
                                                 │ Authorization: Bearer <token>, x-kobe-run-id
                                                 ▼
                                   model-gateway shim ──x-bf-vk──▶ Bifrost ──key──▶ provider
```

### The read-only `PI_CODING_AGENT_DIR` problem (KOBE-36's blocker)

Root cause, verified in Pi 1.0.0 source: `AuthStorage.readLatestData` → `withLockAsync` →
`ensureFileExists()` **writes** `auth.json` (and takes a `proper-lockfile` lock next to it) on
every credential read, before any provider's `resolve` runs; `pi-ai` then throws `Credential store
read failed` (`auth/resolve.js`). So Pi 1.0.0 cannot use any model with a read-only config dir.

Solution: **a private, writable, per-process config dir**, not a shared one. `Thread.spawn`
creates `mkdtemp(<KOBE_PI_RUNTIME_DIR>/pi-XXXXXX)` (0700, default `/tmp/kobe-pi`, on the emptyDir
hibernation wipes) with `agent/` (Pi's `PI_CODING_AGENT_DIR`) and `model.json`, right before the
process starts, and removes it when the process exits (`Thread#onExit`, awaited by
`stopProcess`); the agent sweeps leftovers at start-up (`sweepRuntimeDir`).

**What this does and does not protect (review MEDIUM 1).** Processes of the same uid — a
sibling thread's tool — can write into any of these directories while a Pi runs; the
read-only root-owned dir of KOBE-23 ruled that out structurally, this design cannot. What a
planted file could do, checked against Pi 1.0.0's source under Kobe's launch flags:

| File in `PI_CODING_AGENT_DIR`                                                             | Read?                                                                                                                                                            | Effect if planted                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `settings.json`                                                                           | yes, at start-up (`SettingsManager`)                                                                                                                             | `shellPath`/`shellCommandPrefix`: every bash tool call runs through a chosen shell or prefix; `defaultTools`, `enabledModels`, `retry`, `compaction`, `defaultModel` |
| `models.json`                                                                             | yes, at start-up and on every `refresh()` (each provider re-registration, i.e. a model switch)                                                                   | `providers.kobe.baseUrl` redirects the model calls; `apiKey: "!cmd"` runs a command at auth resolution; `modelOverrides`                                             |
| `SYSTEM.md`, `APPEND_SYSTEM.md`                                                           | yes, unconditionally (`--no-context-files` covers AGENTS.md only)                                                                                                | replaces or extends the system prompt                                                                                                                                |
| `bin/`                                                                                    | yes (`getBinDir`: preferred `fd`/`rg` binaries for find/grep)                                                                                                    | a planted `rg`/`fd` runs for those tools                                                                                                                             |
| `auth.json`                                                                               | yes (credential store)                                                                                                                                           | none: the `kobe` provider never reads Pi's stored credential                                                                                                         |
| `mcp.json`, `extensions/`, `skills/`, `prompts/`, `themes/`, `tools/`, `keybindings.json` | no (`--no-extensions` keeps only `-e` paths; mcp.json needs the builtin mcp extension; `--no-skills/--no-prompt-templates/--no-themes`; `tools/` is a migration) | none                                                                                                                                                                 |
| `model.json` (the agent's)                                                                | by kobe-models, per request                                                                                                                                      | another token/run id/model/gateway origin for that Pi's calls                                                                                                        |

None of this gives a same-uid process anything it cannot already do directly (threads share
`/workspace` and the uid; D13), but it would let thread A's tool act _through_ thread B's Pi
and its run (B's policy context, B's prompt). Mitigation built here, the **tripwire**
(`Thread.verifyRuntime`): once Pi is ready and again right before every prompt, the runtime
dir may hold only what the agent wrote (`agent/`, `model.json`, the writer's temp files) and
`agent/` only what Pi itself writes at boot (verified by listing a fresh dir after boot and after
a prompt: `auth.json`, its `auth.json.lock`, `models-store.json`), and `model.json` must be byte
for byte what the agent last wrote. Anything else: that Pi is stopped, its directory removed,
and the run fails `runtime_tampered` ("Another process in your workspace changed Pi's private
runtime directory…"). The pre-prompt check also covers `models.json` re-reads on a model switch.
Residual: a same-uid process can still plant and remove a file between a check and Pi's read
(a TOCTOU window of milliseconds), or `ptrace` the Pi outright. **Follow-up (not built here):
run Pi and its tools under a second uid**, which closes this class for good (the KOBE-23
"sandbox privilege separation" umbrella).

Other properties: the lockdown flags stay; nothing persists across processes or threads; the
only secret in the dir is the session token (0600), which the sandbox holds by design (D30);
the same uid could read the bootstrap token file before KOBE-41 too (KOBE-23 open risk).

### Token rotation (ac-2)

`ModelTokenKeeper` (`models/token-keeper.ts`) wraps `SessionClient` (KOBE-25's bootstrap trade,
which re-trades lazily inside a 2 min margin of expiry): it trades at start-up, in parallel with
the other cold-start work, and schedules the next trade at `expires_at − margin + 1 s` (retry 5 s
on failure, old token kept). Every new token goes to `ThreadManager` → each live thread's
`ModelFile.update({token})` (temp file + rename: Pi never reads a torn file). The kobe-models
provider reads the file **per request**; a request authenticates once at the gateway when it
starts, so a rotation during a stream changes nothing for that stream and the next request
carries the new token. A 401 mid-rotation re-reads the file once and retries.

### Model per run (ac-3)

`runs/models.ts` `resolveRunModel(tx, team, requestedAlias)`: inside the run-start transaction
(RLS) — the requested alias (the agent resolver's `config.model.alias`, KOBE-47) if the team
enabled it, else the run **fails `agent_model_not_enabled`** (nothing is woken for it); only a run with no
requested alias uses the team default — user decision (2026-10-04), recorded below; with the catalog's `gateway_model` and the API style for the
provider kind (`apiForKind`: openai/ollama/openai_compatible → `openai-completions`, anthropic →
`anthropic-messages`, gemini → `google-generative-ai`). `run.start.config.model` carries
`{alias, gateway_model, api}` and `run.started.model` the alias. No model → no `config.model`
→ the agent fails the run `model_not_configured` before any Pi work (server message: "No model
is enabled for your team yet…"). Threads have no model of their own yet (KOBE-32 added none).

The model is **not** a Pi launch argument: a Pi started for `get_entries` on wake is reused for
the run (one Pi start on the cold-start path), and a model change between runs restarts nothing.
The agent writes the model and run id into `model.json` before the prompt; kobe-models selects
it on Pi's `input` hook (runs before Pi validates the selected model; the faux-model pattern in
Kobe's tests), re-registering the `kobe` provider when the model changed.

### Attribution (ac-4)

Pi 1.0.0 lets a native provider return per-request `headers` from `auth.apiKey.resolve()`, and
kobe-models sets `x-kobe-run-id: <run id>` on every request while a run is active (the file's
`run_id`, cleared at run end). The shim verifies the run is leased to the sandbox and records it
(`UsageSink.runId`); it is not forwarded to Bifrost. Verified end to end in
`kobe-models.real-pi.test.ts` and in e2e (shim log `"runId"`).

### Errors (ac-5)

kobe-models wraps Pi's adapters (`provider.ts`): the HTTP status and Retry-After come from the
adapter's `onResponse`, the gateway code from the error body. 429/502/503/504 and the shim's
transient codes wait Retry-After (≤ 30 s) or back off (1, 2, 4 … s) within 60 s, only before
anything was streamed; 401 re-reads the token once; everything else fails at once. The final
error message is `kobe.model_error:<code>: <detail>` (`@kobe/protocol` `kobeModelErrorMessage`
/ `parseKobeModelError`), worded so Pi's own auto-retry (`isRetryableAssistantError`) does not
retry a terminal failure. The server (`translate.ts`) remembers the last assistant message's
stop reason; at `agent_settled` a run whose last message ended in error fails with that code
(`ingest.ts` → `endRunInTx` failed, server message from `runs/failure-codes.ts`), the queue
advances, and the chat shows "The run failed: …" (KOBE-32 renders `run.failed`).

| Gateway answer                                       | Run error                 |
| ---------------------------------------------------- | ------------------------- |
| 403 `model_not_enabled` / Bifrost `provider_blocked` | `model_not_enabled`       |
| 401 after a fresh token / `session_revoked`          | `model_session_revoked`   |
| 429 after the waits                                  | `model_throttled`         |
| 502/503/504 after the waits                          | `model_unavailable`       |
| no `config.model`                                    | `model_not_configured`    |
| pinned alias not enabled for the team (server side)  | `agent_model_not_enabled` |
| anything else (incl. non-kobe error text)            | `model_error`             |

Found on the way: a rejected `run.start` (`delivery.ts`) stored the sandbox's own error text in
`run.failed` (the lifecycle rule says sandbox text is never shown); it now keeps the sandbox's
code with a server message (`pi_rejected`, `pi_unavailable` added to the table).

## Decisions

- **kobe-models lives in `@kobe/sandbox-agent` `src/kobe-models/`** like kobe-policy, compiled
  to `dist/kobe-models/*.js`, shipped root-owned/0444 at `/opt/kobe/pi-extensions/kobe-models`,
  checked at agent start like kobe-policy (`checkExtensionFile`). It imports node builtins,
  `@earendil-works/pi-ai` (Pi's own copy, aliased by Pi's extension loader; typed by a local
  `pi-ai.d.ts`, no workspace dependency added) and its own files (test-enforced).
- Loaded only when the pod has `KOBE_MODEL_GATEWAY_URL` and a bootstrap session (Kobe's pods);
  otherwise Pi runs as before KOBE-41 (no provider; prompts refused `pi_rejected`).
- `reasoning: false` for `openai-completions` models (vLLM/Ollama/chat completions reject unknown
  reasoning parameters), true for Anthropic and Gemini; `contextWindow` 128k, `maxTokens` 16k.
  Catalog capability flags are a KOBE-44 follow-up.
- `model_rate_limited` was renamed `model_throttled` before anything used it: Pi's auto-retry
  pattern matches `rate.?limit`, and the code travels inside Pi's error text.
- `@kobe/model-gateway` gained a `./testing` export (`startLocalGateway`: the real shim + fake
  upstream + token minting) for other packages' integration tests; it is a devDependency of the
  sandbox agent.
- Image: `/opt/kobe/pi-agent` removed; `test-image.sh` checks kobe-models ships correctly and
  streams a model answer through a local fake gateway.

## Contract changes (`packages/protocol`, flagged for the coordinator)

1. `piThreadConfigSchema.model` gains optional `gateway_model` (`<gateway provider>/<model>`)
   and `api` (`PI_MODEL_APIS`). Still no URLs and no credentials: the agent builds the base URL
   from its environment. The old `{alias}` form stays valid (= no model for the sandbox).
2. `SANDBOX_ERROR_CODES` gains `model_not_configured` and `runtime_tampered` (`command.result`
   errors on `run.start`).
3. `pi-events.ts`: `KOBE_MODEL_ERROR_PREFIX`, `MODEL_RUN_ERROR_CODES`, `kobeModelErrorMessage`,
   `parseKobeModelError` (the sandbox ↔ server error convention above).

## For downstream tickets

- **KOBE-42 (budgets):** `x-kobe-run-id` is **advisory, a reporting hint only** (review
  MEDIUM 2): it comes from the sandbox's model file, which any same-uid process in the sandbox
  can rewrite (its own or a sibling thread's run id) or Pi could omit, and the shim accepts calls
  without it. Per-run hard stops must not rely on it: enforce budgets and rate limits at the
  sandbox (token), user (virtual key) and team levels, where the gateway's identity is
  cryptographic, and use `runId` only to attribute. Every model call from Pi carries the header
  while a run is active (`CallContext.runId`); calls between runs (none today: Pi only calls
  models inside a run) would carry none. A `CallGate` refusal with `retryAfterSeconds` is waited out by kobe-models within
  its 60 s budget, then becomes `model_unavailable`/`model_throttled`; a 402 or a code of its own
  becomes `model_error` — add the code to `MODEL_RUN_ERROR_CODES` + `errors.ts` + `failure-codes.ts`
  for a budget-specific message. `budget_stopped` (`run.stop after_step`) is unchanged.
- **KOBE-43 (run_usage):** Pi's `message_end`/`agent_end` usage over the wire is unchanged; the
  gateway's `UsageSink` now has `runId` for reconciliation. Pi's `usage.cost` is 0 for the `kobe`
  provider (no prices in the catalog): cost comes from Bifrost/KOBE-43, not from Pi.
- **KOBE-47 (agent resolution):** put the agent's alias in `AgentResolution.config.model.alias`;
  `resolveRunModel` turns it into the gateway model if the team enabled it, else the run fails
  `agent_model_not_enabled` naming the alias (user decision; no fallback).
- **KOBE-44 (admin UI):** nothing new; consider catalog capability flags (reasoning, context).

## Self-review round (code-reviewer agent: 0 CRITICAL/HIGH, 4 MEDIUM, 4 LOW) — resolution

1. MEDIUM the gateway's code (network text such as `rate_limited`) was embedded in the final
   error message, which Pi's auto-retry pattern matches: the message is now built from fixed
   parts only (`gave up after N attempts`); the code goes to stderr per attempt. Test: "writes an
   error message the server parses and Pi's auto-retry leaves alone" (`rate_limited`,
   `overloaded_error`).
2. MEDIUM an adapter throwing synchronously would leave the stream open (a hung run): the pump
   is guarded and ends the stream `model_error`. Test: "ends the stream with model_error when
   the adapter itself throws".
3. MEDIUM a failed model-file write left the in-memory content ahead of the disk, so an identical
   later update was skipped: `ModelFile` tracks what the disk holds and rewrites after a failure.
   Test: "rewrites after a failed write even for an identical update".
4. MEDIUM transport failures (no HTTP answer: the shim restarting) and Anthropic's 529 were not
   retried: both are transient now. LOW: the runtime dir is removed when `PiProcess` creation
   itself throws; the model file path is cached at module scope (a reload registers again);
   `Object.hasOwn` for failure codes; `defaultSleep` returns at once on an aborted signal.
5. LOW (kept, open question 1): a pinned alias the team did not enable falls back to the default.
   A restart (`restartPlanInTx`) now reuses the alias in `run.started.model` (`startedModelAlias`),
   so a re-sent start cannot switch models (unless that alias was disabled meanwhile).

## Coordinator security review of PR #54 (0 CRITICAL/HIGH, 2 MEDIUM, 5 LOW) — resolution

1. MEDIUM 1 cross-thread planting: tripwire, Pi 1.0.0 file audit and corrected rationale above
   (the earlier "milliseconds" justification was wrong: the dir lives for the process's life);
   second uid recorded as the follow-up. Tests: `runtime-dir.test.ts`; `agent.models.test.ts`
   "stops a Pi whose runtime directory a sibling planted into during its start" (a poller writes
   `agent/settings.json` between mkdtemp and Pi's start), "…whose model file was rewritten before
   the next prompt"; the real-Pi suite proves Pi's own boot files pass the check.
2. MEDIUM 2 advisory run id: KOBE-42 note above.
3. LOW 3 rotation racing spawn: after the file is attached the thread takes `tokens.current()`
   again (test "a token rotated while Pi was being spawned reaches the file"); model-file write
   failures go to the agent's warn log (`ThreadHooks.warning`), and a failed write before a
   prompt fails the run `pi_unavailable`.
4. LOW 4 `ModelFile` writes a random temp name with `flag: "wx"` (test: a symlink at the file
   path is never followed; no temp file left).
5. LOW 6 mid-stream errors and aborts carry fixed text (tests in `provider.test.ts`).
6. LOW 7 start-up sweep of `KOBE_PI_RUNTIME_DIR` (`sweepRuntimeDir`, test) and the removal is
   awaited by `stopProcess`.
7. LOW 5 as above (open question 1 stays open).

## Cold start on k3d (D14)

Gate 1's criterion (p95 ≤ 8 s) passes with ≈ 2.4 s to spare; D14's p50 ≤ 3 s is missed (4.7 s),
as KOBE-25 predicted: Pi ready alone is ≈ 3.3–3.5 s on CI (pod start + agent + session trade +
Pi/jiti start), and the model path adds ≈ 1.2 s (kobe-models load, the first `get_entries`,
the shim's first principal load, Bifrost → upstream). The model is selected without a Pi
restart, so nothing in KOBE-41 adds a second Pi start. Real-cluster numbers are still due
(KOBE-25's Longhorn note).

## e2e rounds (k3d, `workflow_dispatch` on the branch)

1. The story's `chat()` helper shadowed KOBE-40's `chat` (the later revoked-token check broke):
   renamed `chat_run`.
2. The attribution check read one shim pod's log; the shim has 2 replicas: logs by label.
3. Gate 1 ran with the fake upstream gone: run.sh deletes `kobe-e2e-llm` on exit (`--wait=false`)
   and gate1 found the Service in a terminating namespace. `ensure_fake_llm` now waits the
   namespace out and checks the pod is Running; failed chats print the shim's refusals.

## User decisions

- **2026-10-04 (via the coordinator):** an agent whose pinned model alias is not enabled for the
  team must FAIL the run with a clear error rather than fall back; only runs with no pinned or
  requested alias use the team default. Built as `agent_model_not_enabled` (server message names
  the alias; test "an agent pinned to a model the team did not enable fails the run naming the
  model"). A recovery re-send of such a run (`restartPlanInTx`) yields no plan and fails
  `start_lost`.

## Open questions (for Chris or the coordinator)

1. Thread-level model choice (D30 "teams choose a subset and a default" says nothing about
   per-thread models): not built; `run.start.config.model` is where it would go.

## Evidence (acceptance criteria → test or command output)

| AC / item               | Evidence                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 working path       | `kobe-models.real-pi.test.ts` "streams a model's answer" (real Pi 1.0.0 → real shim → fake upstream: `fake-openai: hello-pi`, VK at the upstream, no token); e2e "the run completed with the fake model's streamed answer (Pi → shim → Bifrost → upstream)" (`e2e/run.sh` KOBE-41 section, real sandbox woken by the message); `images/sandbox/test-image.sh` kobe-models check |
| ac-2 token rotation     | `token-keeper.test.ts` (trade at start, again inside the margin, retry on failure, no duplicate announcements); `agent.models.test.ts` "rewrites the file with a rotated token without touching Pi"; real Pi: "uses a rotated token on the next request: an expired one is refused, a fresh one works" (no `pi.exited`); `provider.test.ts` per-request read                    |
| ac-3 model per run      | `runs-model.db.test.ts` (requested alias if enabled, else default, else none; RLS; `run.start.config.model` and `run.started.model`); real Pi: "switches models between runs without restarting Pi: Anthropic native and Gemini too"; `agent.models.test.ts` "keeps the Pi started for a pi.command and gives it the run's model later (no restart)"                            |
| ac-4 attribution        | real Pi test: shim `calls[].runId` = the run for every call; `provider.test.ts` header set/cleared; e2e "the shim attributed the model call to the run (x-kobe-run-id from Pi)"                                                                                                                                                                                                 |
| ac-5 errors             | `errors.test.ts`; `provider.test.ts` (Retry-After waits, budget, 401 re-read, 403 fast fail, abort); real Pi: 403 → `model_not_enabled`, 503 + Retry-After waited out; server `translate.test.ts`, wire ingest "fails the run with the server's message", `runs-model.db.test.ts` (queue advances after a failed model call; `model_not_configured` text); e2e no-model story   |
| ac-6 tests              | unit: protocol 398, sandbox-agent 304 (+2 skipped), server 656, model-gateway 34; db: db 441, server 518, model-gateway 4; real-Pi suites run locally and in CI (`checks` installs the pinned Pi)                                                                                                                                                                               |
| ac-7 Gate 1             | `e2e/gate1.sh` cold step, k3d run 37164920766: **hibernated → first token p50 4703 ms, p95 5590 ms** (20 trials, min 4266, max 5686; `hibernated-to-first-token`, pass p95 ≤ 8000); chat-real: all 10 users got a streamed model answer; the interrupt retry's woken sandbox got one too. e2e KOBE-41 story: first token 3607–3926 ms from POST on a suspended sandbox          |
| no secrets in sandboxes | `pi-launch.test.ts` env allow-list; `agent.models.test.ts` (`KOBE_` vars in Pi's env: `KOBE_MODEL_FILE`, `KOBE_POLICY_FD` only); `state-file.test.ts` (file path removed from the env); e2e "no session token (JWT) reached the upstream"                                                                                                                                       |
| local checks            | `pnpm build typecheck format:check license:check` ok; `pnpm lint` ok except `@kobe/chart` (Helm 4, pre-existing); `pnpm test --concurrency=2` 18/18; `test:db` db/server/model-gateway ok; `db:check` no changes; `scripts/check-public-hygiene.sh` ok                                                                                                                          |
