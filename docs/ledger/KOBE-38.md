# KOBE-38: Egress proxy (default deny)

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-38-egress-proxy` in `../Kobe-wt38`
- **Depends on:** KOBE-22 (merged), KOBE-35 (merged), KOBE-15 (merged), KOBE-20 (merged)

## Acceptance criteria (Hadron)

1. **ac-1** Fresh install: any outbound request from a sandbox is blocked.
2. **ac-2** Enabled domain works; disabled domain blocked.
3. **ac-3** Direct egress bypassing the proxy is blocked by NetworkPolicy (test).

Plus the coordinator's brief: SNI ↔ CONNECT host match, token auth, allowlist from Postgres with
LISTEN/NOTIFY invalidation, private-IP / rebinding protection, limits, `egress.blocked` path, chart
(Deployment, NetworkPolicies, the proxy's own egress), ceiling + enablement tables, admin APIs and
console pages.

## Design

- **`services/egress-proxy`** (Node `http` server, no Hono): `proxy.ts` (CONNECT handling),
  `client-hello.ts` (TLS ClientHello SNI parser, multi-record, bounded, no TLS termination),
  `auth.ts` (Proxy-Authorization), `allowlist.ts` (cache) + `change-listener.ts` (LISTEN),
  `address-policy.ts` (forbidden ranges), `resolver.ts` (c-ares), `limits.ts`, `tunnel.ts`,
  `connection-audit.ts`, `blocked-reporter.ts`, `config.ts` (zod). Order per CONNECT: token →
  target syntax (host name, port in `allowedPorts`) → active membership → allowlist → connection
  limit → resolve once, every address must pass → connect to a checked address → `200` → read the
  ClientHello, SNI must equal the CONNECT host → relay (backpressure, per-sandbox token bucket, idle
  timeout). Plain HTTP (absolute-form) → 403. Blocked responses carry the reason in the status line
  (curl/pip print it), e.g. `403 Kobe egress blocked: pypi.org is not enabled for this team`.
- **`packages/session-token`** (new): sign/verify moved out of the server so every verifier uses the
  same rules (HS256 pinned, exact header, per-audience key). The server's
  `sandbox/session-token.ts` re-exports them (no API change for KOBE-24/58).
- **DB** (`packages/db`): `egress_domains` † (`domain` PK = pattern, `preset`, `in_ceiling`,
  `note`, `created_by`), `team_egress` (team table, RLS; FK → `egress_domains` ON DELETE CASCADE,
  `enabled_by`, `enabled_at`). Migrations `0016_egress` (generated) and `0017_egress_rls` (RLS +
  preset seed). Pattern grammar in `egress/domain.ts` and the same regex as a CHECK constraint.
  `egress/store.ts`: loaders, `isActiveTeamMember`, `notifyEgressChanged`, channel constants.
- **Server**: `/v1/install/egress-ceiling` (GET, POST, PUT `/:domain`, PUT `/presets/:preset`,
  DELETE `/:domain`; `install.egress.manage`) and `/v1/team/egress` (GET `team.read`; PUT/DELETE
  `/domains/:domain` `team.egress.manage`). Every change audits and NOTIFYs in its transaction.
  `egress/blocked-relay.ts`: LISTEN `kobe_egress_blocked` + 30 s sweep → `egress.blocked` run
  events (started in `index.ts`, server process only).
- **Web**: Install console → Egress ceiling (presets grouped, add/remove all, add custom, delete
  custom); Team console → Egress (enable/disable, suspended entries).
- **Chart**: proxy Deployment gets app-role DB URL, **only** `KOBE_SESSION_KEY_EGRESS_PROXY`, limits
  and waits for migrations; `egress-proxy-networkpolicy.yaml`: ingress only from team namespaces
  on 8080; egress (`restrictEgress`, default on) only DNS (kube-dns), Postgres (CNPG pods or
  `databasePeers`), public IPv4 on `allowedPorts`, `allowedInternalCidrs`, `extraEgress`.

## Decisions

- **HTTPS only, no TLS interception, no plain HTTP.** D28 says "(HTTPS; SNI/Host match)"; the
  reading is CONNECT host ↔ TLS SNI. Plain-HTTP proxy requests get 403. Ports: 443 only by default.
- **Ceiling semantics:** effective(team) = `team_egress` ∩ (`egress_domains` with `in_ceiling`).
  Teams can only enable rows of the ceiling (FK + `in_ceiling` check). Taking a preset out of the
  ceiling keeps team rows (inert, shown "suspended"); deleting a custom domain cascades into every
  team's row (intended, audited as `egress.ceiling.removed`). Wildcards `*.x.y` match subdomains at
  any depth, never the apex; a team enables exactly a ceiling pattern (no narrower sub-patterns).
- **Presets (D28 "registries sit in the ceiling but off for teams"):** `pypi.org`,
  `files.pythonhosted.org`, `registry.npmjs.org`, `deb.debian.org` seeded **in** the ceiling; git
  hosts `github.com`, `gitlab.com` seeded **out** of it (one click to add). `web_search` preset
  value reserved for KOBE-63.
- **`egress_domains` classification confirmed install-wide** (already registered); app role gets
  full DML (the only cascade is into `team_egress`, documented in `tenancy/policy.ts`).
- **Auth:** `Proxy-Authorization: Basic base64(<user>:<egress token>)` (what `HTTPS_PROXY=
http://user:token@…` produces) or `Bearer`. `<user>` is free; a UUID is a thread hint used only
  to pick among the same user's active runs. Liveness: the token's user must be an active member of
  the token's team (cached 30 s; deactivation/removal therefore stops egress within 30 s, plus the
  15 min token TTL). There is no `sandboxes` table yet, so the sandbox itself is not checked live.
