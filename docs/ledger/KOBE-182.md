# KOBE-182: KOBE-19 follow-ups: forwarding health in the admin UI, syslog private CA chart value, real enterprise number

- **Status:** committed on `group-1-fixes` (group G1, last ticket), not pushed
- **Branch / worktree:** `group-1-fixes` in `../Kobe-g1`
- **Depends on:** KOBE-19 (audit export and forwarding)

## Plan

ac-1 in three parts: (1) a site console page for `GET /v1/site/audit/forwarding` with status, lag
and last error, credentials never shown; (2) a chart value mounting a CA bundle and setting
`NODE_EXTRA_CA_CERTS`, proven against a TLS syslog collector signed by a private CA; (3) the
RFC 5424 SD-ID enterprise number configurable (chart → env → zod), default 32473.

## Decisions

- **New site section "Audit forwarding"** (System, after Isolation), not inside the site "Audit log"
  section: that one is still a KOBE-15 placeholder and is the log itself. Minimum role admin
  (`site.audit.read`). Uses only existing console classes (`table`, `error`, `banner`, `hint`), so it
  follows both themes. Failing → `role=alert` (danger), retrying → `role=status` (warning), an
  error after recovery stays visible as a resolved note.
- **Redaction on the server, twice, plus once in the browser.** Found while testing: `fetch` refuses
  a URL with userinfo and quotes the whole URL, credentials included ("Request cannot be
  constructed from a URL that includes credentials: …"), and KOBE-19 stored that verbatim. Now
  `audit/forward/redact.ts` removes URL userinfo, query strings/fragments, `Bearer`/`Basic` tokens
  and every configured secret (OTLP header values and the token part of "Scheme token", URL user and
  password raw and decoded; values under 4 characters are skipped) before an error is stored or
  logged; `readForwardingHealth` redacts again on read (rows written before this change); the web
  page applies the generic pass too.
- **`server.extraCaBundle` {secretName | configMapName, key}** rather than under `auditForwarding`:
  `NODE_EXTRA_CA_CERTS` is process-wide (OTLP, OIDC, S3 benefit too). One fixed mount
  `/etc/kobe/extra-ca/ca-bundle.pem` (the key is projected to that file name), read-only; server
  only (the scheduler does not forward). Schema rejects both sources at once, non-DNS names and
  path-like keys. Node reads the bundle at start only: docs say restart after rotating.
- **Private CA proof** (`private-ca.test.ts`): openssl makes a CA and a localhost leaf it signs; a
  TLS listener in the test; the real `syslog.ts` runs in a child Node process (type stripping and
  a resolve hook mapping `.js` to `.ts`), because `NODE_EXTRA_CA_CERTS` is read only at process
  start. Without the env: `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, nothing received; with it: delivered.
  Skipped when openssl is missing (hosted runners have it).
- **Enterprise number:** `auditForwarding.syslog.enterpriseNumber` (default 32473) →
  `KOBE_AUDIT_SYSLOG_ENTERPRISE_NUMBER` (rendered only while syslog is on) → zod
  `^[1-9][0-9]{0,9}$`, validated even while syslog is off. Schema accepts an integer or a digit
  string. `SYSLOG_SD_ID` became `syslogSdId(pen)`.

## Evidence

- ac-1 (UI): `apps/web/components/admin/audit-forwarding-page.test.tsx` (off, ok + failing,
  retrying + pending, resolved error, credentials never rendered, refresh + API error);
  nav registry tests (READY ⇔ page).
- ac-1 (redaction): `services/server/src/audit/forward/redact.test.ts`; `audit-export.db.test.ts`
  "never puts collector credentials in the health view" (real OTLP sink with a userinfo URL).
- ac-1 (CA bundle): `charts/kobe/tests/ca-bundle.test.ts` (Secret, ConfigMap, default off, server
  only, schema refusals); `services/server/src/audit/forward/private-ca.test.ts` (test collector).
- ac-1 (SD-ID): `sinks.test.ts` (format, sink, config digits-only), `ca-bundle.test.ts` and
  `render.test.ts` (env). Docs: `docs/audit-log.md` (Export and forwarding), `docs/install.md`
  (Private certificate authorities).
