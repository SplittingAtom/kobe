# KOBE-707: Split sandbox-wire/delivery.ts: frame building, memory plan, settlement

- **Status:** in review (group 64, branch `group-64-sandbox-wire-splits`)
- **Branch / worktree:** `group-64-sandbox-wire-splits` in `../Kobe-g64`
- **Depends on:** KOBE-706 (same directory, landed first in this group)

## Plan

Pure move, no behaviour change: `delivery.ts` keeps the queue (drain, poke), issued-command
bookkeeping, internal commands, session sync and settle; the rest moves to `sandbox-wire/delivery/`
as functions over a small `DeliveryEnv` (`{ ctx, host }`).

## Decisions

- **Layout (lines):** `delivery.ts` 1286 → 536. `delivery/preflight.ts` 164 (why an agent can't take
  a stored command), `claim.ts` 121 (the claim transaction: current connection, run lease, token),
  `frames.ts` 118 (stored command → wire frame, kept trace context, token added), `run-start.ts`
  112 (project mounts, memory, sync conflicts, fields an older agent did not announce),
  `memory-plan.ts` 127 (memory plan, Notes, semantic memory), `settle.ts` 324 (end of a refused or
  handled start, compaction, branch summary, tampered runtime; result recording), `env.ts` 8.
- **Exports keep their path:** `CommandDelivery`, `DeliveryHost`, `IssuedCommand`, `NotebookExec`
  stay in `delivery.ts`; `withoutAppCards` moved to `delivery/run-start.ts` and is re-exported from
  `delivery.ts`.
- **Same order everywhere.** The pre-claim checks run in the old order; the thread-context session
  restore now runs after the pure checks, which is the same because every check after it in the
  old order is for another command kind. The `run.start` fields are added and removed in the old
  order (so even the JSON key order is unchanged), and the memory/conflict records are set at the
  same points through callbacks. The two near-identical result handlers of KOBE-706 aside, nothing
  was merged or rewritten.
- The claim transaction's SQL is unchanged apart from leading whitespace (the function was split
  into `isCurrent` / `claimStart` to keep functions small).

## Docs

No `docs/guide/` change: a pure refactor; nothing a member, admin or in-sandbox agent sees or can
do changes.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1: `wc -l services/server/src/sandbox-wire/delivery.ts` → 536; importers unchanged
  (`connection.ts`, `notebook-intake.ts`, `frames/*`).
- ac-2: `sandbox-wire.db.test.ts`, `run-prompt.db.test.ts`, compaction and branch-summary tests run
  in `pnpm --filter @kobe/server test:db` (results in the group's final report).
