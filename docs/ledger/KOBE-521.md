# KOBE-521: Model gateway: replace the shared master secret for run-token and server-call keys

- **Status:** in review (group `hardening-3`, not pushed)
- **Branch / worktree:** `group-hardening-3` in `../Kobe-g-hardening-3`
- **Depends on:** KOBE-513 (Ed25519 session-token machinery). No migration.

## Assessment (before)

The gateway and the server shared `KOBE_SESSION_KEY_MODEL_GATEWAY` (Secret entry `model-gateway`).
Four values were derived from it:

| Derived value                            | Who signs / uses                                              | What it authorises                                                                          |
| ---------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `deriveRunTokenKey` (HMAC `krt1`)        | server signs at `run.start`, gateway verifies                 | attributing model calls to a run (budget, usage, per-run stop)                              |
| `deriveServerCallTokenKey` (HMAC `ksc1`) | server signs per title/follow-up/judge call, gateway verifies | a model call billed to any member's virtual key and budget, for any team, without a sandbox |
| `deriveTraceSpanKey` (`k_trace`)         | both remap sandbox span ids (KOBE-274)                        | nothing (pseudonymisation)                                                                  |
| budget reservation salt (KOBE-120)       | gateway only                                                  | nothing (hashes team/member keys in `install_budget_reservations`)                          |

Before: a compromised gateway could mint run tokens and server-call tokens. Neither is accepted by
the server (both flow server → gateway only; there is no gateway → server credential, so the
brief's "gateway → server credential the server can revoke" has nothing to replace), but a
leaked master secret let anyone who can reach the gateway (any sandbox) present forged
server-call tokens: model calls on any member's virtual key and budget, with no sandbox.
After: the gateway holds only the `model-gateway` public key(s) and `KOBE_TRACE_SPAN_KEY`; it can
verify run, server-call and session tokens but mint none of them, and nothing derived from its
remaining secrets is a credential anywhere.

## Design

- Run tokens and server-call tokens are compact JWS, **EdDSA (Ed25519)**, signed by the server
  with the existing `model-gateway` pair (`KOBE_SESSION_SIGNING_KEY_MODEL_GATEWAY`); the gateway
  verifies with `KOBE_SESSION_VERIFY_KEY_MODEL_GATEWAY` (ConfigMap, already mounted). Code in
  `packages/session-token/src/gateway-tokens.ts`, reusing `jws.ts` (now takes the expected `typ`).
- Token kinds are told apart by the signed header `typ`: session `JWT`, run `krt2`
  (`RUN_TOKEN_TYP`), server-call `ksc2` (`SERVER_CALL_TOKEN_TYP`). Each verifier requires exactly
  its `typ` and strict claims; re-labelling a `typ` breaks the signature.
- Claims, TTLs, skew rules, headers and the gateway's stateful checks (run record, replay, member,
  run match, budget) are unchanged. Failure reason `bad_mac` became `bad_signature`.
- `KOBE_TRACE_SPAN_KEY` (Secret entry `trace-span`, new random value) replaces the master secret
  for `k_trace` (server: optional, unset = no span relay; gateway: required) and the gateway's
  budget salt. Secret entry `model-gateway` is gone.
- The gateway refuses to start if `KOBE_SESSION_KEY_MODEL_GATEWAY` or any
  `KOBE_SESSION_SIGNING_KEY_*` is set (a stale values file must not silently keep minting
  material on the gateway).
- `@kobe/protocol/node` no longer exports `derive/sign/verifyRunToken` or `…ServerCallToken`
  (HMAC); contract constants `RUN_TOKEN_PREFIX`, `*_KDF_INFO`, `RUN_TOKEN_KEY_BYTES`,
  `RUN_TOKEN_MASTER_MIN_BYTES` removed, `TRACE_SPAN_SECRET_MIN_BYTES` added. Not additive: leaving
  the HMAC path exported would invite reuse of the shared secret; nothing outside this repo uses it.
