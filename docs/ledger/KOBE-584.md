# KOBE-584: Session info shows the conversation's reasoning spend

- **Status:** in review (PR #491)
- **Branch / worktree:** `kobe-584-session-reasoning` in `../Kobe-wt584`
- **Depends on:** KOBE-557 (reasoning tokens in the usage API), KOBE-574 (removed composer readout)

## Plan

Two rows after "Output tokens" in `/session`: "Thinking tokens" and "Last run". Web only; the
usage API already carries `reasoningTokens`, `reasoningEstimated`, `thinkingLevel`.

## Decisions

- Helpers live in `apps/web/components/chat/session-reasoning.ts` as plain functions:
  `latestReasoning` restored from before PR #483, plus `reasoningTotal`, `thinkingTokensLine`,
  `runControl`, `pendingRunId`, `lastRun`. `sum()` in session-info.tsx stays typed without
  `reasoningTokens`, so the reasoning sum stays separate from the output sum.
- A counted 0 is a count ("0"), not unknown; ≈ only follows counted runs.
- Code review (PR #491), all fixed: "Last run" uses the control of the run's model
  (`latestCall.model` against the team list's `gatewayModel`, falling back to the site policy for a
  disabled model; unmapped: "<spent> at <Level>"). "of <budget>" only for anthropic_budget /
  gemini_budget; effort controls show "<spent> at <Level>" with a "typical scale … not a limit"
  title. A counted run at Off reads "<spent> at Off". The live run hides the row only while open
  or until the read after it lands. `thinkingChoices` returns `control`; the duplicate
  `thinkingControl` was dropped. Test fixtures are typed.
- The tooltip (`title`) sits on the row's term and value.

## Open questions (for Chris or the coordinator)

- Coordinator: ac-2 check on gate1 (a Medium run on the Ollama model, estimate path).

## Evidence (acceptance criteria → test or command output)

- ac-1: `apps/web/components/chat/session-info.test.tsx` (none, some, null runs, estimated,
  latest run with and without control/budget, Off, live run excluded, thinkingControl).
- ac-2: coordinator, in the browser.
- ac-3: docs/design/thinking-controls.md ("Where the spend shows"), docs/ledger/KOBE-574.md;
  `pnpm verify` and PR CI.
