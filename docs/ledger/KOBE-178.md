# KOBE-178: 65c Auto-mode semantics: deny-don't-wait and skipped-action report

- **Status:** in review (PR # in the PR description)
- **Branch / worktree:** `kobe-178-auto-mode-deny` in `../Kobe-wt178`
- **Depends on:** KOBE-174, 176, 177 (all merged). No migration. FLAG: approvals/policy, Opus review.

## Plan

Tests first (`scheduled-auto-deny.db.test.ts`, new block in `mcp.db.test.ts`, `policy/skipped-summary.test.ts`,
`approvals/enforce-scheduled.test.ts`), then:

- `policy/skipped-actions.ts`: record (`recordSkippedActionInTx`) and load (`loadSkippedReport`) `run_skipped_actions`.
- `policy/skipped-summary.ts`: the template and `reportSkippedActionsInTx` (terminal event field + thread entry).
- Record at decision time in `sandbox-wire/policy-check.ts` (engine deny, unknown tool), `mcp/decide.ts` and
  `approvals/server-write.ts` (project writes).
- Guards: policy check, `ApprovalBrokerImpl` and `mcp/decide.ts` + `enforceMcpCall` never ask for a scheduled run.
- Report at run end in `sandbox-wire/run-state.ts` `endRunInTx` and `runs/store.ts` `applyTransition` (Stop).

## Decisions

- The policy engine already denies (never asks) for scheduled runs; nothing about interactive runs changed. The new
  guards only add refusals when `actor.kind = schedule` (and `auto` mode at the policy-check seam), after the engine.
- Recording is by the insert itself: `INSERT ... SELECT FROM runs WHERE trigger = 'schedule'`, so interactive runs and
  sandbox claims never create rows. Idempotent per tool call. At most `SKIPPED_ACTIONS_STORED_MAX` = 1000 rows per
  run; the terminal event lists the first `SKIPPED_ACTIONS_MAX` (100); the true count is `loadSkippedReport().count`
  for KOBE-179's `skipped_count`.
- Reason code = first engine reason (`scheduled_run_no_prompt`, or a deny-rule code when a deny rule applies).
- Report is written in the transaction that ends the run (event + thread entry commit with the terminal status), not in
  the post-commit `onTransition` listener: atomic, one writer, works on any replica. Names, risk, reason only.
- Thread summary: a server-written Pi-format `custom_message` entry (`customType` `kobe.skipped_actions`, `display`
  true, id `ks-<run id>`), parent = the thread's leaf, thread leaf NOT moved. Reason: `run.start.parent_entry_id`
  is the thread leaf and the sandbox agent branches from it, so the leaf must stay an entry Pi knows. The `get_entries
since` cursor (`lastMirroredEntryId`) skips these entries, otherwise Pi would reject `since` and force a restore.
  No entry when the thread has no leaf yet (the event field still carries the report).
- Covered terminal events: `run.completed|failed|interrupted` from the wire (`endRunInTx`) and from Stop
  (`applyTransition`). Not `run.budget_stopped` (no field in the KOBE-176 contract).
- MCP proxy: denials after the run is identified are recorded. Earlier refusals (connector off, unpinned, drifted, not
  exposed) are not tied to a run yet and those tools are not listed to the model anyway.

## Open questions (for Chris or the coordinator)

- Web (KOBE-181) must render `custom_message` entries with `customType = kobe.skipped_actions` and handle that the
  entry is a child of the leaf, a sibling of the next user message (branch picker), not on the active path.
- Alternative if that is unwanted: drop the entry and let web render the summary from `run.completed.skipped_actions`.
- 1000 stored rows per run is my choice.

## Evidence

- ac-1: `scheduled-auto-deny.db.test.ts` "denies at once, records it, completes the run, reports it ..." (no
  `policy.pending`, 0 approval rows, skipped row, event field, thread entry, leaf unchanged, cursor unchanged);
  "a run without skips ..."; "an interactive run still asks ...".
- ac-2: same file "a team allow rule lets a write run ... an ask or deny rule on top still wins".
- ac-3: `mcp.db.test.ts` "scheduled runs never wait for approval at the proxy" (signed approval cannot stand in, even
  with a stricter sibling run); `approvals/enforce-scheduled.test.ts`.
- Seam guards: "defence in depth at the approval-creation seam" (policy check, broker). Project writes:
  `memory-agent.db.test.ts` "never waits".
