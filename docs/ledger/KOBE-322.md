# KOBE-322: B3: Draft starts: template, fork, upload, from a conversation

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## Handoff (for the agent doing KOBE-323 onward)

- **Branch:** `group-skills-b` in `../Kobe-skB`; 320, 321 (approved) and 322 committed, nothing
  pushed, one PR for Phase B. Earlier handoffs: `docs/ledger/KOBE-320.md`, `KOBE-321.md`.
- **Test pane (323) building blocks:** a conversation with the Kobe gallery agent
  (`galleryKey: "kobe"`, `api.runnableAgents()`), created and sent to from the web
  (`lib/skills/from-conversation.ts` shows the calls). A run loads skills only through the
  resolver (`runs/agents.ts` → `resolver/resolve.ts`); nothing names a skill per thread or
  message yet, so "run only this draft" needs a server path (and threads have no kind column:
  a Workbench rail group needs one, or a link from the draft).
- **Workspace reads:** `skills/drafts/from-workspace.ts` reads `/workspace/skills/<name>/` of the
  caller's (team, user) workspace from the sync manifest (`liveFilesUnder`, `currentEntry`,
  objects by hash). `skillDraftRoutes(deps, workspace?)` gets `WorkspaceSync` from
  `options.workspaceFiles` in `app.ts`.
- **Every start goes through `createDraft`** (`skills/drafts/service.ts`): author cap, 5 MiB, 200
  files, path rules, `skill.draft.created`.

- **Status:** in review (group branch `group-skills-b`, one PR for Phase B)
- **Depends on:** KOBE-320, KOBE-321

## What shipped

- **Server** (`/v1/skills/drafts`):
  - `POST /` takes an optional `template`; `GET /templates` lists the five (document generator,
    data analysis, API helper, review checklist, house style: `skills/drafts/templates.ts`, plain
    data, each a valid package that scans Pass, no scripts).
  - `POST /upload?kind=zip|skill_md`: the upload's own validation (`validateZipBundle`,
    `bundleFromSkillMd`), then the draft's limits; the draft takes the SKILL.md name; `evals/`
    and `kobe.skill.yaml` are kept; shares the upload rate.
  - `POST /fork {source: {kind: team|personal|catalog, skillId, version|semver?}, name?}`
    (`skills/drafts/fork.ts`): team versions, the caller's own personal versions, or a catalog
    skill the team has installed (its installed version, or another approved/deprecated one).
    The parent is recorded from the version copied: `{kind, skillId, semver, hash, ownerUserId?}`
    (`hash` = the runtime hash). A blocklisted version is refused (422); unstored catalog bytes
    are 409 `source_unavailable`; `name` renames SKILL.md and `kobe.skill.yaml`.
  - `POST /from-workspace {threadId, folder}` (Save to Workbench): reads
    `/workspace/skills/<folder>/` (count and sizes checked from the manifest before any bytes,
    each object checked against its hash), validates it as an upload, and makes a draft
    `started_from: thread` with `from_thread_id` = that conversation (one of this team the
    caller can read); saving again from the same conversation replaces that draft's files.
- **Save version** writes the chosen semver and changelog into a draft's `kobe.skill.yaml`
  (`skills/drafts/manifest-sync.ts`; other keys and comments kept). Otherwise a fork's manifest
  names its parent's number and every save but that number is refused. The bump ignores those
  two keys. So a fork saved as a new skill starts at 0.1.0 (coordinator).
- **Web:**
  - Workbench "New draft" (`components/skills/new-draft.tsx`): name plus Start from (Blank or a
    template), and Upload a zip or SKILL.md.
  - Team and Mine rows: **Edit in Workbench** (fork under the skill's own name: the edit path
    for existing skills).
  - Team tab: **Catalog skills in this team** with Fork (as `<name>-custom`: Kobe's names are
    reserved).
  - Thread menu and `/` menu:
    - **Make a skill from this** (`/skill`): a new Kobe-agent conversation, with the source
      branch attached as `source-conversation.md` (an upload: read-only in
      `/workspace/uploads/<thread>/`). Its first message asks skill-creator to build under
      `/workspace/skills/<name>/`.
    - **Save skill to Workbench** (`/saveskill`): lists the folders under `/workspace/skills`
      and opens the saved draft.

## Decisions

- **"Attached read-only" = an upload of the source branch as Markdown** in the new thread (the
  same text Copy produces). Threads have no mention or attachment of another thread, and a fork
  would keep the source's agent (maybe without skill-creator); the source thread is untouched.
- **`from_thread_id` is the conversation Save to Workbench ran in** (usually the Workbench
  conversation, itself the team's): the personal-save confirmation applies to it.
- **Catalog forks** need an install in the team (no member catalog browse before C7).
- **No skill-creator change** (its files are a Kobe-published version with fixed hashes): the
  first message tells it where to build and that the user saves from the menu.
- **Upload start known gap** (KOBE-320): uploading a downloaded team version bypasses the parent
  link; the scanner and review still apply.

## Departures

- Brief said "images/sandbox/skills/skill-creator": built-ins moved to
  `services/server/builtin-skills/` in KOBE-317; unchanged here.
- Save version change (manifest number) touches 320's `save.ts`, needed for forks.

## Open questions (for Chris or the coordinator)

1. Save to Workbench navigates to the draft (leaves the chat). Stay in the chat with a link?
2. Should "Make a skill from this" ask before spending a model turn (it sends the first message)?

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skill-drafts-starts.db.test.ts` (template, zip and SKILL.md
  uploads with refusals, forks, Save to Workbench: each a draft of its author in the team);
  `skills/drafts/templates.test.ts`; web `components/skills/starts.test.tsx`,
  `lib/skills/from-conversation.test.ts`, the menu tests.
- **ac-2** same DB file "from a conversation": synced through upload validation, `from_thread_id`
  recorded, re-save updates, personal save asks; refusals (invalid SKILL.md, empty folder, a
  conversation the caller can't read, a bad folder).
- **ac-3** same DB file "fork": parent from the version copied (team, personal with
  `ownerUserId`, catalog with the runtime hash), the KOBE-320 team wall (no personal save of a
  team fork), the edit path (fork, change, save 0.2.0 with the copied manifest),
  `manifest-sync.test.ts`.
- Runs: web test (1,904), typecheck, lint, build; server test, typecheck, lint, the drafts DB
  suites (drafts, preview, starts).
