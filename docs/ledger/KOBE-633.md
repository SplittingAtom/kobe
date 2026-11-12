# KOBE-633: SSO-9 — offline mock Entra OIDC provider and SCIM client in k3d CI

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (commit on `kobe-633-sso-mock-idp`, not pushed)
- **Branch / worktree:** `kobe-633-sso-mock-idp` in `../Kobe-wt633`, from group branch `kobe-sso`
  at `890d8415` (KOBE-625..631, 638)
- **Depends on:** KOBE-628 (sign-in), KOBE-629 (MFA), KOBE-631 (SCIM Users), KOBE-630 (linking).
- **Spec:** `docs/specs/sso-oidc-scim.md` §17 SSO-9, §8, §10, §11.

## What landed

- **`e2e/sso/mock-entra.mjs`**: a mock Microsoft Entra ID (v2.0) on Node + `jose`. Per tenant
  (`MOCK_TENANTS`): discovery in Entra's shape (issuer `https://login.microsoftonline.com/<tid>/v2.0`,
  no `code_challenge_methods_supported`, like Entra), JWKS (RS256, `kid` = `x5t`), authorize
  (client id, `response_type=code`, `openid`, PKCE S256 required; redirect with `code`, `state`,
  `session_state`), token (client secret basic or post, single-use 10-min code bound to tenant and
  redirect URI, PKCE verified, AADSTS error bodies). ID token: `oid`, `tid`, pairwise `sub` ≠ `oid`,
  `ver: 2.0`, `preferred_username`/`upn`, `roles` or `groups`, overage (`_claim_names` /
  `_claim_sources`) beyond 200 groups or by mode, `acrs` only when Kobe's `claims` parameter asks
  for a context **and** the person has `mfa: true` (Conditional Access). Bad-token modes:
  `wrong_iss`, `wrong_aud`, `wrong_nonce`, `expired`, `stale_auth_time`, `alg_none`, `hs256`
  (client-secret key), `foreign_key`, `missing_tid`, `wrong_tid`, `overage`, `deny`
  (`access_denied`). The person and mode come from test-only query parameters the gate appends to
  Kobe's authorize URL (`mock_user` base64url JSON, `mock_mode`): no control API, no state.
  `/_mock/stats` counts requests per endpoint. Logs `REQ <method> <path> <status>` (never a query).
- **`e2e/sso/scim-client.mjs`**: Entra provisioning's requests: random `userName eq` probe, match by
  `userName`, create (core + enterprise schemas, `roles: []`, work email, `name`), read back by
  `externalId`; PATCH with `Replace`/`Add`, `emails[type eq "work"].value`, path-less value object;
  `active` `"False"` (path and path-less forms) / `"True"`; DELETE. `provisionUser` = Entra's
  create cycle. No imports, so the gate appends it to its client.
