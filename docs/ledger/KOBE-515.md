# KOBE-515: PodDisruptionBudget and topology spread for replicated workloads

- `kobe.topologySpread` and `kobe.podDisruptionBudget` helpers in `charts/kobe/templates/_helpers.tpl`,
  applied by `kobe.nodeService` to web, server, scheduler, mcp-proxy, egress-proxy and model-gateway;
  both render only while `replicas > 1`. The hand-written server PDB in `services.yaml` is replaced
  by the generated one (same name, `kobe-server`).
- Spread: `maxSkew: 1`, `whenUnsatisfiable: ScheduleAnyway`, selector labels plus
  `matchLabelKeys: [pod-template-hash]` (rolling updates spread the new ReplicaSet too).
- Values per component: `podDisruptionBudget.enabled`, `topologySpread.enabled`,
  `topologySpread.topologyKey` (default `kubernetes.io/hostname`); schema `$defs` shared.
- Bifrost excluded: the schema pins it to one replica (its own store).
- Tests: `charts/kobe/tests/replicated-workloads.test.ts`; docs: install.md "Replicas, disruption
  budgets and spread".
- ac-2 (k3d e2e, gate1 upgrade on 4 nodes) is left for the group's deploy.
