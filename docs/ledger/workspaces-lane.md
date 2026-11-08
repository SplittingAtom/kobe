# Workspaces lane (not yet ticketed)

Started 2026-11-08 on Chris's "start docs/ledger/workspaces-lane.md", after a run of questions about
how workspaces behave with several people. No spec and no tickets yet: this file collects the asks,
what the code does today (verified on `main` f830a58f), the candidate scope and the decisions Chris
has to take before tickets are filed (as `docs/specs/agents-roster.md` did for the roster lane).

## Asks (Chris, 2026-11-08)

- "When I share a conversation with another user, do they get a copy of the artifacts created by the
  conversation in their workspace?" (Answer today: no; see below.)
- "Describe the workspace and how it works with multiple users in the workspace."
- "How do I create a project?" (builders and team admins only; `/me/projects`.)

## Today (what the code does)

- **One workspace per (team, member).** One sandbox per member per team with a persistent
  `/workspace` volume (D11); the server holds the manifest (`workspace_sync`, `workspace_files`,
  `workspace_blobs`) and the blobs in S3; the sandbox restores, pulls before each run, pushes every
  60 s, after each run and before hibernation (`docs/install.md` "Workspace storage", `docs/file-editing.md`).
- **No shared workspace.** Sharing a thread (private | project | team, CE20/D23) gives read access to the
  conversation only. A reader opens files from **their own** workspace (`open-file-card.tsx`), where the
  owner's files do not exist; artifacts are readable with the thread but **Edit as file is owner-only**
  (`routes/artifact-edit-as-file.ts`, 403 `read_only`); the proposals list is 404 to non-owners.
- **Project files are the sharing path.** `projects/<name>/` in every member's workspace is a
  server-owned, read-only mount of the project's files (`services/server/src/projects/mounts.ts`),
  reconciled at every run start; a project file cannot be replaced in place (delete + new file).
- **Concurrency inside one workspace** (same member, several tabs/threads/schedules): workspace row lock
  orders commits; saves name `base_sha256` (409 `version_conflict` → Compare / Keep mine / Take theirs);
  the sandbox's colliding push lands as a conflict copy and the agent is told (`workspace.conflict_note`);
  live change streams over LISTEN/NOTIFY for up to 32 open files (KOBE-496).
- **No co-editing of one file by two members**, and no "copy this to my workspace" for a reader.
- **Projects:** created by builders and team admins (`projectPermissions`); name, description,
  instructions, default agent, members mode (whole team | selected); project memory; threads moved in
  with "Move to project". gate1 Team1 has no active project (18 archived `KOBE-220 …` spec leftovers).

## Candidate scope (proposed, not decided)

| Id   | Candidate ticket                                                                                                 | Notes                                                                                                        |
| ---- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| WS-1 | Reader's **Copy to my workspace** on a shared thread's artifact and on its file cards (into `shared/<thread>/…`) | Server copies the stored bytes (as Edit as file does for the owner); audited; no owner-side change           |
| WS-2 | **Add to project** from a thread: an artifact or workspace file becomes a project file                           | Owner only; reaches every project member's `projects/` mount; replaces "download then upload"                |
| WS-3 | **Shared project workspace**: a writable `projects/<name>/` area (any member writes; conflicts as today)         | Big: changes mounts.ts (read-only today), sync, RLS; needs a decision on who may write and how edits collide |
| WS-4 | **Project file versions**: replace in place with history instead of delete + new file                            | Pairs with WS-3; today an open tab sees a replacement as a deletion                                          |
| WS-5 | **Team workspace browser**: admins see members' workspace usage (size, last sync) and can reclaim                | Ops; no content access                                                                                       |

## Decisions (Chris, 2026-11-08)

- **Goal: take a copy**, not a shared working space. WS-3 and WS-4 are deferred (nothing in this lane
  blocks them); WS-5 is deferred.
- **A reader's copy is read-only and lives in the project**: readers do not copy agent-written files or
  artifacts into their own workspace themselves (WS-1 dropped). What reaches them is the project's
  read-only mount under `projects/<name>/`; a reader who wants to work on a copy has the agent copy it
  from there (the sandbox can read `projects/`).
- **Add to project (WS-2) is for admins, owners and editors.** Kobe has no "editor" role today (team roles
  member | builder | team_admin; project roles owner | member; threads are read-only to everyone but
  the owner), and Chris confirmed **editors are builders**: team admins, the project's owners, builders who are
  members of the project, and the content's owner when a member of the project, behind one permission
  function.
- **Runs beside the roster lane** (a third lane while roster has two; stagger `pnpm verify` runs, see
  [[kobe-gsd-oom-sessions]]).

## Questions for Chris (answered above; kept for the record)

1. Is the goal "a reader can take a copy" (WS-1/WS-2, small) or "people work in one shared space"
   (WS-3/WS-4, a design change: who writes, how collisions resolve, retention of shared files)?
2. For WS-1: where does the copy land (`shared/<thread title>/`?), and may a reader copy a file the agent
   wrote, or only artifacts?
3. For WS-2: owner only, or any project member with `use` on the thread?
4. Should any of this wait for the agents roster lane (KOBE-565..573) to finish, or run beside it
   (both touch `apps/web` and the server; no shared tables)?

## Order and lanes

1. **KOBE-585** (WS-2) Add to project: server import routes (artifact version, workspace file → project
   file through `uploadProjectFile`, quotas and audit), the web action with project and folder picker,
   the gate1 spec (owner adds, member2 sees it read-only under `projects/`), docs. One lane, one PR.
2. Later, if asked: WS-4 (replace in place with history), WS-3, WS-5.

## Rules the agents must keep

- `/v1/workspace` serves only the caller's own (team, user) workspace; a reader never reads the
  owner's workspace directly: copies go through the server from stored bytes (as Edit as file).
- Project mounts stay server-owned unless WS-3 is decided; every team read states `team_id` on top of
  `withTeam()`; cross-team probes green on any new table.
- Nothing here changes run execution, approvals or sandbox isolation.

## Evidence

(filled by the ticket agents once tickets exist)
