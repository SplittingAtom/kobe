# KOBE-560: Shell: no line between the utility bar and the columns below

- **Status:** in review (PR #, group with KOBE-558 and KOBE-559)
- **Branch / worktree:** `kobe-558-icon-border` in `../Kobe-wt558`
- **Depends on:** none

## Plan

Chris (2026-11-07): "remove the line that separates the top bar and the 3 column section below".

## Decisions

- `shell.module.css` `.bar` lost its `border-bottom` (the only rule it had); the bar is shared by
  the chat and the consoles, so both lose the line. KOBE-554 (floating columns) builds on this.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- ac-1: the CSS module diff; screenshot baselines re-taken by the coordinator if the gate1
  console baseline run flags the bar edge; `pnpm verify`; PR CI.
