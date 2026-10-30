# KOBE-520: Approvals signed asymmetrically: the MCP proxy verifies with a public key, never holds the signing key

- **Status:** done without a signing change (premise not met)
- **Branch / worktree:** `group-hardening-4` in `../Kobe-g-hardening-4`
- **Depends on:** KOBE-513 (session tokens Ed25519), KOBE-37 (approval HMAC)

## Plan

Check the premise from the KOBE-513 review ("the MCP proxy verifies approvals with the same key")
before changing the signature scheme.

## Decisions

- The premise is false: approvals are signed and verified by the server only. The proxy's
  `tools/call` path re-checks policy with the server (`services/mcp-proxy/src/mcp.ts`), which
  verifies the approval signature itself (`services/server/src/approvals/keys.ts`) and returns the
  decision. The chart gives `approval-hmac` to the server alone (`_sandbox.tpl`); the proxy's
  config schema has no approval key at all. Symmetric HMAC is therefore the right primitive here:
  signer and verifier are the same process, and an asymmetric pair would add rotation plumbing
  without removing any party from the trust set.
- Kept: the format, the server-decides-every-call rule, the `approval-hmac` Secret key.
- Added instead: explicit tests pinning the property (ac-1) and a corrected comment in
  `services/server/src/config.ts`, which still claimed the proxy verified with the key.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1 (MCP proxy holds no key that can produce a valid approval signature):
  `charts/kobe/tests/mcp-proxy.test.ts` "holds no key that can produce an approval signature
  (KOBE-520)" (no `KOBE_APPROVAL_KEY` env, no `approval-hmac` ref on the proxy; the server keeps
  it) and `services/mcp-proxy/src/config.test.ts` "has no approval key" (a `KOBE_APPROVAL_KEY` in
  the proxy's environment is ignored). Existing: `charts/kobe/tests/sandbox.test.ts` "gives the
  approval key to the server only".
- ac-2 (approval flow e2e green; rotation documented): the `mcp` e2e shard on the group PR;
  rotation of `approval-hmac` is documented in `services/server/src/approvals/keys.ts` (a
  changed key invalidates allowed-but-unused approvals, which live 10 minutes).