- **`e2e/gate-sso.sh`** + **`e2e/gate-sso/client.mjs`** (plays the browser hops and the provisioning
  service from a server pod, after the Gate 1 client's helpers). Parts:
  - setup: CA + leaf for `login.microsoftonline.com` (openssl, 2 days); mock pod on the **installed
    server image** in `kobe-sso-infra` (ConfigMap-mounted script, non-root, read-only root fs);
    CoreDNS `coredns-custom` rewrite (k3s imports `*.override`) of the Entra name to the mock's
    Service, undone at exit; Helm upgrade (saved values, `--reset-values`) with two Entra providers
    (`entra-mock` roles, `entra-groups` groups on a second tenant), `auth.sso.allowedInternalCidrs:
[<mock IP>/32]`, `server.extraCaBundle.configMapName`. Checks: the server pod resolves the name
    to the mock and trusts it; both providers Helm-managed, listed as buttons; Test (discovery)
    passes all checks; mappings created.
  - sign-in: start → authorize host, PKCE, `claims` = acrs c1, redirect URI public, lands on `/`,
    session 200, JIT team role from the mapping (member, team admin, contributor via groups),
    identity `jit`, a second sign-in is the same user.
  - refusal: unmapped → `not_allowed`, overage (201 groups, no SCIM) → `groups_overage`, IdP deny →
    `idp_error`, replayed callback → `state_invalid`, ten bad-token modes → `token_invalid` /
    `tenant_mismatch`; each with no user and no session.
  - MFA: without `require_2fa` a non-MFA person signs in (`mfa_satisfied` false) and an acrs-c1
    person is recorded true; the Owner turns `require_2fa` on → the weak session ends, the proven one
    stays; non-MFA sign-in → `mfa_missing`; acrs c1 passes; then off again.
  - SCIM: token issued (Tenant URL path checked), provision cycle (probe 0, match 0, create 201,
    by externalId 1), duplicate 409 `uniqueness`, PATCH quirks rename, SSO sign-in as the SCIM user
    (identity `scim:<id>`), soft delete → session 401 by the next request and sign-in `deactivated`,
    reactivation → signs in, DELETE 204 + GET 404 + session gone, token revoked → 401.
  - the mock's counters prove Kobe's own discovery and token calls reached it.
- **CI**: `e2e.yml` shard `gate-sso` (`KOBE_E2E_SHARD=gate1-prep e2e/run.sh && e2e/gate-sso.sh`, log
  kept as `gate-log-gate-sso`); mock logs in Diagnostics; `e2e/gate-verdicts.sh` knows the
  "Kobe SSO Gate" verdict line.
- **Unit tests** `services/server/src/testing/e2e-sso-mock.test.ts` (24): every mock token goes
  through Kobe's own `checkIdTokenClaims` and `mfaProven`; JWKS signature checks; code flow
  (secret, single use, redirect URI, PKCE, cross-tenant code); acrs only for MFA + request; overage;
  each bad mode fails the intended check; SCIM client request shapes (recording fetch).

## Decisions

- **Kobe's real Entra code path, no bypass:** Entra issuers are built from the tenant id
  (`login.microsoftonline.com`), so the mock takes that name inside the cluster (CoreDNS rewrite)
  instead of a generic `oidc` provider; MFA (`acrs`) and `tid` checks are Entra-only, so this is the
  only way to cover them. Trust via `server.extraCaBundle`, address via `allowedInternalCidrs`.
- **No new image, package or inventory row:** the mock runs on the server image and resolves the
  `jose` the image already ships (openid-client's dependency, hoisted in the pnpm store; fallback
  `MOCK_JOSE_FROM`). jose is passed in (`createMockEntra({jose})`), so tests use the server
  package's devDependency. Spec §17 says the same. No `pnpm licenses:update` needed (no new dep).
- **Unit tests live in `@kobe/server`** (`src/testing/`, excluded from the build): `e2e/` is no
  workspace package and is docker-ignored, and the server has `jose`, vitest and the claim checks.
- **`require_2fa` off again**: through the API first; the test Owner has no TOTP, so if its session is
  refused the gate resets `site_settings` in the database (fixture work, printed as `db`).
- **SCIM Groups not exercised**: KOBE-632 is parked (roadmap), so Kobe has no Groups endpoint; the
  overage part therefore expects `groups_overage`.

## Docs (CLAUDE.md docs rule)

No guide page changes here: the gate is CI tooling. For KOBE-634 (SSO-10): `docs/install.md` can
cite this gate as the offline proof of the Entra flow; the private-CA path it uses
(`server.extraCaBundle` + `auth.sso.allowedInternalCidrs`) is what an on-prem IdP needs (§11).
A `docs/gates/gate-sso.md` page (what each check proves) is left to the coordinator if wanted.

## Open questions

- none blocking.

## Evidence

- Unit: `pnpm --filter @kobe/server exec vitest run src/testing/e2e-sso-mock.test.ts` → 24 passed.
- k3d: own cluster `kobe633` (scripts/dev-cluster.sh over `DOCKER_HOST=ssh://compute2`), server image
  built from this branch, the other five images from `local-6db3b8728e8b` (unchanged services),
  `KOBE_E2E_SHARD=gate1-prep e2e/run.sh` (0 FAIL), then `e2e/gate-sso.sh` →
  **"Kobe SSO Gate (k3d): proven", 73 ok, 0 FAIL**, twice in a row (rerun idempotent). Mock counters
  of a run: discovery 2, keys 3, authorize 25, token 24 (all ok). Cluster deleted afterwards.
- Found on the way (fixed in the script): CoreDNS 1.14 rejects `answer name exact …` (DNS broke
  cluster-wide until undone) → `answer auto`; a ConfigMap-mounted script is a symlink, so the
  run-as-main check compares real paths; reruns keep the test CA and client secret in
  `kobe-sso-infra` (the server reads both only at start) and restart the server if the CA changed;
  `wrong_iss` is refused by openid-client first (`token_invalid`, not Kobe's `tenant_mismatch`).
