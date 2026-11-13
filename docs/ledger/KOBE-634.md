# KOBE-634: SSO-10 — browser spec on gate1, guide pages, install and backup docs

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (commits on `kobe-634-sso-docs`, not pushed); ac-1 and ac-3 are the
  coordinator's (gate1 run, real tenant)
- **Branch / worktree:** `kobe-634-sso-docs` in `../Kobe-wt634`, from group branch `kobe-sso`
  (KOBE-625..631, 633, 638)
- **Spec:** `docs/specs/sso-oidc-scim.md` §14, §14a, §17 SSO-10, §18

## What landed

- **Guide** (every "Guide pages SSO-10 must update" list of KOBE-625..631, 633, 638 and
  sso-review1 collected):
  - new `docs/guide/admin/single-sign-on.md` (Site admin): providers (form fields, redirect URI,
    Test discovery checks, Off by default, turn off ends sessions, delete vs off, locked tenant,
    Helm read-only, settings without a form field), access mappings (app roles, highest role,
    team roles only, manual wins, last admin, when it applies, Managed by / Take over), linking
    and expected links, unlink, break-glass setup Owner, MFA trust (Entra `c1` context **needs
    Entra ID P1**), SCIM tokens and what SCIM does (create, deactivate, SSO11 reactivation, site
    roles never deactivated, uniqueness), kill switch, audit.
  - new `docs/guide/getting-started/single-sign-on.md` (member): button, first sign-in, the
    `not_allowed` message, linking with local proof + confirm page, Sign-in methods + Unlink, why
    no password for SSO-made accounts (SSO9), 2FA via the organization, being signed out.
  - `getting-started.md` (Sign in), `admin/site-admin.md` (People bullet, Settings link),
    `admin/team-admin.md` (managed members, Take over, Show access mappings),
    `reference/troubleshooting.md` (new "Single sign-on": every `sso_error` code, SSO_ONLY_ACCOUNT,
    SSO_MFA_REQUIRED, last_sign_in_method, admin codes: discovery failures, managed_by_helm,
    identity_settings_locked, managed_by_idp, cannot_take_over_self, site_role_not_mappable,
    mapping_conflict, domain_not_verified, protected_user, already_linked,
    SETUP_OWNER_LOCAL_ONLY, SCIM 401/403/404/409/400/429), `glossary.md` (access mapping, identity
    provider, linked sign-in, managed member, SCIM/SCIM token, single sign-on).
- **`docs/install.md`** new "Single sign-on" section: Entra app registration step by step
  (single tenant, Web redirect URI `https://<kobe>/api/auth/sso/callback/<slug>`, client secret,
  Graph delegated openid/profile/email + admin consent, optional claims `email`/`upn`/`xms_edov`
  with a manifest fallback, app roles `<App>.<Role>[.<Team>]`, Assignment required, groups claim
  "assigned to the application", authentication context `c1` + CA policy), console and Helm
  provider setup, generic OIDC, egress + `auth.sso.networkPolicy` caveat, on-prem
  (`allowedInternalCidrs` + `extraCaBundle`), SCIM (Tenant URL, token, `externalId ← objectId`,
  Groups off, scope, rotation), **Shared tenant** (§14a, all eight points), check list.
- **`docs/backup-restore.md`**: the `accounts` paragraph and row replaced by the §14 wording (no
  IdP tokens, client secrets under the envelope key, SCIM token hashes); Helm `clientSecretSecret`
  and `extraCaBundle` belong in the secret store; new "Single sign-on and SCIM" table (every SSO
  table, `users.deactivated_via`/`setup_owner`, `session_sso_contexts` excluded) and after-restore
  steps (rotate SCIM tokens, envelope key, Helm secrets, Restart provisioning).
- **Browser spec** `e2e/browser/tests/sso.spec.ts` (+ `tests/support/sso.ts`, README section,
  `KOBE_SSO_MOCK_MAP` in `playwright.config.ts`): 4 tests, serial — SSO button; JIT sign-in →
  "Managed by" row without Remove → Take over; link flow (`not_allowed`, member2 password,
  `/link-sign-in`, Link, second SSO sign-in is member2, Unlink in Sign-in methods); SCIM
  provision → SSO sign-in → SCIM `active "False"` → `get-session` null at once, page shows signed
  out, next SSO sign-in `deactivated`. The person comes from `mock_user`, added to the authorize
  request with `page.route`. The SCIM side is the mock's own `e2e/sso/scim-client.mjs` (typed by
  the new `scim-client.d.mts`). Cleanup: take over + remove the made people from the team, SCIM
  DELETE them (never member2), delete the mapping, revoke the token, turn the provider off when
  the run turned it on (or registered it).
- **Mock** (`e2e/sso/mock-entra.mjs`): `MOCK_ORIGIN` (issuer `<origin>/<tid>/v2.0`),
  `MOCK_ADVERTISE_PKCE=1` (generic preset needs S256 listed), `MOCK_HTTP_PORT` (plain listener
  for the ingress, authorize step only, `browserPath`). 3 new unit tests in
  `services/server/src/testing/e2e-sso-mock.test.ts`.
- **Deployment** `e2e/sso/gate1-mock-idp.sh` + `e2e/sso/gate1-mock-idp.yaml` (below).

