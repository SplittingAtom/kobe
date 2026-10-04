# KOBE-39: Request access and per-team header injection

- **Status:** in review
- **Branch / worktree:** `kobe-39-request-access` in `../Kobe-wt39`
- **Depends on:** KOBE-38 (egress proxy), KOBE-20 (consoles), KOBE-15 (audit), KOBE-41 (runtime dir
  pattern), all merged

## Acceptance (coordinator brief, spec D28, U12, Gate 2)

1. **Request access:** from a blocked request the user clicks Request access in the chat notice;
   the team admin is notified (domain + thread metadata only), approves (enables the domain within
   the install ceiling) or denies; the user is notified; everything audited; no self-allow.
2. **Header injection:** team admins configure headers per enabled domain, sealed with a dedicated
   key purpose, write-only; the proxy's upgrade path (plain HTTP from the sandbox → verified HTTPS
   upstream, no TLS interception, no Kobe CA); client copies stripped; https only upstream with SNI
   and certificate verification; private-IP/rebinding protection; redirects re-checked; size and
   time limits; config changes audited, never values.
3. **BASH_ENV egress for tools** (KOBE-38 open question 2), following KOBE-41's per-process files.
4. **Gate 2:** "blocked domain → request access → enablement works", end to end in `e2e/run.sh`.

## Design

### Request access

- **DB** (team tables, `tenancy/policy.ts`; migrations `0041_egress_requests` generated,
  `0042_egress_requests_rls` RLS): `egress_requests` (team_id, id, `domain` = blocked host,
  `pattern` = the ceiling pattern approving enables, `requested_by`, `thread_id?`, status
  pending/approved/denied, decided_by/at; one pending per (member, pattern) by partial unique
  index) and `egress_request_notifications` (email outbox, ids only, FK (team_id, request_id)).
- **Server** `egress/request-store.ts`: `createEgressRequest` (host → ceiling pattern; refuses
  outside the ceiling, already enabled, another member's or unknown thread; dedupes a pending one;
  20 pending / 10 per hour per member; queues one email per active team admin except the
  requester; audits `egress.request.created`), `decideEgressRequest` (row lock; approve takes the
  ceiling row FOR SHARE, inserts `team_egress`, NOTIFY, audits `egress.domain.enabled` when new;
  settles **every** pending request for the pattern and queues the requesters' emails; audits
  `egress.request.decided` last), list team / list mine.
- **Routes:** `POST|GET /v1/egress/requests` (member, `team.chat`; mounted in `app.ts`),
  `GET /v1/team/egress/requests`, `POST /v1/team/egress/requests/:id {decision}`
  (`team.egress.manage`).
- **Notifications** `egress/request-notify.ts`: at-least-once delivery like break-glass (lease,
  SKIP LOCKED per team under RLS, backoff, give up after 8 → logged); delivered in the background
  right after the request/decision and by a 60 s sweep (`EgressRequestSweeper`, server process).
  In-app: the team console's request list and the chat notice's status.
- **Web:** `components/chat/egress-notice.tsx` — the `egress.blocked` notice gets **Request access**
  (only when `request_access`), posts `{domain, thread_id}`, reads the member's request back on
  mount, polls while pending, shows approved / denied / already enabled / errors. Team console →
  Egress: `egress-requests.tsx` (Approve / Deny) above the domain table.

### Header injection (upgrade design, user decision 2026-10-03)

- **Storage:** `team_egress.header_names text[]` (clear, for the consoles) and `headers_sealed`
  (SecretBox, purpose `egress-headers`, AAD `egress-headers:<team>:<domain>`; check constraint keeps
  names and seal together, ≤ 8). `packages/db/src/egress/header-rules.ts`: name/value validation
  (RFC 9110 token; `Host`, `Content-Length`, `Connection`, `Proxy-*`, `X-Forwarded-*`, `X-Kobe-*` …
  refused; values visible ASCII, no CR/LF), seal/open. Disabling the domain deletes them.
- **Secret:** `KOBE_EGRESS_HEADER_SECRET` (+ `_PREVIOUS`), chart Secret `<release>-egress-headers`
  (generated, kept; or `egressProxy.headerSecret`), given to the server and the egress proxy only
  (chart test asserts scheduler, MCP proxy, model gateway, web get none). Unset: the API answers
  503 `header_injection_unavailable` and plain HTTP stays refused everywhere.
- **API:** `PUT /v1/team/egress/domains/:domain/headers {headers:[{name,value}]}` replaces the list,
  `DELETE …/headers`; `GET /v1/team/egress` lists `header_names` only. Audit `egress.header.set`
  (`domain`, `headerNames`) / `egress.header.cleared` — never values. NOTIFY team hint.
