# KOBE-513: Sandbox session tokens signed with Ed25519; proxies hold public keys only

- **Status:** in review (group `hardening-2`, not pushed)
- **Branch / worktree:** `group-hardening-2` in `../Kobe-g-hardening-2`
- **Depends on:** none (no migration, no protocol change)

## Threat

Session tokens were HS256 with one symmetric key per audience, and each verifier (egress proxy,
MCP proxy, model gateway) held its audience's key. A compromised proxy could therefore mint a
token for any live sandbox (any team, user, sandbox id) and, for `kobe.mcp-proxy`, present it to
the server's internal `/grant` endpoint to pull another user's connector grant.

## Design

- `@kobe/session-token` signs **EdDSA (Ed25519)** with Node's `crypto` (`sign`/`verify`, no new
  dependency; `jose` is not a dependency). Header is exactly
  `{"alg":"EdDSA","typ":"JWT","kid":"<kid>"}`; `none`, HS256, any other algorithm and any other
  field (jku, jwk, x5u, crit) are refused. `kid` = first 16 chars of base64url(SHA-256(SPKI DER)),
  derived on both sides, never configured; it only selects among the verifier's own keys. Signature
  must be 64 bytes in canonical base64url.
- **One key pair per audience** (as today's one key per audience): sandbox-wire, model-gateway,
  mcp-proxy, egress-proxy. Site egress tokens (KOBE-343) use the egress-proxy pair.
- Claims, audiences, TTL (15 min), transport and the sandbox's view are unchanged: the sandbox
  still gets opaque bearer tokens from `/v1/sandbox/session`.
- Env: server `KOBE_SESSION_SIGNING_KEY_<AUD>` (PKCS#8 PEM, all four, must differ) plus optional
  `KOBE_SESSION_VERIFY_KEY_<AUD>` (merged with its own public key, for rotations) which the chart
  takes from the Secret's `<aud>.pub` (review fix: never the ConfigMap, so a ConfigMap editor
  cannot add a key the server accepts at the wire or `/grant`); each verifier
  `KOBE_SESSION_VERIFY_KEY_<AUD>` = a bundle of 1–4 `PUBLIC KEY` or `CERTIFICATE` PEM blocks. A
  `PRIVATE KEY` block in a verify bundle is refused at startup.
- The model gateway keeps `KOBE_SESSION_KEY_MODEL_GATEWAY`: it is the master secret shared with
  the server for the derived run-token, trace-span, server-call and budget-salt keys (KOBE-118,
  234, 274, 120). It no longer signs or verifies session tokens. Renaming it is out of scope.
- Chart: `sandbox-session-keys.yaml` generates per audience `genPrivateKey "ed25519"` and, since
  Helm cannot derive a bare public key, `genSelfSignedCertWithKey` over it (only the key in the
  certificate is used). Secret `<release>-sandbox-session-keys` (keep policy, lookup-stable):
  `<aud>.key`, `<aud>.pub`, `model-gateway`, `approval-hmac`; the old per-audience HMAC entries
  drop out. ConfigMap `<release>-sandbox-session-verify-keys` mirrors the `.pub` entries; proxies
  and the gateway get only `configMapKeyRef` to their audience; the server gets all `.key` and
  bundles from the Secret (`.pub`, optional). `existingSecret` path: `sandbox.sessionKeysSecret` now requires
  `sandbox.sessionVerifyKeysConfigMap` (render fails with a pointer to docs/install.md).

## Rotation (docs/install.md "Session-token keys")

1. Append the new public key to the Secret's `<aud>.pub` (the server's bundle) and the ConfigMap
   (generated keys: copied on the next `helm upgrade`); restart verifiers and server.
2. Swap `<aud>.key` in the Secret; restart the server (new `kid`, old tokens still verify).
3. After 15 min remove the old public key; restart.

## Decisions

- **No dual-algorithm (HS256) window.** One `helm upgrade` rolls server and proxies within about a
  minute, so pod skew is short; the real gap is tokens sandboxes already hold: the sandbox agent
  caches its grant until 2 min before expiry and does not re-trade on a 401
  (`services/sandbox-agent/src/session/exchange.ts`), so HS256 tokens stay in use for up to ~13
  min after the upgrade whatever the verifiers accept. A dual window would need the proxies to
  keep their HMAC keys for one more release, leaving the threat open exactly as long, plus code to
  remove later. Cost of not doing it: one-time refusals (wire reconnects, model/MCP/egress calls)
  for sandboxes live during the upgrade, until their scheduled re-trade. Documented as an upgrade
  note (upgrade with no runs active, or stop sandboxes first).
- Per-audience pairs, not one pair with `aud`: keeps today's separation (a key leak is one
  audience) and lets the server's sandbox-wire and MCP checks stay per audience.
- Public keys in a ConfigMap (public material), not a Secret; private keys only in the server's
  Secret references.
- e2e scripts mint tokens inside the server pod with `loadSandboxConfig(process.env).sessionKeys`
  (no env-name knowledge); gate4 restore builds the verify ConfigMap from the saved Secret.

## Open questions (for Chris or the coordinator)

- The gateway still shares `KOBE_SESSION_KEY_MODEL_GATEWAY` with the server (run-token and
  server-call HMAC keys). A compromised gateway can mint run/server-call tokens only it verifies;
  worth a rename (`KOBE_MODEL_GATEWAY_MASTER_KEY`) in a later chart release?
- Upgrade window confirmed by review; closed on the sandbox side by KOBE-522 (the agent re-trades
  its bootstrap token on a refused wire token, rate-limited). The model-gateway master
  secret is out of scope (KOBE-521).

## Evidence (acceptance criteria → test or command output)

- **ac-1** (server signs EdDSA; verifiers hold only a public key; a proxy cannot mint):
  `packages/session-token/src/index.test.ts` ("a holder of the public key cannot produce a token
  that verifies": HMAC-with-public-key alg confusion, HS256, none; public key not loadable as a
  signing key); `services/server/src/sandbox/session-token.test.ts` ("a verifier holding only the
  public key cannot mint a token for any sandbox": forged payload with HMAC/zero/reused signature,
  own fresh key pair → unknown kid); proxies' config tests refuse a private key;
  `charts/kobe/tests/sandbox.test.ts` (verifiers get only `configMapKeyRef` to their audience, no
  `.key`; the server's bundles come from the Secret, and a key added only to the ConfigMap is not
  accepted by the server; ConfigMap has no private key and its keys do not load as signing keys; a token signed with
  the rendered Secret's key verifies with the rendered ConfigMap key of its audience only).
- **ac-2** (audience/TTL/claims unchanged): server session-token tests (claims contract, TTL,
  audiences); every proxy's existing auth/route tests pass on EdDSA tokens. e2e scripts updated
  (`e2e/run.sh` mint, gate1/gate2 clients, gate4 restore); executor, MCP and egress e2e not run
  here (need a cluster deploy) — to run at deploy.
- **ac-3** (chart generates and distributes; rotation documented): chart tests above +
  existing-Secret path test; docs/install.md "Session-token keys" and upgrade note;
  docs/backup-restore.md table and restore step.
- Commands (2026-10-29): `@kobe/session-token` 12 tests; egress-proxy 105; mcp-proxy 132;
  model-gateway 190 + test:db 20; server 2430 (+3 skipped) + test:db 2381; chart 196 (helm
  3.19.0); `pnpm build`, `typecheck`, `lint`, `format:check`, `license:check` (no new
  dependency), `scripts/check-public-hygiene.sh` all clean.