- **Address policy:** refuse a name if **any** resolved address (A and AAAA) is in a non-global
  range (RFC 1918, loopback, link-local incl. 169.254.169.254, CGNAT, multicast, reserved,
  documentation, benchmarking, IPv6 ULA/link-local/site-local, and the IPv4-embedding IPv6 ranges
  `::ffff:0:0/96`, `64:ff9b::/96`, `2002::/16`, `2001::/23`) unless in `allowedInternalCidrs`;
  connect only to a checked address (at most 3 tried, IPv4 first). DNS via c-ares with the name made
  absolute (trailing dot), so pod search domains never apply and `/etc/hosts` is not read.
- **Connection log:** `egress.connection` aggregated per (team, user, sandbox, host, port,
  outcome, reason) and flush window (default 60 s); every connection counted in exactly one row with
  its bytes; also one JSON log line per connection. Unauthenticated attempts have no team: logged
  only. Following KOBE-15's "consider batching".
- **`egress.blocked` path without KOBE-24:** the proxy writes a pending `events` row (kind
  `egress.blocked`, ref: sandbox, user, domain, port, reason, request_access, thread hint) and
  NOTIFYs `<team>:<event>` (ids only). The server relay appends `egress.blocked {domain,
request_access}` to the user's active runs in that team (one sandbox per (user, team), D11),
  narrowed by the thread hint; marks the event processed with `run_ids`. Rate limit: one report per
  (sandbox, host, reason) per 30 s. `request_access` = in the ceiling but not enabled (matches the
  protocol comment "false when the domain is outside the ceiling"). `tool_call_id` is never set
  (the proxy cannot correlate).
- **Limits defaults:** 64 tunnels per sandbox, 4096 per replica, 20 MiB/s per sandbox (both
  directions, token bucket with 1 s burst), idle 300 s, request head + ClientHello 10 s, connect
  10 s, DNS 3 s. Per replica, not cluster-wide.
- **The proxy connects to Postgres as the app role** (like server/scheduler). See risks.
- **IPv6:** the proxy's own NetworkPolicy has no IPv6 rule (clusters here are IPv4); AAAA records
  are still checked, and an IPv6-only destination fails to connect.

## Open questions (for Chris or the coordinator)

1. **Header injection (KOBE-39) needs a design decision.** D28 per-team header injection cannot
   work on an opaque HTTPS tunnel. Options: (a) TLS interception only for header-injected domains,
   with a Kobe CA trusted by the sandbox image (CA key held by the proxy); (b) the sandbox talks
   plain HTTP to the proxy for those domains (`http://` index URL, absolute-form request) and the
   proxy upgrades to HTTPS upstream, verifying the certificate, and injects the header. (b) needs no
   CA and keeps "never decrypt sandbox TLS"; the proxy currently refuses absolute-form requests in
   `handleRequest` (the seam). D21's web-search key "attached by the egress proxy" has the same need.
2. **How tools in the sandbox get proxy credentials (sandbox-agent ticket).** Pi's environment is
   allow-listed (KOBE-23), so `HTTPS_PROXY` set by the provider does not reach tools, and the pod
   env cannot carry the token (no secrets in pod specs; it is minted after start and expires in
   15 min). Suggested: the agent writes the current egress token to a file it rotates (e.g.
   `/tmp/kobe/egress-token`) and Pi gets `BASH_ENV=<root-owned script>` exporting
   `HTTPS_PROXY=http://<thread_id>:$(cat token)@egress-proxy.kobe.internal` (+ lowercase,
   `NO_PROXY`), so each shell picks up a fresh token and carries the thread hint. The agent has no
   listener (no local forwarding proxy). Until then, only the e2e (and anyone using the token by
   hand) exercises the proxy from a sandbox.
3. A dedicated least-privilege DB role for the proxy (SELECT on two tables, INSERT on `events` /
   `audit_log`) instead of the app role — shared concern with the MCP proxy (KOBE-58).

## For downstream tickets