## Decisions

- **Never the real provider:** the mock is a separate generic OIDC provider (`e2e-mock`) with its
  own issuer at `mock-idp.kobe-sso-mock.svc.cluster.local`; no CoreDNS change, nothing named
  `login.microsoftonline.com`. Entra-only checks (`tid`, `acrs`) stay covered by the k3d gate.
- **One issuer for server and browser:** the browser reaches the mock's in-cluster name through
  Traefik (Chromium `--host-resolver-rules`, `KOBE_SSO_MOCK_MAP`, `ignoreHTTPSErrors` for the
  private CA in the SSO contexts only). This avoids a public DNS name and avoids adding the
  ingress load-balancer range to `allowedInternalCidrs` (the server's discovery check resolves
  the authorization endpoint too). Only `/<tid>/oauth2/v2.0/authorize` is routed (Exact path,
  plain-HTTP listener that serves nothing else); a NetworkPolicy admits only the Kobe server pods
  (8443) and kube-system (8080).
- **Console provider, toggled per run** (not Helm): a Helm provider is always on, so real gate1
  users would see a "Sign in with Mock IdP (e2e)" button permanently. During a run (~1-2 min) the
  button is visible on gate1's sign-in page.
- `generic` + `subjectClaim: oid` so SCIM `externalId` (= oid) and sign-in meet on one identity;
  people carry `email_verified: true` and `amr: [mfa]` (proves MFA under the generic rule).

## For the coordinator: deploy and run on gate1 (ac-1)

1. On compute1, from this branch's `e2e/sso/` (copy the three files):
   `KUBECTL="sudo k3s kubectl" KOBE_NS=kobe-gate1 ./gate1-mock-idp.sh` — creates namespace
   `kobe-sso-mock` (CA, leaf for the in-cluster name, client secret, code ConfigMap, Deployment on
   the installed server image, Service 443/80, Ingress, NetworkPolicy) and ConfigMap
   `kobe-sso-mock-ca` in `kobe-gate1`; prints the values and variables. Needs the server image on
   every node (already pinned).
2. Values (`helm get values kobe -n kobe-gate1 -o yaml > v.yaml`, edit, `-f v.yaml
--reset-values`, never `--reuse-values`): append `"<mock ClusterIP>/32"` to
   `auth.sso.allowedInternalCidrs` (keep the existing list), and
   `server.extraCaBundle: {configMapName: kobe-sso-mock-ca, key: ca.crt}` (if gate1 already has
   a bundle, append the CA to it instead). The upgrade restarts the server; the real Entra
   provider is untouched.
3. Run `npx playwright test sso` in the Playwright container with the usual
   `KOBE_BASE_URL/KOBE_USER/KOBE_PW/KOBE_USER2/KOBE_PW2/KOBE_TEAM` plus the printed
   `KOBE_SSO_MOCK_ISSUER`, `KOBE_SSO_MOCK_CLIENT_ID`, `KOBE_SSO_MOCK_CLIENT_SECRET` (read from the
   Secret, never printed) and `KOBE_SSO_MOCK_MAP=<traefik LB IP>:443`. Tar `e2e/browser` **and**
   `e2e/sso` (the spec imports the SCIM client). member2 must have no authenticator app.
4. Optional removal afterwards: `kubectl delete ns kobe-sso-mock`, the CA ConfigMap, the values.

## For the coordinator: install steps to check against a real tenant (ac-3)

In `docs/install.md` "Single sign-on": (a) portal names and paths of steps 1-8 (App
registrations, Token configuration, Enterprise applications, Protection → Conditional Access →
Authentication contexts); (b) whether `xms_edov` is offered in Token configuration or needs the
manifest; (c) that group assignment to app roles needs P1 (gate1 is free tier); (d) the `c1` +
CA policy produces `acrs` (deferred by Chris 2026-11-12 until a P1 tenant, KOBE-629); (e) SCIM:
Test Connection, `externalId ← objectId` edit, Groups mapping off, scope; (f) "Restart
provisioning" (backup-restore.md) exists under that name.

## Open questions

- The provider form has no fields for allowed email domains, MFA rule, max session hours or JIT
  (docs point to Helm values or `PATCH /v1/site/sso/providers/<id>`). Without allowed domains no
  Entra address is verified (no invitations, no expected links). Follow-up ticket?
- Spec §10/§18 mention a Site console banner when SCIM tries to deactivate a site-role holder;
  only the audit event exists. The guide says "recorded in the audit log". Follow-up or drop?

## Evidence

- ac-1: spec written, typechecked and listed (`npx playwright test sso --list`: 4 tests); not run
  here (no deployment). Mock changes: `e2e-sso-mock.test.ts` 27 passed; local smoke of the mock's
  two listeners (discovery with S256 + own issuer; HTTP token 404, authorize 302).
- ac-2: `scripts/check-public-hygiene.sh` and `scripts/check-site-wording.mjs` in `pnpm verify`.
- ac-4: `docs/install.md` "Shared tenant".
- Guide: `packages/guide` tests (loader validates frontmatter and links), web `lib/docs`, server
  `kobe-mcp/docs` tests green.
