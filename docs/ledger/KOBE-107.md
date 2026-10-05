# KOBE-107: Envelope encryption for connector credentials (61a)

- **Status:** in review
- **Branch / worktree:** `kobe-107-envelope-encryption` in `../Kobe-wt107`
- **Depends on:** none. Feeds KOBE-108 (storage) and the MCP connectors work (KOBE-61).

## Plan

Pure library plus chart wiring; no migrations, no routes, nothing stored yet.

## Decisions

- **Generalised, not parallel.** `packages/db/src/envelope/` reuses KOBE-39/40's `deriveKey`
  (HKDF-SHA256 from a chart secret, own purposes `envelope.kek` / `envelope.kid`), the 32-char
  minimum, the `kid` idea (derived from the key, not secret), the fixed-message error style and the
  current-first-then-previous keyring. `SecretBox` stays for single-layer values; the envelope adds
  per-record data keys.
- **Algorithm:** AES-256-GCM (Node crypto, no new dependency) for both layers. A random 256-bit data
  key per `seal` encrypts the data; the KEK wraps the data key. Fresh 96-bit random nonces; a data
  key is used once, so nonce reuse across records is not a concern.
- **Binding:** AAD = length-prefixed (version, team id, record kind, record id) on the data layer;
  the wrap layer adds the KEK id. Moving a ciphertext to another team/kind/record fails; relabelling
  the key id fails. Context fields validated (kind `[a-z][a-z0-9_.-]*`, ids visible ASCII <= 128).
- **Format:** `e1.<kid>.<wrapNonce>.<wrappedDek>.<wrapTag>.<nonce>.<ct>.<tag>` (base64url, one text
  column in KOBE-108). `Envelope.keyIdOf(sealed)` reads the kid for a rotation sweep column.
- **Rotation (designed, not run):** `KOBE_ENVELOPE_KEY_PREVIOUS` keeps old ciphertexts readable;
  `rewrap()` re-wraps only the data key to the current KEK (data ciphertext unchanged);
  `isCurrent()` finds stale rows. A sweep job comes later.
- **Zeroize:** data keys and the UTF-8 plaintext copy are `fill(0)`ed in `finally`; `open` returns a
  Buffer for the caller to zero (`openString` zeroes its own); `destroy()` zeroes the KEKs. JS
  strings (the env secret, a string plaintext) cannot be zeroed: documented limit.
- **No leaks:** errors have fixed messages (no input, key or context); the keyring is in `#private`
  fields (JSON/inspect show nothing); `loadEnvelope` logs only the key id.
- **Chart:** Secret `<release>-envelope-key` (`key`, optional `key-previous`), generated with Helm
  `lookup` and kept (`helm.sh/resource-policy: keep`), or `envelope.keySecret` for a pre-created one;
  offline render refuses to generate (as for the other secrets). Env `KOBE_ENVELOPE_KEY[_PREVIOUS]`
  goes to the **API server only**.
- **mcp-proxy does not get the key.** The server decrypts grants and passes short-lived material
  over the existing internal channel (KOBE-61 design); this keeps the KEK in one process, and the
  chart test asserts scheduler, mcp-proxy, egress-proxy, model gateway and web have none.
- **Server:** `loadEnvelope(process.env, logger)` at start-up (fails fast when malformed; warns when
  unset), exposed as `deps.envelope`. Nothing calls it until KOBE-108.

## Open questions (for Chris or the coordinator)

1. (Resolved) Backup guidance is in `docs/backup-restore.md` and `docs/install.md`. `kobe backup`
   cannot include the Secret (Postgres and S3 only; bundling the key with its ciphertext defeats it).
2. If the KEK might later live in a KMS/Vault, `Envelope` is the seam; not needed in v1.

## Evidence

| Criterion                                         | Evidence                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| ac-1 round-trip, wrong key/AAD/tamper, kid errors | `packages/db/src/envelope/envelope.test.ts`                                                                         |
| ac-2 key never in logs/errors/serialisation       | same file, "never exposes the key..." (logger spy, error stacks, JSON/inspect); chart: not in any non-Secret object |
| Chart                                             | `charts/kobe/tests/envelope.test.ts`; `render.test.ts` offline-render cases                                         |
