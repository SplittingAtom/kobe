# KOBE-273: Tracing on gate1: Langfuse backend and end-to-end run traces

- **Status:** in review
- **Branch / worktree:** `kobe-273-tracing-langfuse` in `../Kobe-wt273`
- **Depends on:** KOBE-10 (tracing); user chose Langfuse on 2026-10-14

## Plan

Self-hosted Langfuse on the cluster as an ops-side install (not in the Kobe chart), then point the
gate1 install at it. Host names, credentials and install files are in `CLAUDE.local.md` only.

## Decisions

- **ClickHouse without the operator.** The Langfuse chart's bundled ClickHouse needs the ClickHouse
  operator's cluster-wide CRDs; on a shared cluster a single-node StatefulSet in the Langfuse
  namespace is enough (`CLICKHOUSE_CLUSTER_ENABLED=false`).
- **No cluster-wide RBAC.** The bundled SeaweedFS creates a ClusterRole with pod CRUD in every
  namespace (team sandbox namespaces included); turned off with
  `global.seaweedfs.createClusterRole: false`. Noted in `docs/tracing.md`.
- **Chart fix.** `modelGateway.networkPolicy` had no `extraEgress`, although `docs/tracing.md`
  told operators to use it: with `restrictEgress` on, the model gateway could not reach any
  collector, so the most useful spans (`model_gateway.request`, token counts) were dropped. Added
  the value (schema, defaults, template, render test). Fixed the stale `docs/operations/tracing.md`
  link in `values.yaml`.
- **Metadata only.** `captureContent` stays false on gate1.

## Open questions (for Chris or the coordinator)

- Health probes (`/readyz`, `/healthz`) and `POST /v1/sandbox/session` make up most spans: consider
  a sampler or a route deny-list for probes (follow-up, not this ticket).

## Evidence (acceptance criteria → test or command output)

- ac-1: Langfuse in its own namespace, gate1 exports with the key in a Secret (helm rev 57).
- ac-2: pending the model gateway rule (this chart change) and a chat run on gate1.
- ac-3: pending the same run: check no content attributes.
- ac-4: `values.yaml` link fixed; ops notes in `CLAUDE.local.md`.
