# Gate — Projects in conversations (KOBE-587..593, KOBE-586)

Ticket: KOBE-594. Spec: [`docs/specs/projects-in-conversations.md`](../specs/projects-in-conversations.md)
(Chris's decisions of 2026-11-09 in §11). Lane brief:
[`docs/ledger/projects-lane.md`](../ledger/projects-lane.md). **Waiting for Chris.**

## What shipped

Three waves, one PR and one CI run each (CI per group, 2026-10-15 rule).

| PR   | Tickets                   | Main     | Content                                                                                                                                                 |
| ---- | ------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #508 | spec                      | 8da690ca | Spec and lane brief; Workspaces gate approved                                                                                                           |
| #510 | KOBE-587, 588, 589        | 6826ff71 | Migration 0202 (restricted removed, readers implied), `kobe projects restricted`; new-conversation header and project control; "Project / name" title   |
| #511 | KOBE-590, 591, 586        | 3a828a28 | Files panel lists every project (active dot, greyed rows); `propose_file_edit` for project files and `commits/from-proposal`; promote a My files folder |
| #512 | KOBE-592, 593             | 4436e1af | Proposal card (line diff, Accept commits, stale and not-allowed states, History link); browser spec and docs                                            |
| this | KOBE-593 (spec fix), gate | —        | Two spec fixes found on gate1 (below); this document                                                                                                    |

**Deploy:** kobe-gate1 **upgraded** (not reinstalled) to `local-4436e1af08aa` on 2026-11-10;
old tag `local-3a893e08156a` unpinned and removed; team reconcile `failed:0`; node disks 46-73%.

**Cost (Hadron, ticket agents, estimated from token counts):** 587 $25.7 (Opus) · 588 $2.0 ·
589 $2.2 · 590 $4.4 · 591 $13.3 (Opus) · 586 $15.3 (Opus) · 592 $1.7 · 593 $1.6 = **$66.2**, plus
the coordinator's reviews, merges, deploy and gate (not itemised).

## Upgrade record (RV2, lane brief)

1. **Backup kept:** `pg_dump -Fc` of the gate1 database to the gate1 backups folder before the
   upgrade (`pre-projects-lane-2026-11-10.dump`, 5.6 MB, mode 600, 140 table-data entries
   including `projects` and `project_members`, checked with `pg_restore -l`). Nothing deleted.
2. **Dry-run before the migration** (`kobe projects restricted`, state `pending`, run with the
   superuser for `BYPASSRLS`):

   ```
   2 restricted projects. After the upgrade each one is readable by every member of its workspace;
   owners and editors keep their roles, explicit reader rows are deleted (every member reads anyway).

   team1 (Team1) / kobe-582-kobe-582-mw9awoove71: KOBE-582 kobe-582-mw9awoove71 (archived)
       owner   owner@gate1.test (Owner)
       editor  member2@gate1.test (Member Two)
   team1 (Team1) / kobe-582-kobe-582-mw9kjytus9f: KOBE-582 kobe-582-mw9kjytus9f (archived)
       owner   owner@gate1.test (Owner)
       editor  member2@gate1.test (Member Two)
   ```

   Both are archived leftovers of the Workspaces gate spec; no reader rows, so the migration
   deleted no membership.

3. **After the upgrade:** 203 migrations applied; `projects.visibility` gone; `project_members`
   holds owner 10, editor 2 under `CHECK (role IN ('owner','editor'))`; FORCE row level
   security still on.

## Evidence

- **ac-1 (tickets done, merged build on gate1):** KOBE-587..593 and KOBE-586 done with every
  criterion marked; main carries #510-#512; gate1 runs `local-4436e1af08aa` (main after #512).
- **ac-2 (backup, dry-run):** the upgrade record above.
- **ac-3 (browser specs on gate1):** from the Playwright container (owner + member2):
  `projects-in-conversations.spec.ts`, `workspaces.spec.ts` and `add-to-project.spec.ts` together:
  **6 passed** (setup; owner: draft in A, switch to B, remove, add A back, send, "A / name" title
  and tab title, Files list with the active dot and greyed B, proposal Accept commits and shows in
  History; a My files folder promoted to a project; member2, a reader by default, sees every
  project and the reader's proposal is refused and never commits; the workspaces reader/editor
  scenario; Add to project) on `local-4436e1af08aa`, after the two spec fixes below.
- **ac-4 (probe suite, upgrade tests, licences):** CI `db` job green on #510-#512: the
  cross-team probe suite on migration 0202 and `restricted-removal-upgrade.db.test.ts` on a
  populated database (restricted rows readable by all, reader rows deleted, owner/editor kept,
  check constraint, FORCE RLS restored, column dropped). `pnpm license:gate` on main: 758
  packages, 3 documented exceptions; inventory 1,466 components, **0 pending gate review**.
- **ac-5:** this document; waiting for Chris.

## Spec fixes found on gate1 (this PR)

The first run on gate1 had 4 passed, 2 failed, both in the new spec and both in the test, not
the product:

1. **Owner scenario:** picking a project closes the control, so Playwright's `check()` waited for
   a radio that had left the page (the header already read "New conversation in … B"). Now a
   click, then the header is checked.
2. **Member2 scenario:** the last assertion expected project A to have no commits at all, but
   the owner's setup upload ("Add notes.md") is a commit. The forged `from-proposal` call was
   refused (status ≥ 400) and "Reader edit …" was never committed (the assertion just before
   passed). Now it compares with A's history taken before the reader acts.

## Notes for Chris

1. **Sharing to a project now reaches the whole workspace** (RV1): there is no restricted
   project any more; confidential work belongs in another workspace or in My files.
2. **Reject is client-only:** a rejected proposal stays recorded on the thread and could still
   be accepted through the API by an editor (Accept re-checks the role and the recorded bytes).
3. **A creator's PF5 mount lasts indefinitely** if they never start a conversation in the new
   project (the creator rule of mount on create).
4. **Files of an unmounted project are listed but cannot be opened:** opening a file needs the
   project in the conversation.
5. **"Recently used"** in the project control is the project's `updatedAt`.
6. **On any upgrade the dry-run must run after `pg_dump` and before the upgrade:** after
   migration 0202 it reports `migrated` and the list is gone (the backup still has it).

## Open problems

1. **`publish` workflow fails on main:** the sandbox image's vulnerability gate (fail on any
   fixable CRITICAL) has failed on every recent main push, including after #511 and #512. It does
   not block merges or the gate1 deploy (images built locally). Not part of this lane.
2. **Remembered approvals vs. other active runs** and **Files panel auto-refresh** (Workspaces
   gate, open problems 1-2) are still not filed; Chris to decide.
3. Scratch databases `kobe_pre_ws` and `kobe_rt` and the Released `Retain` PV stay until Chris
   says otherwise.

## What to try (Chris)

Start a new conversation from a project page: the header reads "New conversation in _project_";
switch or remove the project with the icon, then send: the title reads "_project_ / _name_". Open
Files: every workspace project is listed, the conversation's with a green dot, the rest greyed.
As an editor, ask the agent to change a project file: the card shows the diff; Accept commits it
(see History). As member2 the same request is refused. In My files, use "Promote to project…" on
a folder.
