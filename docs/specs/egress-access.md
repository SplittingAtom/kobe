# Kobe — Egress access from the conversation (D28 follow-up)

Status: **in progress** (Chris's decisions of 2026-11-10 in §2; tickets KOBE-602..605 in §7, Hadron
spec 34074f6c).
Requested by Chris, 2026-11-10. Written against main `2784b71c` (gate1 `local-4436e1af08aa`), on top
of spec D28 (egress), U12 (Request access) and KOBE-468 (closable notices).

Request (Chris, 2026-11-10): when a conversation's sandbox is blocked from a URL, the blocked card
offers a button to **request access to the domain**; a **site admin can approve from that card**.
Also: domains **in the same cluster as Kobe** (served by its ingress) are blocked even when
allowlisted; allow them.

## 1. Today

- The proxy decides `effective(team) = team enablement ∩ site ceiling` (`decideEgress`,
  `packages/db/src/egress/domain.ts`). A bare pattern (`example.com`) matches only that host; `*.`
  patterns match subdomains at any depth.
- `egress.blocked` carries `{domain, request_access}`; `request_access` is true only when the host is
  in the ceiling (`not_enabled`). The card (`apps/web/components/chat/egress-notice.tsx`) then shows
  **Request access**, which notifies the team's admins; they decide in the Team console
  (`POST /v1/team/egress/requests/:id`). A host outside the ceiling (`not_in_ceiling`) gets no button
  and `POST /v1/egress/requests` refuses it.
- Internal addresses are refused by the shared address policy (`packages/address-policy`) unless in
  `egressProxy.allowedInternalCidrs` (install-wide, empty on gate1), and the proxy's NetworkPolicy
  excludes private ranges. On k3s a host on the cluster ingress resolves to the load balancer IP,
  which kube-proxy/servicelb DNATs to the ingress pods, so the proxy also needs a NetworkPolicy rule
  to those pods (the same as the MCP proxy's Catalyst fix, CLAUDE.local.md 2026-10-13).

## 2. Decisions (Chris, 2026-11-10)

- **EA1. Off-ceiling requests go to site admins.** Request access is offered for every blocked host.
  In the ceiling: the team's admins decide (as today). Outside it: the site admins decide, and
  approving adds the pattern to the ceiling **and** enables it for the requesting team in one step.
- **EA2. Approve in the card: site and team admins.** A site admin can approve any request from the
  card (ceiling + team enablement). A team admin can approve from the card a request whose pattern is
  already in the ceiling (team enablement only). Both can deny. Everyone else only requests.
- **EA3. The approver picks the pattern.** The card offers the exact host (default) or a parent
  wildcard of it (`*.<parent>`), never broader than the host's own parent chain, never a public
  suffix (`parseDomainPattern`), at least two labels after `*.`.
- **EA4. Same-cluster hosts: a per-domain internal flag.** A site admin marks a ceiling pattern
  **internal (same cluster)**. Only a host matched by an internal pattern may resolve to an internal
  address, and only to an address inside the install's configured internal targets (the cluster
  ingress); any other allowlisted host that resolves to a private address stays blocked
  (DNS-rebinding safe). The chart gains a cluster-ingress setting that produces both the internal
  target list and the proxy's NetworkPolicy rule.

## 3. Requests and approvals (EA1-EA3)

- **Protocol.** `egress.blocked` gains `reason` (`not_enabled`, `not_in_ceiling`,
  `forbidden_address`) and `request_access` becomes true for every reason a request can fix
  (all three; `forbidden_address` only when the host is a name, not an IP literal). Older clients
  keep working (additive).
- **Requests.** `POST /v1/egress/requests` accepts off-ceiling hosts; the request records
  `scope` `team` (pattern in the ceiling) or `site` (not), and `internal` (the block was
  `forbidden_address`). Site-scope requests notify every site admin (the existing notification
  outbox, D31 audit), team-scope requests notify team admins as today. One pending request per
  (member, pattern) still.
