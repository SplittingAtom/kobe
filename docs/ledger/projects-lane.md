# Projects in conversations lane (KOBE-587..593 + KOBE-586, gate KOBE-594)

<!-- The lane's record for the coordinator; details in each ticket's ledger. -->

- **Spec:** `docs/specs/projects-in-conversations.md` (Chris's decisions of 2026-11-09 in §11; it
  builds on `docs/specs/workspaces.md`, whose gate KOBE-583 Chris approved on 2026-11-09).
- **Tickets:** PC-0 KOBE-587 remove restricted visibility (the lane's only migration) → KOBE-586
  promote a My files folder (with mount on create) → PC-4 KOBE-591 proposals for project files,
  Accept commits; web PC-1 KOBE-588 new conversation header → PC-2 KOBE-589 title → PC-3 KOBE-590
  Files panel list → PC-5 KOBE-592 proposal card; PC-6 KOBE-593 browser spec and docs last. Gate
  KOBE-594 (`docs/gates/gate-projects-in-conversations.md`).
- **Lanes:** two (the cap). Server: 587 → 586 → 591. Web: 588 → 589 → 590 (after 587 merges: the
  list rule) → 592 (after 591's route). 593 last.
- **Models:** Opus 5.5 for the coordinator, every review, and 587 (migration, RLS), 586 (atomic
  move across the workspace and the project) and 591 (accept route: role at accept time, recorded
  bytes, commit). Sonnet 5.5 or Opus 5.5 for 588, 589, 590, 592, 593. Never Haiku for code.
- **Process (as the Workspaces lane):** a worktree per ticket from origin/main with
  `CLAUDE.local.md` and `BRIEF.md`; ticket agents never push, open PRs or touch Hadron; the
  coordinator reviews the diff, opens the PR and enqueues it with `gh pr merge <n> --auto`. Before
  any squash, merge origin/main first (the KOBE-577 squash silently reverted KOBE-571).
- **Gate1:** an upgrade, not a reinstall. Take and keep a `pg_dump` before the PC-0 migration
  runs there and record its dry-run list of restricted projects in the gate doc; never delete a
  backup.
- **One gate:** no mid-lane review. Work every ticket to done, deploy main to gate1, run the
  browser specs, write the gate doc, stop for Chris at KOBE-594.
- **Status (2026-11-09):** spec, tickets and this brief filed; lane starting with KOBE-587 and
  KOBE-588.
