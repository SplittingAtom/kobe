# Thread lineage and folders lane (KOBE-532..537)

<!-- The lane's record for the coordinator; details in each ticket's ledger. -->

- **Spec:** `docs/specs/thread-lineage-and-folders.md` (Hadron spec `71dcf77b-f3ef-4458-be76-54bebf3647ad`;
  decisions by Chris 2026-10-31, Q1–Q6 in §7).
- **Tickets:** TLF-1 KOBE-532 protocol → TLF-2 KOBE-533 lineage read (server) and TLF-3 KOBE-534
  folders (db, server) in parallel → TLF-4 KOBE-535 lineage strip (web) and TLF-5 KOBE-536 Threads
  panel (web) → TLF-6 KOBE-537 browser checks and ledger.
- **Lanes:** two (the cap): lineage (533 → 535) and folders (534 → 536). 532 lands first on its own.
- **Status:** filed, nothing started.

## Kickoff prompt (paste into a new Claude Code session at the repo root)

```text
Work the thread lineage and folders lane to completion: Hadron tickets KOBE-532, 533, 534, 535, 536,
537, spec docs/specs/thread-lineage-and-folders.md (read it whole first; Chris's decisions are in
§7 and are final), lane brief docs/ledger/thread-lineage-folders-lane.md.

Start as CLAUDE.md says: read docs/RUN-LEDGER.md, run scripts/hadron.sh ignite, then follow
docs/agent-prompt.md and docs/parallel-work.md for every ticket (scripts/hadron.sh start <N>, a
worktree ../Kobe-wt<N> from origin/main with CLAUDE.local.md copied in, BRIEF.md from
scripts/hadron.sh brief <N>, one Opus agent per ticket, short reports). Ticket agents never push,
open PRs or touch Hadron; you review their diff (RLS and migrations, the readable predicate, the
reader-capable filing lock, audit events, protocol strictness), then open the PR and enqueue it
with gh pr merge <n> --auto (watch the gh-readonly-queue/main/pr-<n>-* runs, not autoMergeRequest).

Order: KOBE-532 (protocol) first, its own PR, merged before anything depends on it. Then two lanes
in parallel: lineage KOBE-533 → KOBE-535, folders KOBE-534 → KOBE-536 (534 adds the migration; no
other migration in flight at the same time). KOBE-537 last: the two browser specs, run against
gate1 after the deploy. After each merge: fast-forward main, remove the worktree and branch,
update the ticket's ledger docs/ledger/KOBE-<N>.md, mark criteria with scripts/hadron.sh ac, close
with scripts/hadron.sh close <N> <pr> and record cost with scripts/hadron.sh cost.

When 532–536 are merged: deploy main to kobe-gate1 with the procedure in CLAUDE.local.md and the
memory notes (build 7 images on compute2, import and pin on all 4 nodes, chart copy, helm get
values -o yaml then -f v.yaml --reset-values, never --reuse-values, reconcile failed:0, prune old
tags, disks under 80%), then run the KOBE-537 specs from the Playwright container against gate1
(owner and member2 credentials from creds.env, never printed). Add the lane's entry to
docs/RUN-LEDGER.md "Current" and a row per new audit event to docs/audit-log.md if a ticket
missed one. Keep the repo free of infrastructure details (it is public).

Do not re-litigate the spec's decisions; if a ticket finds the spec wrong or incomplete, note it in
the ticket's ledger and the RUN-LEDGER "Open problems" list and pick the smallest consistent reading.
Stop only when every ticket is done in Hadron, gate1 runs the merged build and both browser specs
passed, or when something needs Chris (a licence question is never a blocker: mark it pending).
```
