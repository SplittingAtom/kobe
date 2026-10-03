# KOBE-41: Pi model wiring in sandboxes

- **Status:** in progress
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
process starts, and removes it when the process exits (`Thread#onExit`). Why it does not weaken
the sandbox:

- The lockdown flags stay (`--no-extensions --no-approve --no-context-files --no-skills
--no-prompt-templates --no-themes`): nothing is discovered from the dir; `settings.json`,
  `models.json`, `mcp.json` are read at Pi start-up, milliseconds after the dir was created
  empty, before any model-run code exists for that process.
- Nothing persists: the dir dies with the process, so a tool that writes into it (same uid, as
  it can already ptrace the process) affects at most the Pi it runs under, never another thread
  or a later Pi — the cross-thread persistent prompt injection KOBE-23 locked out stays locked
  out. `/opt/kobe/pi-agent` is gone from the image (`test-image.sh` checks it is absent).
- A model-written `auth.json` is ignored: the `kobe` provider's `resolve` never reads Pi's stored
  credential; it reads the agent's model file.
- The only secret in the dir is the session token (0600), which the sandbox holds by design
  (D30); the same uid could read the bootstrap token file before KOBE-41 too (KOBE-23 open risk,
  "second uid" follow-up).

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
enabled it, else the team default; with the catalog's `gateway_model` and the API style for the
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

| Gateway answer                                       | Run error               |
| ---------------------------------------------------- | ----------------------- |
| 403 `model_not_enabled` / Bifrost `provider_blocked` | `model_not_enabled`     |
| 401 after a fresh token / `session_revoked`          | `model_session_revoked` |
| 429 after the waits                                  | `model_throttled`       |
| 502/503/504 after the waits                          | `model_unavailable`     |
| no `config.model`                                    | `model_not_configured`  |
| anything else (incl. non-kobe error text)            | `model_error`           |

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
2. `SANDBOX_ERROR_CODES` gains `model_not_configured` (a `command.result` error on `run.start`).
3. `pi-events.ts`: `KOBE_MODEL_ERROR_PREFIX`, `MODEL_RUN_ERROR_CODES`, `kobeModelErrorMessage`,
   `parseKobeModelError` (the sandbox ↔ server error convention above).

## For downstream tickets

- **KOBE-42 (budgets):** every model call from Pi carries `x-kobe-run-id` while a run is active
  (`CallContext.runId`); calls between runs (none today: Pi only calls models inside a run) would
  carry none. A `CallGate` refusal with `retryAfterSeconds` is waited out by kobe-models within
  its 60 s budget, then becomes `model_unavailable`/`model_throttled`; a 402 or a code of its own
  becomes `model_error` — add the code to `MODEL_RUN_ERROR_CODES` + `errors.ts` + `failure-codes.ts`
  for a budget-specific message. `budget_stopped` (`run.stop after_step`) is unchanged.
- **KOBE-43 (run_usage):** Pi's `message_end`/`agent_end` usage over the wire is unchanged; the
  gateway's `UsageSink` now has `runId` for reconciliation. Pi's `usage.cost` is 0 for the `kobe`
  provider (no prices in the catalog): cost comes from Bifrost/KOBE-43, not from Pi.
- **KOBE-47 (agent resolution):** put the agent's alias in `AgentResolution.config.model.alias`;
  `resolveRunModel` turns it into the gateway model if the team enabled it, else the default
  (silently — decide whether an agent pinned to a disabled model should fail instead).
- **KOBE-44 (admin UI):** nothing new; consider catalog capability flags (reasoning, context).

## Open questions (for Chris or the coordinator)

1. An agent whose pinned alias is not enabled for the team falls back to the team default
   (recorded in `run.started.model`). Failing the run instead is a one-line change.
2. Thread-level model choice (D30 "teams choose a subset and a default" says nothing about
   per-thread models): not built; `run.start.config.model` is where it would go.

## Evidence (acceptance criteria → test or command output)

(filled in below once CI ran)
