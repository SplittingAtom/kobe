# KOBE-19: Audit export and SIEM forwarding

- **Status:** in review
- **Branch / worktree:** `kobe-19-audit-export` in `../Kobe-wt19`
- **Depends on:** KOBE-15

## Plan

Export routes (install and team), forwarding sweep (syslog, OTLP) with a durable cursor, Helm values,
admin health endpoint, docs.

## Decisions

- **No migration.** The cursor and health live in `install_settings` (one JSON row per destination),
  the same place the PII sweep keeps its position; the app role already has INSERT/UPDATE on it.
  So no `kobe-19-audit-export-migration` PR.
- **OTLP without OpenTelemetry packages.** OTLP/HTTP JSON via `fetch`; no new dependency, so no
  lockfile conflict with KOBE-10 (its branch did not exist when this was written).
- **Syslog:** TCP/TLS, octet-counting framing, one connection per batch. TCP gives no ack, so
  delivery is at-least-once to the socket; de-duplicate on event `id`.
- **Start at head** when a destination is first enabled; history comes from the export.
- **Export** records `audit.exported` before the stream closes. Team export reads each page in its
  own `withTeam()` (no transaction held across the download).
- Lock helper `createPgReconcileLock` got an optional lock name.

## Open questions (for Chris or the coordinator)

- No admin console UI exists for "health"; the view is `GET /v1/install/audit/forwarding`. A web
  panel is a follow-up.
- Private CA for syslog TLS relies on `NODE_EXTRA_CA_CERTS`; a chart value for it is not added.
- Structured-data ID uses the documentation enterprise number 32473.

## Evidence

- ac-1: `services/server/src/audit-export.db.test.ts` (export), `audit/export/export.test.ts`.
- ac-2: `audit/forward/sinks.test.ts` (TCP, TLS, OTLP collectors), `audit-export.db.test.ts` (forwarder).
- ac-3: `audit-export.db.test.ts` "retries failures with backoff ... health view"; chart:
  `charts/kobe/tests/render.test.ts`.
