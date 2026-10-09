# KOBE-170: G2a: e2e/gate2.sh — Phase 2 safety gate, five criteria end to end

- **Status:** in progress
- **Branch / worktree:** `kobe-170-gate2-script` in `../Kobe-wt170`
- **Depends on:** none (KOBE-39/42/58/132 merged)

## Plan

`e2e/gate2.sh` modelled on gate1.sh: own team `gate2-a`, three users, step per criterion, ok/FAIL
lines. Client steps run in a server pod (`e2e/gate2/client.mjs`, appended to the Gate 1 client's
helpers). Docs: `docs/gates/gate-2.md`. CI: new shard `gate2` (same install as `gate1`).

## Decisions

- Shared helpers moved out of gate1.sh to `e2e/lib/gate-common.sh`; the fake MCP server out of
  run.sh to `e2e/lib/fake-mcp.js` (both scripts read it).
- New shard instead of extending `gate1`: gate1 is the slowest shard already; gate2 rolls the server
  once (proxy allow-lists) and runs in parallel on its own cluster.
- ac-3 tamper: file tampering attempts inside the real sandbox container, plus direct calls to the
  MCP proxy from it (what a policy-less extension is), signed approval written as in run.sh.
- ac-5: secrets from K8s Secrets + sealed provider keys, CI side only; the sandbox's own Kobe JWTs
  are classified and allowed; canary controls.
- No break-glass e2e existed; ac-4 is API-only (the DB tests cover the rest).

## Open questions (for Chris or the coordinator)

- Real-cluster run needs `KOBE_GATE2_CHART` = the chart on compute1 and a real model prompt (docs).

## Evidence (acceptance criteria → test or command output)

- ac-1 (all five criteria in CI on k3d): see PR / docs/gates/gate-2.md "Results".
- ac-2 (targets an existing install, prints evidence): `KOBE_GATE2_*` variables, docs/gates/gate-2.md.