- **KOBE-39 (request access, header injection):** blocked attempts are `events` rows kind
  `egress.blocked` (`ref.domain`, `ref.request_access`, `ref.user_id`, `ref.thread_id?`,
  `ref.run_ids`) and `egress.blocked` run events. Build `egress_requests` + `POST /v1/egress/
requests` on top; the team page is `components/admin/team/egress-page.tsx` (add requests there).
  Enabling must go through `enableTeamDomain` (audit + NOTIFY). Add `header_enc` to `team_egress`
  and resolve open question 1. Audit actions reserved in docs: `egress.request.created`,
  `.decided`, `egress.header.set`.
- **KOBE-63 (web search):** add the provider domain with `preset = 'web_search'` and
  `in_ceiling = true` (`addCeilingDomain` or a migration), NOTIFY `ceiling`.
- **KOBE-58 / KOBE-40:** use `@kobe/session-token` `verifySessionToken(token, aud, key)`; give the
  service only its own key (see the chart's `kobe.egressProxyEnv`). Add an ingress NetworkPolicy on
  the receiving side, as `egress-proxy-networkpolicy.yaml` does.
- **Sandbox agent ticket:** see open question 2. Credentials format: `Proxy-Authorization: Basic
base64(<thread uuid or any>:<kobe.egress-proxy token>)`.
- **KOBE-25/28:** when a `sandboxes` table exists, the proxy can check the token's `sub` is live
  (currently it checks the user's active membership).

## Risks

- **App-role DB credentials in an internet-facing process.** The proxy only parses ClientHello
  bytes and HTTP request heads (Node's parser), never decrypts payloads, and its NetworkPolicy
  limits where it can connect; still, a compromise would expose the app role (RLS still applies,
  but the role can set `kobe.team_id`). Mitigation proposed: open question 3.
- **ECH**: clients using Encrypted Client Hello send an outer SNI (public name) that won't match;
  they are cut (fail closed). Common CLI tools don't use ECH.
- Membership liveness is cached 30 s; allowlist changes apply on NOTIFY (TTL 60 s backstop, 5 s while
  the listener is down).
- Limits are per replica; with N replicas a sandbox may hold N × the per-sandbox limit.

## Evidence (acceptance criteria → test or command output)

| AC / item                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ac-1 fresh install blocks everything | `allowlist.test.ts` "fresh install…"; `egress-proxy.db.test.ts` "fresh install: the team reaches nothing"; `packages/db egress.db.test.ts` presets + "a fresh team reaches nothing"; `proxy.test.ts` "blocks a domain the team has not enabled"; e2e "fresh install: a sandbox reaches nothing…", "…registries are in the ceiling but not enabled"                                        |
| ac-2 enabled works, disabled blocked | `proxy.test.ts` "relays an enabled domain's TLS bytes untouched…"; `egress-proxy.db.test.ts` "enabling a domain takes effect through the change hint", "taking a domain out of the ceiling…"; server `egress.db.test.ts` team egress suite; e2e "an enabled domain is reachable through the proxy (CONNECT 200)", "…TLS server answered end to end", "a disabled domain is blocked again" |
| ac-3 direct egress blocked           | e2e "direct egress to the upstream / internet (bypassing the proxy) is blocked by NetworkPolicy" (plus KOBE-22's probes); chart `egress.test.ts` ingress policy; e2e "the egress proxy admits nothing but sandboxes"                                                                                                                                                                      |
| SNI ↔ CONNECT match                  | `client-hello.test.ts` (real ClientHello, fragmented records, no SNI, non-TLS, 0-RTT, fuzz); `proxy.test.ts` "cuts the tunnel when the TLS server name differs…", "…without SNI and … another protocol", "…never sends a ClientHello"                                                                                                                                                     |
| Private IP / rebinding               | `address-policy.test.ts`; `proxy.test.ts` "refuses an allowed name that resolves to a private address", "…any of its addresses is internal", "resolves once and connects to the address it checked"; e2e "an enabled domain that resolves to an internal address is refused"                                                                                                              |
| Auth                                 | `auth.test.ts`; `proxy.test.ts` authentication suite; `@kobe/session-token` tests; e2e 407 for a forged token                                                                                                                                                                                                                                                                             |
| Limits                               | `limits.test.ts`; `proxy.test.ts` limits suite (429, idle close, throttling)                                                                                                                                                                                                                                                                                                              |
| Audit                                | `connection-audit.test.ts`; `egress-proxy.db.test.ts` "writes aggregated egress.connection audit rows"; server `egress.db.test.ts` ceiling/enablement audit; e2e connection audit with bytes                                                                                                                                                                                              |
| egress.blocked path                  | `blocked-reporter.test.ts`; `egress-proxy.db.test.ts` "records a pending egress.blocked event…"; server `egress.db.test.ts` relay suite (active run, thread hint, other users untouched, NOTIFY); e2e events count                                                                                                                                                                        |
| Chart                                | `charts/kobe/tests/egress.test.ts`; `sandbox.test.ts` session-key distribution                                                                                                                                                                                                                                                                                                            |
| Admin consoles                       | `apps/web/components/admin/egress-pages.test.tsx`, `apps/web/lib/admin/api/egress.test.ts`, registry tests                                                                                                                                                                                                                                                                                |
