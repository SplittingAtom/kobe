# KOBE-584: Session info shows the conversation's reasoning spend

- **Status:** in review (PR #491)
- **Branch / worktree:** `kobe-584-session-reasoning` in `../Kobe-wt584`
- **Depends on:** KOBE-557 (reasoning tokens in the usage API), KOBE-574 (removed composer readout)

## Plan

Two rows after "Output tokens" in `/session`: "Thinking tokens" and "Last run". Web only; the
usage API already carries `reasoningTokens`, `reasoningEstimated`, `thinkingLevel`.

## Decisions

- Helpers live in `apps/web/components/chat/session-reasoning.ts` as plain functions:
  `thinkingControl`, `latestReasoning` and `reasoningSpend` restored from before PR #483, plus
  `reasoningTotal`, `thinkingTokensLine`, `lastRunLine`. `sum()` in session-info.tsx stays typed
  without `reasoningTokens`, so the reasoning sum stays separate from the output sum.
- `reasoningSpend` now also returns null at budget 0 (Off), so "Last run" reads "—" there.
- A counted 0 is a count ("0"), not unknown; ≈ only follows counted runs.
- Level reads "Off/Low/Medium/High" in "Last run" (the Thinking row keeps "Thinking medium").
- The tooltip (`title`) sits on the Thinking tokens term and value.

## Open questions (for Chris or the coordinator)

- Coordinator: ac-2 check on gate1 (a Medium run on the Ollama model, estimate path).

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/chat/session-info.test.tsx` (none, some, null runs, estimated,
  latest run with and without control/budget, Off, live run excluded, thinkingControl).
- ac-2: coordinator, in the browser.
- ac-3: docs/design/thinking-controls.md ("Where the spend shows"), docs/ledger/KOBE-574.md;
  `pnpm verify` and PR CI.