- `SERVER_CALL_TOKEN_MAX_CHARS` 1024 → 1280: the JWS header and 64-byte signature add ~105
  chars, and a contract-valid claims set (256-char model, 128-char `jti`) must fit (it already
  overflowed 1024 under HMAC with a 128-char `jti`). `RUN_TOKEN_MAX_CHARS` stays 1024 (max ~650).

## Decisions

- **Reuse the `model-gateway` pair, not a new one.** Separate pairs would only help if one kind's
  key could leak without the other's; both live in the same server process and Secret. The `typ`
  separation gives the cross-type guarantee, and rotation stays one procedure. Cost: rotating the
  pair rotates all three kinds, and run tokens live up to 24 h, so step 3 of a rotation waits for
  runs started before it to end (docs/install.md).
- **No HMAC compatibility window** (as KOBE-513): accepting `krt1`/`ksc1` would keep the master
  secret on the gateway. Runs active during the upgrade lose model calls until they end;
  documented (upgrade with no runs active).
- **Trace-span secret stays shared**: server and gateway must map the same sandbox span ids; it is
  a pseudonymisation key that authorises nothing. Budget salt derived from it (gateway-only, must
  agree across replicas); changing it orphans live holds until their TTL (documented).
- e2e scripts needed no change: they never mint run/server-call tokens (the server does, from its
  env); gate4 restore copies the whole Secret (now with `trace-span`) and builds the ConfigMap from
  `.pub` entries as before.

## Rotation

`model-gateway` pair: the KOBE-513 three steps (docs/install.md "Session-token keys"), with step 3
waiting until runs started before step 2 have ended. `trace-span`: replace and restart server and
gateway together while no runs are active (only span linkage across the change is lost).

## Open questions (for Chris or the coordinator)

- The gateway still connects to Postgres as the app role and can write `run_tokens` records and
  usage rows; a compromised gateway can therefore still misattribute spend inside the database.
  Out of scope here (no credential is minted), worth a narrower DB role later?
- Opus security review and the model-gateway / executor e2e shards still to run (need CI/k3d).

## Evidence (acceptance criteria → test or command output)

- **ac-1** (gateway holds no minting secret):
  `services/model-gateway/src/config.test.ts` "KOBE-521 ac-1: the gateway holds no secret that can
  mint a credential" (refuses the master secret and any signing key; loaded config holds public
  keys only; every secret string it holds, used as the old HMAC master, mints nothing it accepts;
  a token from any key but the server's is refused); `charts/kobe/tests/sandbox.test.ts` "KOBE-521:
  the gateway gets no secret that mints a credential, only the trace-span secret" and "run and
  server-call tokens signed with the Secret's key verify with the gateway's ConfigMap key only";
  `charts/kobe/tests/models.test.ts` "the shim holds only its public key, the trace-span secret and
  the virtual-key secret".
- Protocol/crypto: `packages/session-token/src/gateway-tokens.test.ts` (round trip with the public
  key only, wrong key, tampering, HMAC-era `krt1`/`ksc1` refused, HS256/none with the public key
  refused, rotation by `kid`, cross-type rejection both ways, size cap for the longest claims).
- Server signing path: `services/server/src/sandbox-wire/run-token.test.ts`,
  `services/server/src/models/gateway-client.test.ts` ("signs with the model-gateway Ed25519
  private key only", "mints an EdDSA token the public key verifies and another key does not"),
  `run-token.db.test.ts`, `thread-title.db.test.ts`, `thread-followups.db.test.ts`.
- Gateway verify path: `gateway.test.ts` (forged key, HMAC-era `krt1`, a session token as run
  token → 401 `invalid_run_token`), `server-call.test.ts` (HMAC-era `ksc1`, wrong key, session
  and run tokens → 401 `invalid_server_call_token`), `model-gateway.db.test.ts`,
  `server-call-budget.db.test.ts`.
- **ac-2**: rotation documented (docs/install.md "Session-token keys", upgrade note;
  docs/backup-restore.md table). model-gateway e2e shard: not run here (needs k3d/CI).
- Commands: see the final report (`pnpm verify` with `KOBE_TEST_DATABASE_URL`).
