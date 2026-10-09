# KOBE-134: Flaky e2e: gate1 shard gets "wget: bad address traefik.kube-system"

- **Status:** in review
- **Branch / worktree:** `kobe-134-traefik-dns-flake` in `../Kobe-wt134`
- **Depends on:** none

## Plan

Wait in e2e prerequisites for CoreDNS and Traefik (Deployment created, rolled out, Service exists).

## Decisions

- Root cause (run 37661282852): k3s' bundled Traefik is installed by `helm-install-traefik`, which retried 6 times;
  the Traefik pod was only 82 s old at the end of the run, so Service `traefik` did not exist for ~4 min.
  `retry` does retry resolution failures, but only for REACH_TIMEOUT (60 s), and `wait_endpoints` just warns.
  The "can't connect" in cold-start run 37775411279 is the same race (Service exists, no ready pod yet).
- Fix: condition waits (`kubectl wait --for=create`, `rollout status`) with bound `INFRA_TIMEOUT` (420 s).
  Assertions unchanged.

## Open questions (for Chris or the coordinator)

- ac-1 (10 consecutive green gate1 runs) can only be confirmed over time.

## Evidence (acceptance criteria → test or command output)

- CI e2e on the PR.