- **Proxy** `services/egress-proxy/src/upgrade.ts` (absolute-form requests): token → target
  (`http://name[:80]/…` only; no IP literal, no userinfo) → connection slot → membership +
  allowlist (refusal = the same `egress.blocked` with request access) → **header rules required**
  (else 403 `plain_http`) → open the sealed list (503 on failure) → request-size check → resolve
  once, every address must pass the address policy → TCP to a checked address on 443 → TLS by the
  proxy: SNI = host, `rejectUnauthorized`, `checkServerIdentity(host)` (system CAs; a test-only
  `upstreamCa` seam) → upstream request: client headers minus hop-by-hop, `Proxy-*`, names listed
  in `Connection`, and any header named like an injected one; `Host` set; injected headers added →
  response relayed minus hop-by-hop and minus any header containing an injected value; same-host
  `https://` `Location` rewritten to `http://`, other hosts passed through (the client's next
  request is checked as its own); `Connection: close`. Limits: request body 100 MiB, response
  2 GiB, whole exchange 600 s (`egressProxy.upgrade.*`), idle timeout, per-sandbox bandwidth; open
  requests are registered with the tunnel registry (revocation cuts them). Audit: same aggregated
  `egress.connection` with `upgraded: true` and new reasons `headers_required`, `upstream_tls`,
  `upstream_timeout`, `request_too_large`, `response_too_large`.
- **CONNECT to a header domain** is refused 403 `headers_required` with the phrase
  `use http://<host> (team credentials are injected)`: a tunnel can't carry the headers, and the
  message tells the tool/model what to do.
- **Pointing tools at `http://`** (decision): explicit `http://` URLs — the least surprising
  option (the URL says what happens; nothing in the sandbox is rewritten behind the user). Documented
  per tool in `docs/install.md` → Header injection: pip `--index-url http://… --trusted-host …`,
  npm `--registry http://…`, git `-c url."http://host/".insteadOf="https://host/"`, curl
  `http://…`. Rejected: per-domain proxy env (tools don't support it), automatic git/pip config
  (would need the header domain list in the sandbox and a protocol/agent change; can come later).

### Egress for Pi's tools (BASH_ENV)

- `services/sandbox-agent/src/egress/egress-wiring.ts`: per Pi process, `<runtimeDir>/egress-token`
  (0600, random temp + `wx` + rename, JWT charset only), rewritten on rotation (a second
  `ModelTokenKeeper` over `SessionClient.egressProxyGrant()`; same grant, no extra trades). Pi's env
  gets `BASH_ENV=/opt/kobe/egress-env.sh`, `KOBE_EGRESS_TOKEN_FILE`, `KOBE_EGRESS_PROXY`
  (`http://host:port`, port always written), `KOBE_THREAD_ID` (UUID only), `NO_PROXY`. The tripwire
  (`runtime-dir.ts`) accepts `egress-token` and its temp file (regular files only).
- `images/sandbox/egress-env.sh` (root-owned 0444, checked by the agent like the extensions):
  `read` builtin (no process/argv), charset check (else exports nothing), exports `HTTPS_PROXY`,
  `HTTP_PROXY` (+ lowercase) = `http://<thread>:<token>@<proxy>`; pauses `set -x` while it runs.
- Found while testing: **bash skips `BASH_ENV` when its stdin is a socket** (it assumes rshd/sshd and
  reads `~/.bashrc` instead). Pi spawns bash with stdin `ignore` (/dev/null), so it works (real-Pi
  test); child processes inherit the exported variables anyway.

## Decisions

- **Request notifications = email + in-app** (no generic notification system exists): email outbox
  per recipient; in-app is the console list and the chat notice. Admins acting on their own request
  get no email (self excluded), like break-glass.
- **Approval settles all pending requests for the pattern** (each requester told); approval outside
  the ceiling is refused (409) and the request stays pending (the admin can deny it).
- **Requests name the ceiling pattern**, so a wildcard `*.example.com` in the ceiling is what gets
  enabled for `a.example.com` — consistent with KOBE-38's "teams enable exactly a ceiling pattern".
- **Thread metadata = thread id only** in emails and the console (titles are content).
- **Absolute `https://` links in bodies are not rewritten** (documented limitation with
  workarounds; no body rewriting).
- **Response header echo is filtered; body echo is not** (documented trust boundary: configure
  headers only for domains trusted with that credential).
- **One request per upgraded connection** (`Connection: close`): authenticated sockets leave the
  pre-auth budget, so they must not idle afterwards.
- The fake model (e2e) gained a scripted `bash` tool call (`bash: <command>`), so the Gate 2 story
  runs a real tool through real Pi in the Owner's real sandbox.

## Coordinator security review of PR #60 (0 CRITICAL/HIGH) — resolution

1. MEDIUM token file mode: `EgressTokenFile(path, mode)` sets the mode exactly (chmod after the
   umask; 0640 under a KOBE-71 Pi identity) and has `verify()` (regular file, mode, exact token);
   the tripwire checks it (`runtime_tampered`). `egress-env.sh` prints one stderr line when the
   token file is missing, unreadable or malformed. Tests: `egress-wiring.test.ts`,
   `agent.egress.test.ts` "stops a Pi whose egress token file was rewritten".
2. MEDIUM quota race: `pg_advisory_xact_lock` on (team, user) first, then on (team, pattern).
   Test: "parallel requests can't pass the hourly quota".
3. MEDIUM absolute `https://` links in registry bodies: documented with workarounds
   (`docs/install.md` → Header injection → Limitation); bodies are not rewritten.
4. LOW echo filter also matches the credential without its scheme (`secretParts`).
5. LOW decisions on one pattern serialise on its advisory lock (no deadlock). Test: "parallel
   decisions on one pattern don't deadlock".
6. LOW enabling a domain directly settles its pending requests (approved, requesters emailed,
   `egress.request.decided` audited); creation takes the pattern lock, so it can't interleave
   with a decision or enablement. Test: "enabling a domain directly settles…".
7. LOW delivery re-checks the recipient is still a member (and a team admin for new requests);
   otherwise `skipped` / `recipient_not_entitled`.
8. LOW the request drop list compares normalised names (`Content_Length` = `Content-Length`).

- Edge-case tests added: CL+TE (400), duplicate and underscore copies, `Connection:` naming an
  injected header, mixed-case and trailing-dot hosts, redirects to another port or to http://,
  HEAD and 304.
- 8 (noted): the notification sweep walks every team each minute (one claim query per team); fine
  for one organisation's teams, revisit with an index-only "teams with due rows" query if it grows.
- 11 (noted): the thread hint (proxy user part) is self-asserted by the sandbox; it only picks
  among the same user's runs on the same sandbox (KOBE-38), never another user's.
- 12 (done, cheap): values sealed with `secret-previous` are re-sealed with the current secret at
  server start-up (`resealTeamHeaders`). Test: "re-seals values sealed with a previous secret".

## Open questions (for Chris or the coordinator)

1. Automatic tool configuration for header domains (pip trusted host, git insteadOf) would need the
   header-domain list in the sandbox (session grant or wire); not built (decision above).
2. The e2e Owner both requests and approves (the e2e has no second password user); "members can't
   decide" is covered by `egress-requests.db.test.ts`.

## For downstream tickets

- **KOBE-63 (web search):** the provider's API key can be a header rule on the provider's domain
  (`web_search` preset) if the search tool calls it over `http://` through the proxy; or keep it
  server-side. `deps.egressHeaders` / `headerBox()` exist.
- **KOBE-2 (Gate 2):** the criterion runs in `e2e/run.sh` "request access and header injection".
- **KOBE-71 (privilege separation):** the egress token file has the same same-uid limits as
  KOBE-41's model file (readable/rewritable by the sandbox user; it is the sandbox's own token).

