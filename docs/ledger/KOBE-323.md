# KOBE-323: B4: Test pane for drafts

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

## Handoff (for the agent doing KOBE-324 onward)

- **Branch:** `group-skills-b` in `../Kobe-skB`; 320–323 committed, nothing pushed, one PR for
  Phase B. Earlier handoffs: `docs/ledger/KOBE-320.md` … `KOBE-322.md`.
- **Migrations on this branch:** 0141/0142 (drafts), 0143/0144 (test chats). Main has its own
  0141/0142 since G5 (#314): renumbered by `pnpm --filter @kobe/db db:rebase` at the group rebase
  (coordinator), not before. 0144 is custom SQL (keep as written).
- **No startup seeds or startup jobs** in 323 (nothing for `startup-seeds.ts` / `startup/jobs.ts`
  at rebase); the bundle sweep is a step of the per-team retention pass.
- **Eval runner (325) building blocks:** `prepareDraftTest` (scan + store a draft revision's
  runtime zip under `skills/drafts/<team>/<draft>/<sha256>`) and `draftSkillForRun` (in-tx check
  and ref) in `skills/drafts/test-bundle.ts`; `withDraftTests` (`runs/draft-tests.ts`) narrows a
  run's skills through `AgentResolutionInput.onlySkill`. A with/without-skill eval run can reuse
  `onlySkill` (with) and an empty skill set (without).

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
- **Legal hold:** no row holds a bundle key (tested), so deleting bundles never removes held
  content: the held copy is the draft's history in Postgres.
- A fork of a test chat is an ordinary thread (fork copies entries, not the test flag).
- A rescanned rule set doesn't invalidate an already stored test bundle (short-lived; the save
  scans again).

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
