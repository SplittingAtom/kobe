# Gate — Workspaces (KOBE-576..582)

Ticket: KOBE-583. Spec: [`docs/specs/workspaces.md`](../specs/workspaces.md) (Hadron spec
`b1e23088`; Chris's decisions of 2026-11-08 in §14). Lane brief:
[`docs/ledger/workspaces-lane.md`](../ledger/workspaces-lane.md). **Waiting for Chris's review**
on the gate1 site (see "What to try" below).

## What shipped

| PR   | Tickets         | Main     | Content                                                                                                             |
| ---- | --------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| #492 | spec            | 18df9ead | Workspaces spec and lane brief                                                                                      |
| #494 | KOBE-576 (WS-1) | 3870db78 | protocol: contributor role, project visibility and roles, commits, checkouts, run access                            |
| #496 | KOBE-577 (WS-2) | 8a4f3938 | migrations 0198-0201: enum rename, visibility, roles, commit/tree/checkout tables, quotas, hold guard, MG4 backfill |
| #498 | KOBE-580 (WS-5) | 2924c4b9 | sandbox agent: checked-out project folders in sync, `commit_project`, project access line                           |
| #499 | KOBE-578 (WS-3) | 5f3019dc | server: roles, visibility, ownership, mount-on-conversation                                                         |
| #500 | KOBE-579 (WS-4) | 3f4c15a5 | server: checkouts, commits, history, revert, quotas, pruning                                                        |
| #501 | KOBE-581 (WS-6) | 2fb0ab1b | web: Workspace switcher, Files tree (Workspace > Projects, My files), checkout/commit, roles, History, Storage      |
| #502 | KOBE-582 (WS-7) | 4b95afc7 | removal of `propose_project_file`, `workspaces.spec.ts`, docs                                                       |
| #504 | fix (lane)      | d955a7f3 | restores KOBE-571, which the KOBE-577 squash had reverted; add-to-project spec mounts by conversation               |
| #505 | fix (lane)      | 59dc229a | Open to mount from a project page starts the conversation in the project                                            |

Also deployed with this gate: #503 (Expand icon on the collapsed rail; mentions as text only). This
docs PR also fixes a locator in `agents-roster.spec.ts` (see Agents roster below).

**Deploy:** kobe-gate1 reinstalled fresh as `local-4b95afc728d2` on 2026-11-09 (13:20-13:35Z),
then upgraded to `local-d955a7f32d0f` (main after #504/#505) the same day.

**Cost (Hadron, ticket agents):** 576 $6.6 · 577 $17.3 · 578 $8.5 · 579 $9.8 · 580 $4.5 ·
581 $10.0 · 582 $2.2 = **$58.9**, plus the coordinator's reviews, deploys and fixes (not itemised).

## Fresh install (MG0, Chris approved 2026-11-08)

1. Backup kept: `pg_dump -Fc` of the gate1 database to the gate1 backups folder
   (`pre-workspaces-2026-11-09.dump`, 34 MB, 136 table-data entries); values
   saved as `v.yaml.pre-workspaces-2026-11-09-final`. Nothing existing was deleted.
2. `helm uninstall kobe`; the 7 `kobe-team-*` namespaces deleted with their PVCs and Longhorn
   volumes; database `kobe` dropped and recreated (owner `kobe_owner`, same ACL); the 865 objects of
   bucket `kobe` deleted (13.8 MB; the bucket, its key and every other bucket untouched).
3. 7 images built, imported and pinned on all 4 nodes; chart copy replaced from main;
   `helm install` with the saved values. The Secrets the chart keeps (envelope key, model keys,
   auth, session keys) survived, so stored credentials stay readable.
4. Setup through the API (owner@gate1.test, Team1, member2@gate1.test as `member`, passwords
   from creds.env). Site configuration copied from the backup (decided at install: the purge
   covered teams, scratchspaces, projects and objects, not the site's own settings): model
   providers (Ollama Cloud, Anthropic, keys still encrypted with the kept envelope key) and the
   7-model catalogue, site model limits, branding (name, logo, favicon, Catalyst preset), the live
   connectors (catalyst_2, exa, foundry) with their 4 pinned UI templates, Team1's 5 models and 3
   connectors. Model gateway synced (7 changes, 2 keys written); team reconcile `failed:0`.
5. The scratch copy `kobe_pre_ws` (the backup restored for step 4) and `kobe_rt` (the restore
   check below) stay in the gate1 Postgres until Chris says otherwise.

## Evidence

- **ac-1 (tickets done, fresh install):** KOBE-576..582 done with every criterion marked; main
  carries every PR above; gate1 runs the merged build on the fresh install (step list above).
- **ac-2 (browser spec):** `e2e/browser/tests/workspaces.spec.ts` against gate1 from the
  Playwright container (owner + member2): **2 passed** (setup + scenario: restricted project,
  reader converses but cannot upload (403/404), promote to editor, check out, edit, commit, owner
  sees the commit in History and the edit in their mount). Final run on `local-d955a7f32d0f`:
  workspaces + add-to-project + agents-roster together, every scenario passed (the roster's
  "assign and run" after this PR's locator fix; see below).
- **ac-3 (decisions of 2026-11-08 end to end):** four nouns in the UI (Workspace switcher, Team,
  My files, Projects); readers converse, cannot upload or commit (spec run); builder → contributor
  (`workspace-wording.test.ts`, MG1 upgrade test); admins and contributors create projects;
  Kobe-native commits with History and Revert (spec run + audit rows); mount on conversation,
  cap 20 (KOBE-578 db tests; gate1 Files tree shows only opened projects); explicit members →
  editor (MG3); `propose_project_file` removed (#502); history keeps all by default with the
  1,000-commit cap and object budgets (KOBE-579 tests; pruning exercised on gate1).
- **ac-4 (probe suite, upgrade, hold):** CI `db` job green on every lane PR: cross-team probe
  suite (`packages/db/src/probe.db.test.ts`) on every migration; `workspaces-upgrade.db.test.ts`
  on a populated database proves MG1 (rename in place), MG2 (visibility from members_mode, column
  dropped), MG3 (members → editor), MG4 (one Imported commit per project with tree, head,
  counters), FORCE RLS kept; `project-commits.db.test.ts` "refuses pruning commits and tree entries,
  and truncating either, under any hold".
- **ac-5 (audit):** every GV4 event has a row in `docs/audit-log.md` and is in gate1's team audit
  log: `project.visibility_changed` 2, `project.owner_transferred` 4, `project.checked_out` 3,
  `project.checkout_discarded` 2, `project.committed` 10, `project.commit_reverted` 1,
  `project.history_pruned` 2, `project.member_role_changed` 1. The spec run produced the commit,
  checkout and role rows; the rest were exercised through the API on 2026-11-09 (project
  "Gate audit …", archived; `history_pruned` by the retention job's own `pruneProjectHistory`).
- **ac-6 (licences):** `pnpm license:gate` on main: 758 packages, 3 documented exceptions;
  inventory 1,466 components, **0 pending gate review**.
- **ac-7 (backup/restore):** `kobe backup` of gate1 (as the Postgres superuser, objects
  included) then `kobe restore` into a fresh migrated scratch database `kobe_rt` in the same
  Postgres (a restore onto gate1 itself would need an empty site, i.e. another purge): signature
  verified, 133 tables, 9,100 rows, 58 S3 objects checked (0 problems), audit chain verified.
  Identical on both sides: counts of projects 7, commits 7, tree entries 7, checkouts 1, files 7,
  members 8; md5 of commit history (project, seq, message, parent), of project heads and
  visibility, of checkouts, and of the object counters. The History tab reads exactly these rows.
- **ac-8:** this document; spec status set to "shipped pending gate". Chris's approval goes here.

## Agents roster (KOBE-572) on the same install

The KOBE-577 squash (PR #496) had silently reverted KOBE-571 (#495: fork dialog and lineage,
version rule UI, picker grouping, team default agent); CI stayed green because its tests went with
it. Found by `agents-roster.spec.ts` on the fresh install (3 of 5 scenarios failed), restored by
#504. A check of every PR merged since 2026-11-08 found no other loss. Re-run on `local-d955a7f32d0f`: 4 of 5
scenarios passed; "assign and run" failed on a spec bug (its `has:` locator named the whole picker, so
it could never match inside a label; the picker itself showed the agent in its Team group). With
the locator fixed (this PR): `agents-roster.spec.ts` **6 passed** (setup + 5 scenarios), so KOBE-572
ac-1 holds.

## Open problems

1. **Remembered approvals vs. other active runs (found 2026-11-09, not fixed):** with a
   thread-scoped remembered approval and another active run of the same member, the sandbox's
   policy check allows (no card) while the MCP proxy requires a signed approval (review S1) and
   denies, so the member cannot approve at all (Foundry `create_runtime` on gate1). Fix: the policy
   check mirrors the proxy's sibling decision and asks. Ticket to file (Chris to schedule).
2. **Files panel does not refresh itself** after agent writes, project actions elsewhere or
   teammates' commits; proposed: client triggers now, server-pushed tree changes later. Not filed.
3. **KOBE-586** (filed): Promote a My files folder to a project (move, one commit), plus mounting a
   new project for its creator at once (an empty new project is otherwise invisible in Files).
4. A Released `Retain` NFS PV from the first gate1 install (`kobe-team-gate1-a`, 10 GiB on
   an NFS storage class, 36 days old) is left as is; Chris to decide.
5. The roster spec's literal "owner leaves" case still needs a disposable third member; the
   withdraw scenario covers the same rules (KOBE-572 ledger).

## What to try (Chris)

Switch workspaces; create a workspace-visible and a restricted project; converse as member2 (a
reader) and see it cannot edit; promote to editor, check out, commit; see History, the Files tree
(Workspace > Projects, My files), Team console > Storage (objects and bytes) and the audit rows.
