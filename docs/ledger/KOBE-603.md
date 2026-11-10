# KOBE-603: EA-2: Same-cluster hosts: internal patterns and cluster-ingress targets

- **Status:** in review (branch commit, not pushed)
- **Branch / worktree:** `kobe-603-egress` in `../Kobe-wt603`
- **Depends on:** KOBE-602 (column `egress_domains.internal`, `egress.blocked.reason` in the
  protocol and relay). Spec: `docs/specs/egress-access.md` §3 (proxy part), §4.

## Rule (proxy, `@kobe/address-policy`)

An address is allowed when it is in `allowedInternal` (legacy, install-wide), or global (in no
denied range), or the host's matching (effective) pattern is internal **and** the address is in
`KOBE_EGRESS_INTERNAL_TARGETS` **and** not in `ALWAYS_DENIED_CIDRS` (0/8, 127/8, 169.254/16,
100.100.100.200, multicast, broadcast, ::/96, ::1, ::ffff:0:0/96, 64:ff9b::/96, 64:ff9b:1::/48,
2002::/16, fd00:ec2::254, fe80::/10, fec0::/10, ff00::/8). Every resolved address must pass (one
outside the targets refuses the name); the proxy still resolves once and connects only to a
checked address. The internal flag comes from the pattern that decided (`findMatchingPattern`:
exact host first, then the most specific wildcard), so an exact non-internal pattern beats an
internal wildcard.

## Decisions

- Ceiling query (egress-proxy `src/ceiling-store.ts`, one round trip):
  `SELECT d.domain, COALESCE((to_jsonb(d) ->> 'internal')::boolean, false) AS internal FROM egress_domains d WHERE d.in_ceiling`.
  `to_jsonb(row)` tolerates the column's absence (reads false, fails closed), so this branch works
  with or without KOBE-602's migration. After both merge the coordinator may switch to
  `egressDomains.internal` once the Drizzle column exists (optional).
- `AllowlistCache` source `loadCeiling()` returns `CeilingPattern[]` (`string | {domain, internal}`);
  decisions carry `internal: true` only when true, so existing decision shapes are unchanged.
- Always-refused ranges apply to internal targets only, not to the legacy `allowedInternal`
  (mcp-proxy, server connector and proxy tests list 127.0.0.0/8 there).
- Startup validation (zod `superRefine`): every target a CIDR and none whose network address is
  always refused (`0.0.0.0/0`, `::/0`, loopback, link-local, metadata, IPv4-embedding).
- Internal targets also win over `deniedCidrs` (denied → then the internal-target check).
- Open tunnels that reached an internal target are tagged; a re-check closes them once their
  pattern is no longer internal (tunnels to global addresses stay).
- Reports: `requestAccess: true` for `not_enabled`, `not_in_ceiling` (EA1) and `forbidden_address`
  (always a host name here: IP literals are refused earlier as `invalid_target`), CONNECT and the
  KOBE-39 upgrade path. `reason` was already in the `events.ref` the proxy writes.
- Chart `egressProxy.clusterIngress {enabled, addresses, podSelector, namespace, ports}`: env
  `KOBE_EGRESS_INTERNAL_TARGETS`; NetworkPolicy rules: ipBlock per address on `allowedPorts`
  (a rule of its own, so the internet rule's private `except` does not hide them) and
  namespaceSelector (`kubernetes.io/metadata.name`) + podSelector (a LabelSelector) on `ports`
  (pods' post-DNAT ports, e.g. 8443). Enabled without all four: schema and template both refuse.

## For the coordinator (reconcile with KOBE-602)

- `services/server/src/egress/blocked-relay.ts` `refSchema` is a non-strict `z.object`: the
  `reason` already in the ref passes, but the relay forwards only `{domain, request_access}`;
  KOBE-602 must forward `reason` once `egress.blocked` (strictObject in `packages/protocol`) has it.
- Before KOBE-602's server changes, `request_access: true` for `not_in_ceiling`/`forbidden_address`
  would show a button whose `POST /v1/egress/requests` is refused; merge both together.

## Evidence

- ac-1: `services/egress-proxy/src/proxy.test.ts` "internal patterns and internal targets";
  `packages/address-policy/src/index.test.ts` "internal targets".
- ac-2: `charts/kobe/tests/egress.test.ts` "same-cluster hosts: clusterIngress" (off and on).
- ac-3: mixed global/internal and mixed target/outside resolution in both suites, IPv6 targets.
- Runs: address-policy 13/13, egress-proxy 119/119, egress-proxy test:db 8/8, chart 231/231,
  helm lint ok, public hygiene ok.
