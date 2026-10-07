# KOBE-118: 73b: Mint, deliver and verify run-bound gateway tokens

- **Status:** in review
- **Branch / worktree:** `kobe-118-run-bound-gateway-tokens` in `../Kobe-wt118`
- **Depends on:** KOBE-117 (krt1 contract, merged; unchanged here). Adds migrations 0068/0069.

## Plan

Server mints and records at `run.start` delivery, revokes at run end; agent hands the token to that
thread's Pi from memory; gateway verifies and enforces. The published KOBE-117 contract is used as is.

## Decisions

- **TTL: 24 h (`RUN_TOKEN_TTL_SECONDS` = the contract maximum), tunable per wire as
  `tuning.runTokenTtlSeconds`.** Runs have no wall-clock limit (steps and approval waits are
  long), so a short TTL would kill healthy runs. The TTL is only a backstop: the token is revoked at
  run end and the gateway also requires the run to be active, so a longer TTL widens nothing.
- **Key:** `deriveRunTokenKey(KOBE_SESSION_KEY_MODEL_GATEWAY)`. The gateway already holds that key
  and the server already has it (sandbox config), so no new secret or chart wiring. Server without
  the variable mints nothing (legacy path).
- **Record:** table `run_tokens` (team table, models area): PK (team_id, jti), FK to runs, `sandbox_id`,
  `expires_at`, `revoked_at`; RLS in 0069 (canonical policy), probe fixture added. The token text is
  never stored. Several rows per run are possible (re-delivered `run.start` mints a new one).
- **Mint:** in the delivery transaction that leases the run (`sandbox-wire/delivery.ts`), only when the
  agent's hello lists `run_token`; the frame sent carries `run_token`, the stored command row never does.
- **Revoke:** `endRunInTx` (the single place runs end: completion, failure, Stop, budget stop,
  lost-sandbox interrupt) sets `revoked_at` in the same transaction.
- **Gateway order (`run-attribution.ts`):** header present: verify (401 `invalid_run_token`, no fallback);
  team/sandbox must equal the session token's (403 `run_token_mismatch`); `x-kobe-run-id` that
  disagrees 403 `run_id_mismatch`; record check `isRunTokenActive` = not revoked, not expired, same
  run and sandbox, run active and leased to that sandbox (403 `run_token_inactive`; cached
  `max(cacheTtl,1s)` like leases). Run id used for attribution is the token's. No header:
  `KOBE_MODEL_GATEWAY_REQUIRE_RUN_TOKEN=true` (chart `modelGateway.requireRunToken`, default false)
  gives 401 `run_token_required`, else the legacy advisory `x-kobe-run-id`.
- **Per-run budget stop:** a stopped run is ended (`budget_stopped`), which revokes its tokens, so its
  own tools get 403 with the token and, under enforcement, 401 without or with a forged run id; another
  run's token only ever attributes to that other run.
- **Delivery to Pi (memory only):** no new fd (kobe-runas closes fds >= 5) and no file/env/argv. The
  kobe-models extension asks over Pi's RPC channel (`ctx.ui.input("kobe.run_token")`, once per run, at
  Pi's `input` hook); the agent answers from the thread's memory in `Thread.#onUiRequest`, never relays
  that request to the server, answers `cancelled` when there is no token for the active run, and drops
  the token at run end. The provider adds `x-kobe-run-token` (only for the matching run id) per
  request. Agent advertises `run_token` only when model wiring exists.
- Extension registration moved from `kobe-models/index.ts` to `register.ts` so it is testable without Pi.

## Open questions (for Chris or the coordinator)

- **Unverified against real Pi:** `ctx.ui.input` inside an `input` handler in `--mode rpc` (Pi 1.0.x) is
  assumed from Pi's extension UI API; Pi is not installed here, so only the fake Pi and unit tests
  cover it. If Pi rejects it the run simply carries no token (legacy path); add a real-Pi test in
  `kobe-models.real-pi.test.ts` and e2e before turning enforcement on.
- Enforcement also refuses calls with no run at all (e.g. orbit eval sandboxes, whose tokens carry no
  run): keep it off until those are covered or exempted.
- Rollout: server, gateway, agent image, then `requireRunToken: true`.

## Evidence (acceptance criteria to test)

- ac-1 (ended or other run refused): `services/model-gateway/src/gateway.test.ts` "run-bound tokens":
  revoked token 403, other sandbox/team/run id 403, forged/expired/malformed 401;
  `packages/db/src/run-tokens.db.test.ts` (revoked, expired, run ended without revocation, other
  team/sandbox/run); `services/server/src/run-token.db.test.ts` (revoked at run end).
- ac-2 (per-run stop cannot be evaded): gateway test "ac-2" with enforcement on: no token, forged run
  id, own revoked token, another run's token naming the stopped run all fail.
- Delivery: `agent.models.test.ts` "run token delivery" (answered from memory, not forwarded, not in
  model file/argv/env/any file, cancelled without token, not kept for the next run);
  `kobe-models/run-token.test.ts`, `provider.test.ts` (header).
- Config: `config.test.ts`. Probe suite and migrations: `pnpm --filter @kobe/db test:db` green.