- **Decisions from the card.** `POST /v1/egress/requests/:id/decision {decision: approve|deny,
pattern?, internal?}`: a site admin may approve any request (upsert the ceiling row with
  `in_ceiling`, the chosen `pattern`, `internal` if asked, then enable it for the request's team); a
  team admin only a team-scope request (team enablement; `pattern` must be in the ceiling;
  `internal` refused). The pattern must cover the requested host (EA3). Approving or denying settles
  every pending request for that pattern in that team. The proxy's caches are invalidated as the
  consoles do today. Audited: `egress.request.created` (with scope), `egress.request.decided`,
  plus the existing ceiling and enablement events.
- **The card.** Shows Request access for every blocked host, with the right sentence ("your team
  admins" / "the site admins"). For a viewer who may decide it: **Approve** and **Deny**, a pattern
  choice (exact host first), and for a site admin on an internal block an **Internal (same
  cluster)** checkbox, checked by default for `forbidden_address`. After approving: "Enabled …. Ask
  the agent to try again." The member who asked sees the decision through the existing poll.
- **Consoles.** Site console › Egress lists site-scope requests next to the ceiling, with the same
  decision; each ceiling row shows and toggles **Internal**. Team console unchanged apart from the
  scope column.

## 4. Same-cluster hosts (EA4)

- **Data.** `egress_domains.internal boolean NOT NULL DEFAULT false` (site table). Only site admins
  set it (console or card).
- **Chart.** `egressProxy.clusterIngress: {enabled, addresses: [CIDR...], podSelector, namespace,
ports: [...]}`. When enabled: the proxy gets `KOBE_EGRESS_INTERNAL_TARGETS` (the addresses), its
  NetworkPolicy gets an egress rule to the ingress pods on those ports, and the addresses are not in
  its excluded ranges. `allowedInternalCidrs` stays for operators who want the old install-wide
  behaviour (documented as broader).
- **Proxy.** For a host whose matching pattern is internal, every resolved address must be either
  global (as today) or inside the internal targets; for any other host, internal addresses are
  refused as today. Metadata, loopback and link-local stay refused always. The decision and the
  reason (`forbidden_address`) are reported as today.
- **gate1.** Cluster ingress enabled for the load balancer address and the Traefik pods;
  the internal apps' wildcard (`*.apps.example.internal`-style, value in the local notes) added to the ceiling as internal and enabled for Team1
  (the loan-calc case), as a site admin's choice recorded in the gate notes.

## 5. Security notes

- No self-allow: a member's button only asks; deciding needs `site.egress.manage` or
  `team.egress.manage` on the server, whatever the UI shows.
- Internal reach is bounded twice: by the pattern's flag and by the install's internal targets, so a
  compromised allowlisted DNS name cannot reach arbitrary private ranges.
- The card never shows a URL or path, only the host (D28).

## 6. Out of scope

Headers per domain (existing), presets, IP-literal allowlisting, wildcard internal targets.

## 7. Tickets

- **EA-1 KOBE-602 (db, protocol, server):** migration (requests `scope`, `internal`; ceiling `internal`),
  `egress.blocked.reason`, requests off the ceiling, site-admin notifications, the decision route
  and its rules, audit, OpenAPI. Opus.
- **EA-2 KOBE-603 (egress-proxy, chart, address-policy):** internal patterns and internal targets in the
  proxy, `clusterIngress` in the chart (env, NetworkPolicy), `forbidden_address` reports with
  `request_access`. Opus.
- **EA-3 KOBE-604 (web):** the card (request for every block, Approve/Deny, pattern choice, internal), Site
  console requests and the Internal toggle. After EA-1.
- **EA-4 KOBE-605:** browser spec on gate1 (member requests off-ceiling; site admin approves from the card;
  internal host reachable; ordinary private-resolving host still blocked), docs (admin
  egress docs, install upgrade note), gate1 values, deploy. Last.
