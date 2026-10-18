# KOBE-323: B4: Test pane for drafts

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## Handoff (for the agent doing KOBE-324 onward)

- **Branch:** `group-skills-b` in `../Kobe-skB`. 320–323 are committed and reviewed (323 with
  its review-323 fixes). Nothing is pushed; Phase B is one PR. Earlier handoffs:
  `docs/ledger/KOBE-320.md` … `KOBE-322.md`.
- **Next:** 324 (eval cases and the scorecard contract, contract only, reviewed before 325),
  then 325 (eval runner: a migration ticket, security-critical), 326, 327, 328. Stop after each.
- **Migrations on this branch:** 0141/0142 (drafts) and 0143/0144 (test chats; 0144 is custom
  SQL). Main has its own 0141/0142 since G5 (#314). These get renumbered by
  `pnpm --filter @kobe/db db:rebase` at the group rebase (coordinator), not before.
- **Startup work:** none in 320–323, so nothing to slot into `startup-seeds.ts` or
  `startup/jobs.ts` at rebase. Bundle cleanup is a step of the per-team retention pass.
- **Reuse for 325:**
  - `skills/drafts/test-bundle.ts`:
    - `prepareDraftTest`: gate, blocklist, full scan, store the bundle at
      `skills/drafts/<team>/<draft>/<sha256>.r<rule set>`;
    - `draftSkillForRun`: the in-transaction check and the skill ref.
  - `skills/drafts/test-gates.ts`: the team's personal-skill gates.
  - `skills/drafts/test-holds.ts`: hold-aware delete, prune (newest 5), sweep.
  - `runs/draft-tests.ts` (`withDraftTests`): narrows a run's skills through
    `AgentResolutionInput.onlySkill`. An eval run "with" can pass `onlySkill`; "without" can
    pass an empty skill set the same way.
- **Gotchas:**
  - `pnpm --filter @kobe/db test` runs unit tests only. Also run `test:db`.
  - The full server `test:db` times out a few files under load on the shared Postgres. Rerun
    those files alone.
  - Regenerate `services/server/openapi.json` with `UPDATE_OPENAPI=1`, then prettier.
  - The CSS guard (`app/console-css-guard.test.ts`) lists every file allowed to import
    `chat-global.css`.

- **Status:** in review (group branch `group-skills-b`, one PR for Phase B)
- **Depends on:** KOBE-321

## What shipped

- **Threads** (migration 0143 generated, 0144 custom): `skill_test boolean NOT NULL DEFAULT
false`, `skill_draft_id uuid`; FK (team_id, skill_draft_id) → skill_drafts ON DELETE SET NULL
  (skill_draft_id), checks `threads_skill_draft_test`, `threads_skill_test_not_builder`, index
  `threads_skill_draft_idx`; NOT VALID / IF NOT EXISTS (no scan under the migration lock).
- **Start:** `POST /v1/threads {skill_draft_id}`: a draft the caller can see (theirs, or shared
  with them), the Kobe gallery agent only (another `agent_id` is 400), no project, not `test`.
  Ordinary otherwise: listed, searchable, retention, Trash.
- **Send** (`POST /v1/threads/:id/messages`, `skills/drafts/test-chat.ts`): before the message
  counts, the draft's current revision is built (upload validation), checked against the
  blocklist and scanned in full (the save's pool and rules), and stored only if not Block.
  Refusals, each with its own message: 409 `scan_blocked` (rules named), 409
  `skill_draft_unavailable` (deleted or no longer shared), 422 `invalid_draft`, 409
  `skill_blocklisted`, 503 `scan_busy` / `scan_incomplete`.
- **Run start** (`withDraftTests` around the resolver): the run's only skill is the draft (no
  Required, agent-named, offered or personal skill); model, connectors, approval mode, policy,
  egress, budgets (kind `message`) and audit are the agent's as usual. The zip is rebuilt in the
  run's transaction; if its object is missing the run fails `skill_draft_changed` ("send again"),
  a gone draft `skill_draft_unavailable`. Never a fallback to the usual skills.
- **Sandbox fetch** (`locateBundle`): after the run.start binding (this sandbox, user, team, open
  run.start listing the hash), a draft bundle is opened from the folder of the bound runs'
  thread drafts only. Source `draft` on `skill_refs` / `skills_used` / markers.
- **Storage:** bundles deleted on draft delete (best effort) and swept per team in the retention
  pass (`skill_draft_bundles`: folders whose draft is gone, after retention and offboarding
  purges or a send racing a delete).
- **Web:** Workbench editor has a **Test** pane (beside the editor on 2xl, below otherwise;
  `components/skills/test-pane.tsx`): the chat on `testSkillDraftId`, no agent choice, pending
  edits flushed before each send. Rail group **Workbench** after Scheduled.

## Decisions

- **Migration (coordinator-approved departure):** the brief said no migrations, but a rail group
  and a durable draft link need thread columns. `skill_test` stays true after the draft is deleted
  so such a thread refuses instead of widening.
- **Scan before the run, not in it:** a scan takes seconds; the run-start transaction holds the
  thread lock. The stored object is the proof of a non-Block scan of those exact bytes.
- **Legal hold (review S2, coordinator):** bundles are kept while a hold covers the draft's author,
  any writer (live, or in a deleted draft's hold history), or the owner of a test chat whose run
  loaded that bundle (`runs.skill_refs`, source `draft`). Decided under the legal-hold lock, objects
  deleted before it is released. No row stores a bundle key.
- **Personal-skill gates (review S1, coordinator):** while the team has personal skills off, only
  Builders and Team admins test drafts (403 `personal_skills_disabled`); files the team declined
  as a personal skill version (same runtime hash) can't be tested (409 `skill_declined`). Checked
  at send and again at run start (`skill_draft_personal_off` / `skill_draft_declined`).
- **Bounded storage (review S3):** newest 5 bundles per draft (held ones kept beyond that); the key
  names the scanner rule set, so a rule change rescans at the next send.
- A fork of a test chat is an ordinary thread (fork copies entries, not the test flag).
- Not done (review nits, open): N1 Retry/edit of a queued test-chat message skips the send-time
  scan (safe: the run then fails "send again"); N3 a test chat can still be moved to a project or
  shared by its owner; N7 a catalog fork's later team block isn't rechecked at test time.

## Departures

- Brief: "Adds migrations: no" → 0143/0144 (approved).

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skill-test-chat.db.test.ts` "a test chat runs only the draft's
  current revision": run.start lists the draft alone (a control chat loads the Required skill),
  a new revision runs under a new hash, same approval mode and kind as a plain chat; Kobe agent
  only; visibility and team walls; refusals (Block, unavailable, changed); web
  `components/skills/test-pane.test.tsx` (flush before send, `skill_draft_id`, no agent).
- **ac-2** same DB file "the Used-skill badge": a matching prompt's SKILL.md read records the
  draft (`source: draft`, markers), an unrelated prompt records nothing.
- **ac-3** `lib/chat/thread-groups.test.ts` (Workbench group), the pane test, the DB file (the
  thread is listed with `skill_test`).
- Storage and fetch: same DB file "the draft bundle in the sandbox and in storage" (another
  sandbox, team, or thread's run gets 404; delete and sweep; no row names the key).
- Schema: `packages/db/src/thread-skill-test.db.test.ts`, upgrade
  `thread-skill-test-upgrade.db.test.ts` (existing threads read `skill_test = false`, RLS forced),
  probes.