## Evidence

| Item                                                     | Evidence                                                                                                                                                                                                                                                        |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request → admin notified (domain + thread), audited      | `services/server/src/egress-requests.db.test.ts` "a member asks for a blocked host…", "asking again…", "a wildcard ceiling pattern…", "retries a failed email from the sweep"                                                                                   |
| No self-allow; team-scoped                               | same file "members can't decide or list the team's requests", "refuses hosts outside the ceiling, junk, and other users' or unknown threads", rate limit                                                                                                        |
| Approve enables (NOTIFY), deny, users notified           | same file "the team admin approves…", "the team admin denies…", "approval fails while the pattern is out of the ceiling"                                                                                                                                        |
| Chat Request access                                      | `apps/web/components/chat/egress-notice.test.tsx`; `conversation.test.tsx` "Request access asks the team's admins with the thread's id…"                                                                                                                        |
| Console requests and headers                             | `apps/web/components/admin/egress-pages.test.tsx` "approves an access request…", "sets injected headers write-only…"                                                                                                                                            |
| Headers sealed, write-only, names-only audit             | `egress-requests.db.test.ts` header suite; `packages/db/src/egress/header-rules.test.ts`; `packages/db/src/egress.db.test.ts` "injected headers (KOBE-39)"                                                                                                      |
| Upgrade path (inject, strip, TLS verify, SNI, rebinding) | `services/egress-proxy/src/upgrade.test.ts` (17): injection + stripping + SNI, cert for another name → 502 and no request, internal address, 407/ports/IP/userinfo, redirects, echoed header dropped, size/time limits, CONNECT refused, off without the secret |
| Header cache invalidation                                | `services/egress-proxy/src/allowlist.test.ts` "sealedHeaders"                                                                                                                                                                                                   |
| BASH_ENV egress                                          | `egress/egress-wiring.test.ts` (script with bash, rotation, injection-safe, xtrace), `agent.egress.test.ts`, `egress.real-pi.test.ts` (real Pi bash tool sees HTTPS_PROXY), `runtime-dir.test.ts`, `config.test.ts`; `images/sandbox/test-image.sh` checks      |
| Chart                                                    | `charts/kobe/tests/egress.test.ts` "header injection secret (KOBE-39)", `render.test.ts` offline-render secrets                                                                                                                                                 |
| Gate 2 e2e                                               | `e2e/run.sh` "request access and header injection (KOBE-39)": real sandbox, real Pi bash → curl blocked → `egress.blocked` on the run → request → approve → same tool succeeds; header CONNECT refused; upgrade verifies the upstream certificate               |
