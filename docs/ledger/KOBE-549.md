# KOBE-549: Tree: Browser checks on gate1 and ledger (CT-8)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in progress (specs written; the gate1 run comes after main with KOBE-547/548 is deployed)
- **Branch / worktree:** `kobe-549-browser-checks` in `../Kobe-wt549`
- **Depends on:** KOBE-542..546 (on main), KOBE-547 (Compare, PR #454), KOBE-548 (summaries, in progress)

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

- KOBE-548's web is not built yet: the summary test looks for a `menuitem` /carry a summary/ in a
  menu button (`aria-haspopup="menu"`) in the bar, else in the tree's node menu, then a dialog with
  "Go" and the text "Summary of another branch"; adjust once 548's controls exist.
- If 548 turns the bar's "Make it current" into a split/menu button, `makeCurrentFromBar` (exact
  name "Make it current") may need the new name.

## Evidence (acceptance criteria → test or command output)

- ac-1 (gate1 run, image tag `local-<sha12>`): _pending_
- ac-2: _pending_
