# KOBE-303: Site-wide API key for an MCP connector

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

Group G10 (`group-10-connectors`), with KOBE-431 (which owns the probe-credential choice this
ticket plugs into). Chris (2026-10-16): team admins still enable and choose exposure (D27
unchanged); site key only, no personal-key override.

## Design

- **Mode** `connectors.credential_source` (`member` default | `site`), CHECK `site` ⇒
  `auth_kind = 'api_key'`. **Key** in the site-wide table `connector_site_keys` (PK/FK connector,
  ON DELETE CASCADE; `sealed` envelope text, `key_id`, `hint`, `updated_by`). Migration
  `0151_connector_site_keys` (generated only: no custom SQL needed, grants come from
  `tenancy/connectors.ts`). Upgrade test `packages/db/src/connector-site-keys-upgrade.db.test.ts`.
- **Sealing** `services/server/src/connectors/site-key.ts`: `Envelope.seal` with context
  `{teamId: nil uuid, kind: "connector_site_key", recordId: connectorId}` (as web search does);
  `key_id` stored. "Rotation sweep": the only KEK-id sweep in the codebase is the start-up
  sealed-key check (KOBE-425, `startup/sealed-keys.ts`); the site keys are a family there
  ("connector site-wide keys"). There is no re-wrap job for grants either (`Envelope.rewrap`
  exists, unused) — same footing as `connector_grants`.
- **Never both**: member → site drops every member grant (`dropConnectorGrants`, audited);
  site → member, a new URL, or an auth kind other than `api_key` drops the site key
  (`mcp.connector.site_key_removed {reason: mode_changed|url_changed|removed}`); members' PUT of
  their own key → 409 `provided_by_site`.
- **Serving** (ac-3, ac-5): no proxy change. `revealCredential` (grants.ts) runs the same liveness
  chain (team enabled + active, user active, member) and, for a `site` connector, returns the site
  key instead of a grant; the proxy fetches it per call through `/internal/v1/mcp/connectors/:id/grant`,
  so replace/remove apply on the next call and a deactivated member is refused at once. Skill
  evals still get no key (unchanged internal route rule). Every call is still decided by the
  server and audited as `mcp.tool_call` with the member's `userId`. Schedules use the same path.
- **API**: `PUT /v1/site/connectors/:id/site-key {api_key}` (409 `not_site_key`, 503 without an
  envelope; pins the tools with it when unpinned), `DELETE …/site-key`; create/patch accept
  `credentialSource`; views carry `credentialSource` + `siteKeyHint` (••••last4 of a ≥16-char
  key, else ••••). `/v1/team/connectors` carries `credential_source`.
- **Probes**: `chooseProbeCredential` tries the site key first (KOBE-431).
- **Audit**: `mcp.connector.site_key_set {replaced}`, `.site_key_removed {reason}`, `updated`
  `changed` may name `credentialSource`; never the key or hint.
- **Web**: registry form "Whose key" (api_key only), a "Site key" panel with the shared-attribution
  warning (`connector-site-key.tsx`); My connector keys shows "Provided by your organization".
- **Docs**: `docs/install.md` MCP connectors → Credentials; `docs/audit-log.md`.

## Tests

- `services/server/src/connector-site-key.db.test.ts` (10): sealed + masked + pinned with the key;
  refusals; admin-only; both members served, other team not; replace/remove next call; deactivated
  member; mode switches drop the other credential; URL/auth-kind changes; refresh prefers the site
  key; no key in audit rows, logs or responses.
- `connectors/site-key-reach.test.ts`: sandbox rendering (`manifests`, `eval-manifests`,
  `provider`) imports nothing that can open a credential.
- `sealed-keys.db.test.ts`: the new family is reported under a foreign envelope key.
- Web: `connectors-page.test.tsx` "site-wide key (KOBE-303)", `my-connectors.test.tsx`.
- **e2e** (ac-6) `e2e/run.sh` MCP section, "KOBE-303": registry API → site key → the e2e user and the
  workspace-sync user call `get_thing` with no keys; the fake (`e2e/lib/fake-mcp.js` now logs
  `AUTH <header>`) sees `Bearer <site key>` twice; no key in sandbox env, SandboxTemplates, audit,
  server logs; stored sealed. **Not run locally** (needs k3d); first run is CI's e2e job.

## Review fixes (2026-10-19, review-g10 M2, L1, L4, L5, tests 2-5)

- **M2:** `connector_site_keys.url_sha256` (0151 regenerated: unreleased) and the envelope
  `recordId` `<connectorId>:<sha256(url)>` bind the key to the URL it was set for.
  `revealSiteKey` serves nothing (members' calls and probes alike) when the URL no longer
  matches; views carry `siteKeyStale` and the page says to re-enter the key.
- **L1:** rollback and rolling-upgrade behaviour documented in `docs/install.md`.
- **L4:** PATCH `credentialSource: site` on a connector that will not be `api_key` → 400 with
  "A site-wide key is for API-key connectors only".
- **L5 (rotation):** grants are not re-sealed under a new KEK anywhere: the only KEK-id sweep is
  the start-up report (KOBE-425, `startup/sealed-keys.ts`), which names rows sealed with a key
  the server does not hold. Site keys match that: same report family, no re-wrap. A re-wrap job
  (`Envelope.rewrap`, unused today) would cover grants and site keys together.
- Tests: URL changed by raw SQL → no key served or probed, `siteKeyStale`, re-entry restores;
  eval principal → 404 `not_connected`; scheduled run → allowed, site key served, `mcp.tool_call`
  audited as the member; member removed from the team refused; L4 400.

## Open

- Skill evals (KOBE-325) get no credential at all, including a site key. Kept; say if evals
  should use site keys.
- The e2e's second member uses the workspace-sync user's claim (it must still exist then).
