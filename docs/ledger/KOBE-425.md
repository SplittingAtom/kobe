# KOBE-425: the restore docs omit the model keys and session keys Secrets; a restored site can't open its provider keys

- **Status:** in progress (group G5, branch `group-5-gates`)
- **Branch / worktree:** `group-5-gates` in `../Kobe-g5`
- **Depends on:** found by KOBE-233's restore shard (CI run 39145480035)

## Plan

docs/backup-restore.md lists every Secret the chart generates (derived from the chart), with its
values key and what is lost without it; a chart test keeps the table complete; gate4-restore
saves and restores all of them; the server names, at start, every kind of sealed value whose key
it does not hold.

## Decisions

- **The list is the chart's generated Secrets** (`helm template`, default and CNPG): auth,
  envelope key, model keys, egress headers, sandbox session keys, MCP proxy internal key, CNPG app
  credentials. Each row names the values key that reuses it; the MCP proxy key seals nothing but
  is listed so one procedure covers every Secret.
- **Guard:** `charts/kobe/tests/backup-secrets.test.ts` renders the chart and fails when a
  generated Secret has no row, and when a row's values key does not replace the generated Secret.
- **Start-up check, not a refusal to start:** `services/server/src/startup/sealed-keys.ts` reads
  the key id every sealed value names (`<version>.<kid>.…`; SecretBox and Envelope both derive it
  from the key, it is not secret) for provider keys, virtual keys, connector grants, the web search
  key and egress header values (team tables through `scanTeams`), and logs one error per family
  sealed with a key the server does not hold, naming the Secret to put back. Nothing is decrypted;
  the server still starts (one stale provider key must not take the site down). New getter
  `keyIds` on SecretBox and Envelope.
- **TOTP secrets (auth secret)** are not in the check: Better Auth's own ciphertext carries no key
  id the server could compare without decrypting.

## Product failures found

None.

## Evidence (acceptance criteria → test or command output)

- Round 1 evidence of the failure: `model_gateway_state 4:4:…:provider_key_unreadable`, the
  server's "model gateway sync incomplete … provider_key_unreadable", the next turn `run.failed
model_error` (e2e (restore), run 39145480035).
- `charts/kobe/tests/backup-secrets.test.ts` passes; with the egress headers row removed it fails
  naming `kobe-egress-headers` (checked locally).
- `services/server/src/sealed-keys.db.test.ts` (dev Postgres): quiet with the right keys; with
  other keys names provider and virtual keys with their Secret, no secret in the log; a previous
  key during a rotation counts as held.
- SecretBox/Envelope `keyIds` unit tests.
- e2e (restore): every Secret saved and restored; the gateway sync check: pending the next round.
