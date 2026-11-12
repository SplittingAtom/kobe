# KOBE-626: SSO-2 — OIDC provider configuration

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (commit on `kobe-626-sso-provider`, not pushed)
- **Branch / worktree:** `kobe-626-sso-provider` in `../Kobe-wt626` (from group branch `kobe-sso`,
  on KOBE-625's migrations 0209/0210)
- **Depends on:** KOBE-625. Unblocks SSO-3 (KOBE-628: sign-in flow), SSO-6 builds on the store.

## What landed

- **Routes** `/v1/site/sso/providers` (`site.users.manage`, `routes/site-sso.ts`): `GET /`,
  `GET /:id`, `POST /` (create), `PATCH /:id` (edit, `enabled` on/off, `clientSecret` replace),
  `DELETE /:id` (refused while an identity is linked: disable instead), `POST /test` (unsaved
  form) and `POST /:id/test` (saved provider, Helm ones included). Discovery tests are capped at 20
  per admin per minute (Postgres rate limit). Responses are `no-store`.
- **Store** `sso/providers.ts`: views never carry the secret (`clientSecret: "set" | "missing"`),
  plus `redirectUri` (`<publicUrl>/api/auth/sso/callback/<slug>`) and `linkedIdentities`.
  Disabling or deleting a provider deletes its sessions (via `session_sso_contexts`, §9).
  `revealClientSecret` is the one reader, for SSO-3.
- **Secret sealing:** the KOBE-107 envelope, context `{teamId: nil, kind: "sso_client_secret",
recordId: <provider id>}` (id generated before sealing), `client_secret_key_id` =
  `Envelope.keyIdOf`. No envelope key → create/replace answer 503 `credentials_unavailable`, as
  connector site keys do. Added to the start-up sealed-key check (`startup/sealed-keys.ts`).
- **Discovery** `sso/discovery.ts` on `openid-client` 6.8.8 (now a direct dependency; MIT, already
  in THIRD_PARTY_LICENSES, `licenses:update` not needed: no new package). Checks, each reported:
  tenant pinned → discovery URL allowed → reachable → issuer **exactly** equal → `code` → S256
  (absent allowed for Entra only, §5.1) → authorization/token/JWKS endpoints allowed.
  openid-client itself tolerates any `login.microsoftonline.com`/`b2clogin.com` issuer (for
  multi-tenant apps); Kobe compares the string itself.
- **Tenant pinning** `sso/issuer.ts`: Entra issuers are built from the tenant GUID;
  `common`/`organizations`/`consumers` and `{tenantid}` refused for both kinds (any path segment).
- **SSRF** `sso/net.ts`: a `customFetch` for openid-client over the connectors' guard —
  `checkConnectorUrl` (https only, ports `auth.sso.allowedPorts`, every resolved address public
  unless in `auth.sso.allowedInternalCidrs`) and `rawRequest` (connection pinned to the checked
  address, redirects refused, 10 s, 256 KiB). `connectors/oauth/http.ts` now exports `rawRequest`
  and throws `RedirectRefusedError` (a subclass with the old code) on 3xx. Private CA: the existing
  `server.extraCaBundle` (`NODE_EXTRA_CA_CERTS`), nothing new.
- **Kill switch** `KOBE_SSO_ENABLED` (chart `auth.sso.enabled`, default true; server default
  false when unset): off → every `/v1/site/sso/*` answers 404 (before the permission check),
  `/v1/me` drops `siteFeatures: ["sso"]`, the console nav hides the section. SSO-3 must check
  `deps.sso.settings.enabled` in its sign-in routes and buttons (there is no sign-in flow yet).
- **Helm** `auth.sso` {`enabled`, `allowedInternalCidrs`, `allowedPorts`, `providers[]`,
  `networkPolicy` {`enabled`, `cidrs`, `extraEgress`}}; schema (tenant GUID, https issuer,
  entra⇔tenantId / oidc⇔issuer, `clientSecretSecret {name,key}` required, no inline secret).
  Rendered into the API server only: `KOBE_SSO_PROVIDERS` (JSON without secrets) and
  `KOBE_SSO_CLIENT_SECRET_<SLUG>` from `secretKeyRef`. The server validates again at start (fails
  fast, `sso/settings.ts`).
- **Start-up upsert** `seedHelmProviders` (in `seedAtStart`): insert/update `managed_by: helm`,
  disable Helm rows the values dropped, never touch a console row of the same slug (logged), no
  IdP contact (break-glass). Audited as the system only when something changed.
  `STARTUP_SEEDED_ROWS` gains `sso_providers` (`managed_by = 'helm'`) and the system's
  `identity.sso.provider.created|updated|enabled|disabled` events; restore-target test expects
  `sso_providers: 0` plus accept/refuse cases; startup-seeds test runs with a Helm provider.
- **NetworkPolicy** `sso-networkpolicy.yaml` (off by default): server egress to DNS and the IdP
  (public ranges on `allowedPorts`, or `cidrs`, plus `allowedInternalCidrs`). The server has no
  egress policy today, so enabling it alone makes the server default-deny: values comment says so.
  Entra host named in comments only (`login.microsoftonline.com`), no tenant ids.
- **Console** Site console → People → Single sign-on (`feature: "sso"` gate on the nav,
  `SiteFeature` type, `/v1/me` `siteFeatures`): list, add, edit, turn on/off (confirm: sessions
  end), delete, Test (list of checks); secret field write-only (password input, cleared after
  every save, empty on edit = unchanged); Helm rows show "Set in Helm values" with Test only.

## Decisions

- Kind and slug are immutable after create (the slug is in the redirect URI pasted into the IdP).
- Save runs discovery on create and when tenant/issuer changes; enabling does not re-run it.
- A Helm provider dropped from values is disabled, not deleted (identities may reference it).
- Helm provider `enabled` defaults to true (it is configuration as code); console ones start off.
- Entra MFA preset `{amr_any: default, acr_any: [], acrs_any: ["c1"]}` (§8); SSO-4 verifies it.
- Discovery results are not cached here; the 1 h cache and JWKS refetch belong to SSO-3.
- The 422 `discovery_failed` body carries the report; the console shows its message, and Test
  shows every check.

## Spec deviations

- Redirects are refused outright rather than "re-checked" (§11): stricter, same as connectors.
- `auth.sso.allowedPorts` and `auth.sso.networkPolicy` are additions to §4's values shape.

## Guide pages for SSO-10 (KOBE-634)

None changed here (spec §18 assigns them to SSO-10). SSO-10 must update:

- `docs/guide/admin/site-admin.md` — new "Single sign-on" section: adding a provider (Entra tenant
  ID or issuer, client ID, write-only secret, redirect URI), Test and what each check means,
  turning on/off (sessions end), delete vs disable, Helm-managed providers read-only, kill switch.
- `docs/guide/getting-started.md`, `docs/guide/admin/team-admin.md`,
  `docs/guide/reference/troubleshooting.md` (discovery failures: `multi_tenant_issuer`,
  `issuer_mismatch`, `no_pkce_s256`, `address_not_allowed`, `redirect_refused`),
  `docs/guide/glossary.md` — as §18 lists.
- `docs/install.md`: `auth.sso` values, the Secret for `clientSecretSecret`, egress to
  `login.microsoftonline.com`, `networkPolicy` caveat, `allowedInternalCidrs` + `extraCaBundle`
  for on-prem IdPs. `docs/backup-restore.md`: the "OAuth tokens in `accounts`" row (§14); the
  restore section already names Helm providers as start-up seeds (this ticket).

## Evidence (acceptance criteria → tests)

- ac-1 `common`/`organizations`/`consumers` refused: `sso/issuer.test.ts`,
  `sso/discovery.test.ts`, `sso/settings.test.ts`, chart `tests/sso.test.ts` (schema),
  `site-sso.db.test.ts` (422 on create and edit).
- ac-2 issuer mismatch: `discovery.test.ts` (other issuer, other tenant, `{tenantid}`, trailing
  slash), `site-sso.db.test.ts`.
- ac-3 secret never returned: `site-sso.db.test.ts` (create/list/get/patch bodies, sealed column,
  every audit row and every log line checked for the console and Helm secrets); web test (POST body,
  DOM, field cleared).
- ac-4 Helm read-only: `site-sso.db.test.ts` (409 `managed_by_helm` on edit/toggle/secret/delete,
  secret columns NULL, upsert idempotent/updates/disables/conflict), web test (no edit buttons).
- ac-5 kill switch: `site-sso.db.test.ts` (every route 404, `siteFeatures` gone), registry test
  (section hidden without the feature), chart test (`KOBE_SSO_ENABLED=false`, no NetworkPolicy).
- ac-6 SSRF: `discovery.test.ts` (http, private/loopback/metadata/ULA addresses, allowed CIDR,
  redirect via a scripted IdP and a real local server, private/http endpoints, port).
- ac-7 chart: `charts/kobe/tests/sso.test.ts` (13 tests: env, secretKeyRef, schema refusals,
  NetworkPolicy, server parses what the chart renders).
