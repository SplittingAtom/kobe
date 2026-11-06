# KOBE-549: Tree: Browser checks on gate1 and ledger (CT-8)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (PR); specs passed on gate1
- **Branch / worktree:** `kobe-549-browser-checks` in `../Kobe-wt549`
- **Depends on:** KOBE-542..546 (on main), KOBE-547 (Compare, PR #454), KOBE-548 (summaries, PR #455)

## Plan

1. Specs (written, typechecked and linted only; this machine runs no Chromium):
   - `e2e/browser/tests/conversation-tree.spec.ts` (serial, one thread): Continue from here and the
     picker's "Version 2 of 2"; browse as owner (tree click, bar, ✕, Make it current, reload);
     a search hit on the inactive branch (head moves, leaf stays); member2 on the thread shared
     read-only (picker/tree move the head only, no Make it current, owner's leaf unchanged);
     labels (bold in the tree, "Version 1 of 2 · try 5% cut", member2 has no Label…, Remove label).
   - `e2e/browser/tests/conversation-tree-views.spec.ts` (serial, its own thread): the phone-width
     list by junction (chips, row menu); Compare versions (skips without the icon); the export zip
     (`branches/<…>/1-….md` with "Branched from message", `labels` in `threads.json`); Make it
     current and carry a summary (skips when not offered; runs last, it moves the leaf).
   - Helpers: `tests/support/tree.ts` (thread builder, tree/bar/picker steps, share, member2),
     `tests/support/zip.ts` (central-directory reader, no new dependency).
2. Deploy main to kobe-gate1 once 547 (and 548, if shipped) are merged; run in the Playwright
   container: `npx playwright test conversation-tree` with KOBE_USER/KOBE_PW and KOBE_USER2/KOBE_PW2.
3. Record results here with the image tag; then RUN-LEDGER, lane brief, audit-log rows (coordinator).

## Decisions

- Thread shape: ALPHA → answer, then two sibling prompts under that answer ("Branch <token>" asked
  first, "Branch CHARLIE" sent by Continue from here, so the leaf). Assertions are on the prompts
  and structure, never the model's words; `<token>` is letters only, unique per run, for search.
- Continue from here needs two prompts first: it is not offered on the leaf's own last answer.
- Each test leaves the leaf on the CHARLIE branch (Make it current back), so the serial tests share
  one thread per file; the summary test is last in its file.
- Sharing with member2 uses `POST /v1/threads/{id}/share` from the page (the share UI is covered by
  share.spec / thread-folders.spec); unshared in `afterAll`.
- The export is downloaded through the Threads panel's "Export my conversations" link and deleted
  from test-results afterwards (it holds the member's conversations).

## Open questions (for Chris or the coordinator)

- None open. The specs follow the shipped controls (merged `kobe-547-compare` and
  `kobe-548-branch-summary` here; one conflict in `tree-actions.tsx`, the `compare` case, resolved
  to 547's body with 548's `carry-summary` case kept): the bar's "More ways to make it current"
  menu → "and carry a summary", the dialog "Make it current and carry a summary" with Go, the
  `branch_summary` marker, the tree's "○ summary carried", Compare's "Version k[ · label]" columns.
  The web suite was not run here after that merge (light checks only).

## Evidence (acceptance criteria → test or command output)

- ac-1: main `cbaf76e1559a` deployed to kobe-gate1 as `local-cbaf76e1559a` (Helm rev 110, rollback
  `local-688f4360c7f5`), team reconcile failed:0. Browser run from the Playwright container on the
  build host as owner and second member: `conversation-tree.spec.ts` (5) and
  `conversation-tree-views.spec.ts` (4) + sign-in: **10 passed in 2.7 min**, nothing skipped (Compare
  and carry a summary ran against the deployed 547/548).
- ac-2: RUN-LEDGER "Current" entry and "Open problems" lines, lane brief status, audit-log row
  `thread.branch_summarized` (KOBE-548; labels are not audited by Q11); no infrastructure details in
  tracked files (CI's check and a grep of this diff).
