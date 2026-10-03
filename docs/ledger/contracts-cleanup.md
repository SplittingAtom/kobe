# Contracts cleanup: approval floor key + agent-reported contract gaps

- **Status:** in review
- **Branch / worktree:** `chore-contracts-cleanup` in `../Kobe-wt-contracts2`
- **Depends on:** KOBE-24, KOBE-30, KOBE-35, KOBE-46 (merged); KOBE-36 (#32, open) reported items

## Scope

1. One approval floor: KOBE-24 read `install_settings['policy.approval_mode_floor']` plus a team floor
   `teams.settings.approval_mode_floor` (at run creation, Retry and every `policy.check`); KOBE-46
   read `install_settings['policy.approval_floor']` (at run start and agent publish).
2. Contract doc/schema fixes reported in docs/ledger/{contracts,KOBE-23,KOBE-24,KOBE-30,KOBE-35}.md
   and the KOBE-36 ledger (PR #32).

## Decisions

- **One install key: `policy.approval_floor`.** Neither key had a writer (no route, console page,
  seed or Helm value; the KOBE-20 "Policy floor" console edits rules and the sandbox-writes switch
  only), so nothing outside tests stored either. Chosen because its module
  (`services/server/src/policy/approval-floor.ts`) is the policy area's, already install-only by
  design and documented against D6/D19, and it fails closed without throwing (an unreadable value
  is `ask-all`). Every reader now uses `readApprovalFloor`: run creation and Retry
  (`runs/orchestrator.ts`), run start (`runs/agents.ts`), publish (`agents/floor.ts`), and
  `policy.check` (`createDbRunContextSource`). `APPROVAL_MODE_FLOOR_KEY`,
  `TEAM_APPROVAL_MODE_FLOOR` and `readApprovalModeFloor` are gone.
- **No team floor.** Spec D6 puts the policy floor ("deny rules and minimum approval mode") in the
  install-wide column; the team column has only "team ask/allow rules (can only tighten)". D19:
  "approval mode can only be stricter than the floor". Teams tighten through ask/deny rules (an
  `ask` rule on `*` is the team equivalent of `ask-all`). The team floor was removed.
- **Behaviour change on an invalid floor:** KOBE-24 threw (policy check denied, run creation
  errored); now it is `ask-all` everywhere (calls need approval, which the default broker denies).
  Still fail closed, and a run can still be created.
- **Migration `0024_approval_floor_unify`** (custom, idempotent): `policy.approval_floor` = the
  stricter of both stored install values (unreadable → `ask-all`); deletes
  `policy.approval_mode_floor`; strips `approval_mode_floor` from every `teams.settings`. Team
  floors are dropped, not converted: no writer existed, so only hand-written SQL could have set one.
  Not audited (a data migration, no actor; nothing changes for an install that never set a floor).
- **Reason codes (appended, backward compatible):** `team_allow_rule`, `not_available`,
  `policy_error`, `run_not_active`, `not_a_member`, `sandbox_policy_unavailable` (sandbox-side
  denies; KOBE-36's suggested name). No new stage: pre-pipeline denials carry `install_deny`,
  team allow-listing `user_allow`, `not_available` `team_deny`. Server switched from its
  stand-ins: engine internal error → `policy_error`; team allow → `team_allow_rule`; MCP resource
  tools → `not_available`; `policy.check` run gone/ended/not this sandbox's → `run_not_active`,
  deactivated/removed → `not_a_member`, floor unavailable / overload / exception → `policy_error`.
  kobe-sandbox-agent (KOBE-23) answers local denies on its fd-3 channel with `reasons: []`, which
  never reach the server, so nothing to switch there; KOBE-36 can use `sandbox_policy_unavailable`.
- **`fork`** removed from `piBridgeCommandSchema`; the agent's own refusal is gone (the decoder
  refuses the frame as `malformed_frame`).
- **`checkRetry`:** optional `started_at` on `RetryCandidate`; `null` (never started) is skipped
  for "latest run that ran"; omitted = treated as started (the server pre-filters in SQL, as before).
- **Frame caps** moved into the contract: `SANDBOX_SMALL_FRAME_MAX_BYTES` (256 KiB),
  `SANDBOX_FRAME_MAX_BYTES_BY_TYPE` (`pi.event`/`command.result` 4 MiB, `policy.check` 1 MiB); the
  server's `WIRE_DEFAULTS.frameMaxBytes` takes `policyCheck` and `small` from them (one source of
  truth). Large frames must start with `v`, `type`. KOBE-36's kobe-policy caps at 1 MiB − 4 KiB
  (envelope room), noted on `policyCheckFrameSchema`. Test: `frames.test.ts` "states the per-type
  frame caps".
- **Event payload bounds** aligned with the server: payload ≤ 256 KiB (`EVENT_PAYLOAD_MAX_BYTES`,
  `parseEventPayload` throws `EventPayloadTooLargeError`; append maps it to `payload_too_large`),
  `tool.call.input` ≤ 64 KiB, `entry.committed.payload` ≤ 64 KiB. Not applied to
  `toolInputSchema` itself (policy checks carry inputs up to 1 MiB).
- Docs only: `session.restore` (one result per part, header optional, cwd rewritten),
  `kobe.event_dropped` (`KOBE_EVENT_DROPPED_TYPE`, `kobeEventDroppedSchema`, used by the agent),
  `pi.ui_request` dedupe by `(thread_id, request.id)`, kobe-policy freezes (does not replace)
  `event.input`, the approval token never enters the sandbox, `primary_arg` of grep/find = `/path`
  (server override removed).

## Open questions (for Chris or the coordinator)

1. An admin control for the install approval floor (`/v1/install/policy/settings` + the KOBE-20
   console) does not exist yet; follow-up for the policy console.
2. `approval.requested.input` is bounded only by the 256 KiB payload cap; a large `write` needing
   approval won't fit an event (KOBE-37 must store it by reference).

## Evidence

- `packages/db/src/approval-floor-migration.db.test.ts` (6): both keys, stricter wins, invalid →
  `ask-all`, no floor stays none, team floors stripped with other settings kept.
- `services/server/src/sandbox-wire.db.test.ts` "applies the install approval floor (no team floor,
  D6) and fails closed on an invalid one"; late `policy.check` → `run_not_active`; removed member →
  `not_a_member`. `runs.db.test.ts` / `runs-review.db.test.ts`: creation and Retry clamp to
  `policy.approval_floor`. `policy/engine.test.ts`: `policy_error`; `evaluate.test.ts`:
  `team_allow_rule`, `not_available`.
- `packages/protocol`: `frames.test.ts` (fork refused, event_dropped, frame caps), `policy.test.ts`
  (codes, primary args), `events.test.ts` (payload bounds), `runs.test.ts` (never-started runs).
- Commands: build, typecheck, lint (all but the pre-existing local `@kobe/chart` Helm 4 failure),
  format:check, `pnpm test --concurrency=2 -- --maxWorkers=3`, `@kobe/db test:db` 287/287, server
  db suites touched 158/158, hygiene ok. `license:check` fails locally only on the pre-existing
  `vitest@5.0.3 Unknown` entry (same as main).
