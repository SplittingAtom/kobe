# KOBE-605: EA-4: Egress access browser spec, docs, gate1 values

- **Status:** spec, docs and values written; the coordinator deploys gate1 and runs the spec.
- **Branch:** `kobe-605-egress-spec` (contains KOBE-602/603/604).

## What changed

- `e2e/browser/tests/egress-access.spec.ts`: (a)+(b) member2 blocked off the ceiling, requests, the
  site admin approves in the Site console, the card shows it, the retry makes no new block; (c) an
  allowlisted cluster-ingress host (forbidden_address), approved as Internal from the card by the
  site admin, retry reaches it; (d) allowlisted private-resolving host stays blocked. Clean-up
  removes ceiling rows and team enablements it added, denies leftover requests, trashes threads.
- Docs: `docs/install.md` (Request access rewritten, new "Same-cluster hosts (Internal)", upgrade
  note for migration 0203 and `clusterIngress`, `allowedInternalCidrs` flagged as broader),
  `e2e/browser/README.md`, RUN-LEDGER entry. `docs/audit-log.md` already had every KOBE-602 row.

## gate1 values (placeholders; real values are in the local notes)

```yaml
egressProxy:
  clusterIngress:
    enabled: true
    addresses: [<INGRESS_LB_ADDRESS>/32]
    namespace: kube-system
    podSelector: { matchLabels: { app.kubernetes.io/name: traefik } }
    ports: [8443]
```

Deploy with `helm get values ... -o yaml` then `--reset-values` (never `--reuse-values`). After the
upgrade (migration 0203 runs), as site admin add `<INTERNAL_APPS_WILDCARD>` to the ceiling as
Internal and enable it for Team1 (AC-3). The spec's own hosts must NOT be covered by that wildcard:
pick `KOBE_EGRESS_INTERNAL_HOST` outside it (or temporarily remove the wildcard), else (c) skips.

## Spec environment

`KOBE_BASE_URL`, `KOBE_USER`/`KOBE_PW` (site admin and Team1 admin), `KOBE_USER2`/`KOBE_PW2`
(ordinary member), `KOBE_TEAM`, `KOBE_EGRESS_BLOCKED_HOST` (external, outside the ceiling),
`KOBE_EGRESS_INTERNAL_HOST` (on the cluster ingress, uncovered), `KOBE_EGRESS_PRIVATE_HOST` (private
address, not the ingress), optionally `KOBE_FAKE_MODEL=1`. Run: `npx playwright test egress-access`.
The scenario text assumes the status wording of KOBE-604 ("site admins were notified", "enabled
HOST"); adjust the spec if the card wording changed.
