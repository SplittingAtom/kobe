# KOBE-618: KA-1 built-in connector support (db, migration alone)

- **Status:** committed on `kobe-618-619-admin-host` (own commit, migration only)
- **Branch / worktree:** `kobe-618-619-admin-host` in `../Kobe-wt618` (from group branch `kobe-admin-mcp`)
- **Depends on:** spec `docs/specs/kobe-admin-mcp.md` §11 KA-1 (decisions KA1–KA8 final)

## Plan

Migration `0207_kobe_builtin_connector` (generated): `connectors.builtin text NULL`, the partial
unique index `connectors_builtin_key`, checks `connectors_builtin` and `connectors_builtin_url`.
Seed function, site switch reader and audit `via` in `@kobe/db`; the server wires the seed at start
in KOBE-619.

## Decisions

- **Fixed id** `6b6f6265-0000-4000-8000-000000000001` for the `kobe` row (check-enforced). Replicas
  seed one row (`INSERT … ON CONFLICT DO NOTHING` on any unique key), the MCP proxy routes it by id
  without asking the server, and backups/restores keep the same id.
- **Internal URL marker** `http://kobe-server.internal/internal/v1/mcp/kobe` (reserved `.internal`
  zone, never fetched). `connectors_builtin_url`: `(builtin IS NOT NULL) = (url = <marker>)`, so no
  registered connector can carry it and the built-in can point nowhere else. `connectors_builtin`:
  only `'kobe'`, the fixed id, `auth_kind none`, `credential_source member`, empty snapshot, no hash.
- **Name**: `kobe`, or `kobe-builtin` when a registered connector holds `kobe` (or its Pi segment);
  `seedKobeBuiltinConnector()` returns `seeded{fallback}` / `present` / `names_taken` for the server
  to log. No `team_connectors` row: the team level lives in `teams.settings` (§6).
- **Site switch** `kobe_mcp.mode` (`off|docs|admin`): no row is written; unset or unknown text reads
  as `docs` (KA5, `parseKobeMcpMode`, `readKobeMcpMode`). Team level constants
  (`kobe_mcp.admin`: `docs|read|read_write`, default `docs`) live next to it.
- **Audit `via`** (deviation in shape, not in meaning): `audit(tx, {..., via: {kind: "agent",
threadId, runId, toolCallId}})` on every action, stored as `target.viaAgent = {threadId, runId,
toolCallId}`. In the target, so the existing hash chain covers it with no canonical-form change
  (a new column would have needed chain v3 in SQL and Node). Not `target.via`: three actions already
  use `via` as a string. Only a user actor may carry it; validated strictly; a target that already
  names `viaAgent` is refused; a unit test asserts no action's allowlist uses the key.
- `STARTUP_SEEDED_ROWS.connectors = builtin IS NOT NULL` so `kobe restore` accepts a target that
  holds only the seeded row.
- "Down": Drizzle has no down migrations. Rolling back the release is safe: the column is nullable
  and the previous release ignores it (it would list the built-in row as a connector with an
  unreachable URL until the row is deleted by hand: `DELETE FROM connectors WHERE builtin='kobe'`).

## Open questions (for Chris or the coordinator)

- None blocking.

## Evidence (acceptance criteria → test or command output)

- ac-1 up clean on a gate1-shaped copy (registered `kobe` connector enabled for a team, audit
  chain): `packages/db/src/kobe-builtin-upgrade.db.test.ts` (re-running migrations is a no-op).
- ac-2 seed idempotent across replicas (8 concurrent seeds → one row):
  `packages/db/src/kobe-builtin-connector.db.test.ts`.
- ac-3 cross-team probe suite green: `pnpm --filter @kobe/db test:db` 110 files / 1760 tests
  passed (incl. `probe.db.test.ts`); `pnpm --filter @kobe/db test` 803 passed.
- ac-4 chain verifies with `via` rows: both db tests above call `verifyAuditChain`.
