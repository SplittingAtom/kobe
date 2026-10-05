# KOBE-117: Contract: run-bound model-gateway tokens

- **Status:** in review
- **Branch / worktree:** `kobe-117-run-token-contract` in `../Kobe-wt117`
- **Depends on:** none. Unblocks KOBE-118 (mint, deliver, enforce).

## Plan

Contract only: protocol field, hello capability, token format with sign/verify, tests, docs.

## Decisions

- `run.start.run_token = { token, expires_at }`, optional, additive. Capability `run_token`
  (`CAPABILITY_RUN_TOKEN`): the server sends it only to agents that list it.
- Header `x-kobe-run-token`; session bearer unchanged.
- Format `krt1.<b64url JSON claims>.<b64url HMAC-SHA256 over "krt1.<payload>">`. Claims: iss
  `kobe-server`, aud `kobe.model-gateway`, run_id, team_id, sandbox_id, iat, exp, jti.
- Key: HKDF-SHA256 from the server master secret, info `kobe/run-token/v1` (domain separated).
  Algorithm fixed by the `krt1` prefix, never read from the token. Gateway holds the derived key.
- Sign/verify live in `@kobe/protocol/node` (server side only); verify covers MAC, shape and time
  only. Revocation at run end and sandbox/team match against the session token are the gateway's
  stateful checks (KOBE-118).
- Coexistence: header present must verify (401, no fallback); absent keeps legacy advisory
  `x-kobe-run-id` until an enforcement setting (KOBE-118) is on. `x-kobe-run-id` that disagrees
  with the token is 403.
- Rollout order: server, gateway, agents/images, then enforcement.

## Open questions

- TTL for the token (suggest run max duration plus slack, KOBE-118 decides).
- Whether the agent hot-swaps the token into the provider per run (KOBE-71/123 per-process files
  must not hold it; memory only).

## Evidence

- ac-1: additive optional field plus optional capability, own PR, no migrations.
- ac-2: `src/run-token.test.ts` decodes run.start with and without `run_token` and hello with and
  without the capability; old frames still decode.
