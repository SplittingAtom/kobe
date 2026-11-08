# Workspaces lane (KOBE-576..582, gate KOBE-583)

<!-- The lane's record for the coordinator; details in each ticket's ledger. -->

- **Spec:** `docs/specs/workspaces.md` (Hadron spec `b1e23088-8dcd-41fa-bee5-4335b9d82e0b`;
  decisions by Chris 2026-11-08, every question in §14 answered).
- **Tickets:** WS-1 KOBE-576 protocol → WS-2 KOBE-577 database → WS-3 KOBE-578 server roles,
  visibility, mounts and WS-5 KOBE-580 sandbox agent in parallel → WS-4 KOBE-579 server commits →
  WS-6 KOBE-581 web → WS-7 KOBE-582 removal, browser check, docs. Gate KOBE-583
  (`docs/gates/gate-workspaces.md`).
- **Lanes:** two (the cap): server (577 → 578 → 579) and sandbox/web (580 → 581). 576 lands first
  on its own; 582 last.
- **Models (Chris, 2026-11-08):** Opus 5.5 or Sonnet 5.5 only. Opus for the coordinator, for every
  review, and for the tickets that touch RLS, migrations, approvals, sync or sandbox permissions
  (577, 578, 579, 580). Sonnet is fine for 576, 581 and 582. Never Haiku for code.
- **One gate (Chris, 2026-11-08):** no mid-lane review. Work every ticket to done, reinstall gate1
  fresh, run the browser spec, write the gate doc, then stop for Chris at KOBE-583.
- **Fresh gate1 (Chris, 2026-11-08):** the existing teams, scratchspaces, projects and their S3
  objects may be purged (spec MG0). Take and keep a `pg_dump` first; never delete an existing
  backup.
- **Status:** started 2026-11-08 ~20:05Z by the kobe-03 coordinator session (Chris pasted the kickoff prompt
  there). Spec and this brief committed in the docs PR that replaces the earlier small brief below.

## Earlier small lane (2026-11-08 afternoon, superseded by this spec)

