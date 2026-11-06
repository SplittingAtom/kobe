# Conversation tree lane (KOBE-541..549)

<!-- The lane's record for the coordinator; details in each ticket's ledger. -->

- **Spec:** `docs/specs/conversation-tree.md` (Hadron spec `e8b1281a-db5c-41c0-9e9f-a0417409fcff`;
  decisions by Chris 2026-11-05, Q1–Q31 in §8; the raw decision log is
  `docs/ledger/conversation-tree-decisions-2026-11-05.md`).
- **Tickets:** CT-0 KOBE-541 spike (branch summaries) and CT-1 KOBE-542 protocol in parallel →
  CT-2 KOBE-543 server (labels table, branches read, junction count, leaf rules, export) and
  CT-3 KOBE-544 local head (web) in parallel → CT-4 KOBE-545 tree projection, layout, lane tokens →
  CT-5 KOBE-546 panel, Continue from here, labels UI, narrow list → CT-6 KOBE-547 Compare →
  CT-7 KOBE-548 branch summary run (only if KOBE-541 answered yes to both questions; else closed
  won't-do with a ledger note) → CT-8 KOBE-549 browser checks and ledger.
- **Lanes:** two (the cap): after 542, server (543) and web (544 → 545) run side by side; 546
  waits for both. 543 adds the migration; no other migration in flight at the same time.
- **Status:** done 2026-11-06. PRs #446 (docs), #447 (541), #448 (542), #450 (543), #449 (544), #452 (545),
  #451 (lineage fork point), #453 (546), #454 (547), #455 (548); gate1 at `local-cbaf76e1559a`; KOBE-549
  specs 10/10 on gate1. Decisions taken in the run are in RUN-LEDGER "Open problems".

## Kickoff prompt (paste into a new Claude Code session at the repo root)

```text
Work the conversation tree lane to completion: Hadron tickets KOBE-541, 542, 543, 544, 545, 546,
547, 548, 549, spec docs/specs/conversation-tree.md (read it whole first; Chris's decisions are in
§8 and are final), lane brief docs/ledger/conversation-tree-lane.md.

Start as CLAUDE.md says: read docs/RUN-LEDGER.md, run scripts/hadron.sh ignite, then follow
docs/agent-prompt.md and docs/parallel-work.md for every ticket (scripts/hadron.sh start <N>, a
worktree ../Kobe-wt<N> from origin/main with CLAUDE.local.md copied in, BRIEF.md from
scripts/hadron.sh brief <N>, one Opus agent per ticket, short reports). Ticket agents never push,
open PRs or touch Hadron; you review their diff (RLS and the probe suite for the labels table, the
owner-only lock on labels and the leaf, thread_busy on queued runs, the local head never calling
the leaf route for readers, protocol strictness, Pi owning every summary), then open the PR and
enqueue it with gh pr merge <n> --auto (watch the gh-readonly-queue/main/pr-<n>-* runs, not
autoMergeRequest).

Order: KOBE-541 (spike, a written answer only) and KOBE-542 (protocol, its own PR) first. Then two
lanes: server KOBE-543 and web KOBE-544 → KOBE-545, then KOBE-546, then KOBE-547. KOBE-548 only if
541 answered yes to both questions; otherwise transition it to done with a won't-do note in its
ledger and a line in RUN-LEDGER "Open problems". KOBE-549 last: the browser specs against gate1
after the deploy. After each merge: fast-forward main, remove the worktree and branch, update the
ticket's ledger docs/ledger/KOBE-<N>.md, mark criteria with scripts/hadron.sh ac, close with
scripts/hadron.sh close <N> <pr> and record cost with scripts/hadron.sh cost.

When 542–547 (and 548 if built) are merged: deploy main to kobe-gate1 with the procedure in
CLAUDE.local.md and the memory notes (build 7 images on compute2, import and pin on all 4 nodes,
chart copy, helm get values -o yaml then -f v.yaml --reset-values, never --reuse-values, reconcile
failed:0, prune old tags, disks under 80%), then run the KOBE-549 specs from the Playwright
container against gate1 (owner and member2 credentials from creds.env, never printed). Add the
lane's entry to docs/RUN-LEDGER.md "Current" and a row per new audit event to docs/audit-log.md
if a ticket missed one. Keep the repo free of infrastructure details (it is public).

Do not re-litigate the spec's decisions; if a ticket finds the spec wrong or incomplete, note it in
the ticket's ledger and the RUN-LEDGER "Open problems" list and pick the smallest consistent reading.
Stop only when every ticket is done in Hadron, gate1 runs the merged build and the browser specs
passed, or when something needs Chris (a licence question is never a blocker: mark it pending).
```