Before this spec was found, the same coordinator answered Chris's questions on shared conversations
(a reader gets no copy; projects are the only sharing path; no co-editing) and shipped **KOBE-585 Add
to project** (PR #488, main 507b26e4): `POST /v1/projects/:id/files/import` copies an artifact version
or one of the caller's scratchspace files into a project from stored bytes; rights = team admins,
project owners, builders who are project members, the content's owner when a member; audit ids only;
"Add to project…" on artifacts, file tabs and file cards; gate1 spec `add-to-project.spec.ts` (not yet
run: gate1 is not deployed past it). To reconcile in this lane: WS-3 maps those rights onto the
spec's project roles (owner, editor; team admins) and the builder→contributor rename; mount-on-
conversation (MT1) means a member sees an imported file once they have a conversation in the project
or a checkout, so the gate1 spec's "member2 sees it" step must open a project conversation first;
the "Imported from <conversation>" label becomes the import's commit message/author once WS-4 lands.

## Kickoff prompt (paste into a new Claude Code session at the repo root)

```text
Work the Workspaces lane to completion and stop only at its gate: Hadron tickets KOBE-576, 577,
578, 579, 580, 581, 582, gate KOBE-583; spec docs/specs/workspaces.md (read it whole first;
Chris's decisions, marked (Chris) and listed in §14, are final); lane brief
docs/ledger/workspaces-lane.md.

Step 0: the spec and the lane brief are untracked in this checkout. Commit them on a docs branch
(docs: Workspaces spec and lane brief), open the PR, enqueue it with gh pr merge <n> --auto and let
it merge before any ticket starts, so every worktree from origin/main carries the spec.

Then start as CLAUDE.md says: read docs/RUN-LEDGER.md, run scripts/hadron.sh ignite, add the lane
to RUN-LEDGER "Current", then follow docs/agent-prompt.md and docs/parallel-work.md for every
ticket (scripts/hadron.sh start <N>, a worktree ../Kobe-wt<N> from origin/main with
CLAUDE.local.md copied in, BRIEF.md from scripts/hadron.sh brief <N>, one agent per ticket, short
reports). Models: Opus 5.5 for you, for every review and for KOBE-577, 578, 579 and 580; Sonnet
5.5 or Opus 5.5 for KOBE-576, 581 and 582; never Haiku for code. Ticket agents never push, open
PRs or touch Hadron; you review their diff (RLS and migrations, the permission matrix and the
restricted-visibility 404s, the checkout-only push rule and the uid relock, the commit's
canonical input and D32 refusal, quota attribution, audit events, protocol strictness), then open
the PR and enqueue it with gh pr merge <n> --auto (watch the gh-readonly-queue/main/pr-<n>-* runs,
not autoMergeRequest). Each ticket's branch is its own PR; a ticket with a migration lands the
migration PR first (schema, migration, RLS, probe fixtures, backfill), then its feature PR.

Order: KOBE-576 (protocol) first, its own PR, merged before anything depends on it. KOBE-577
(database) next, alone: it holds the lane's only migrations (enum rename, visibility replacing
members_mode in one migration, reader role, member rows to editor, commit, tree entry and
checkout tables, head_commit_id, object quota columns, first-commit backfill); no other migration
in flight meanwhile. Then two lanes in parallel: server KOBE-578 → KOBE-579 and sandbox/web
KOBE-580 → KOBE-581 (581 waits for 579's routes where it needs them; start its switcher, strings
and Files panel work before that). KOBE-582 last: remove propose_project_file, the browser spec,
docs/audit-log.md rows, API glossary, RUN-LEDGER. After each merge: fast-forward main, remove the
worktree and branch, update docs/ledger/KOBE-<N>.md, mark criteria with scripts/hadron.sh ac,
close with scripts/hadron.sh close <N> <pr>, record cost with scripts/hadron.sh cost.

When 576–581 are merged and 582's code is merged: reinstall kobe-gate1 fresh on main (Chris
approved purging every existing team, scratchspace, project and their S3 objects on 2026-11-08,
spec MG0). Procedure, with the host names and credentials from CLAUDE.local.md and the memory
notes, never printed and never written into tracked files: (1) pg_dump the gate1 database to
compute1 ~/kobe-gate1/backups/pre-workspaces-<date>.dump and keep it; never delete any existing
backup. (2) helm uninstall the kobe release in kobe-gate1; delete every kobe-team-* namespace and
wait for their Longhorn volumes to go; drop and recreate the gate1 database in kobe-gate1-deps (pg
stays); empty the objects of the kobe bucket on the NAS MinIO (bucket and credentials stay;
Langfuse and every other bucket untouched). (3) Build the 7 images on compute2 for main's sha,
import and pin them on all 4 nodes, replace the chart copy on compute1 from main, then helm
install with the saved values (helm get values -o yaml from before the uninstall, --reset-values,
never --reuse-values) and run the setup wizard so owner@gate1.test and member2@gate1.test exist
again with the passwords in creds.env, in one workspace, plus the Catalyst connector and the
Langfuse telemetry values as before; reconcile must log failed:0. (4) Run
e2e/browser/tests/workspaces.spec.ts from the Playwright container on compute2 against gate1
(owner and member2, credentials from creds.env). (5) Verify kobe backup + kobe restore round-trips
a project with commits. Prune old local-* tags and test images on compute2; keep node disks under
80%.

Then write docs/gates/gate-workspaces.md in the shape of docs/gates/gate-theming.md: what shipped
(PR, tickets, main sha), the deploy tag, the evidence per KOBE-583 criterion (browser spec output,
probe suite, upgrade test, audit rows on gate1, pnpm license:gate, backup/restore), open problems.
Mark the spec status shipped pending gate. Record everything in docs/RUN-LEDGER.md. Keep the repo
free of infrastructure details (it is public).

Rules: never re-litigate the spec's decisions; if a ticket finds the spec wrong or incomplete,
note it in the ticket's ledger and RUN-LEDGER "Open problems" and pick the smallest consistent
reading. A licence question is never a blocker: mark it pending and carry on (pnpm license:gate
is read at the gate). Do not stop for a mid-lane review, a demo or a question Chris has already
answered in §14. Stop only when KOBE-576..582 are done in Hadron, gate1 runs the fresh install,
the browser spec passed and docs/gates/gate-workspaces.md is written, or when something needs
Chris that the spec does not settle. Report at the end with the gate doc's path, the deploy tag,
and the total cost of the lane.
```
