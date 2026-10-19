# KOBE-442: skill-creator saves its skill straight into the Workbench (save_skill_draft)

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (group branch `group-skills-c`, one PR for Phase C)
- **Branch / worktree:** `group-skills-c` in `../Kobe-skC`
- **Depends on:** KOBE-322 (Save to Workbench), KOBE-317 (Kobe package set), KOBE-150 (share_file)
- **Migrations:** none (audit actions are a zod registry, no table changes)

## What shipped

- **Protocol** (`packages/protocol/src/skill-draft-tool.ts`, `sandbox-wire/skill-draft-frames.ts`):
  capability `skill_drafts`; tool `save_skill_draft {folder}` (a skill name, not a path) in
  `BUILTIN_TOOLS` (kobe, write, scope kobe, `primary_arg /folder`); kobe-tools op
  `skill.draft_save`; frames `skill.draft_save` (with `files`: the pushed `{path, rev, sha256,
size}`, 1..200, unique, path <= 512) and `skill.draft_save_result` (`draft_id`, `name`,
  `created`, `rev`, `file_count`, or an open error code).
- **Sandbox agent:** `tools/skill-draft-broker.ts` finds `/workspace/skills/<folder>/` (a real
  directory reached without a symlink), lists regular files (no symlinks, hidden files,
  `__pycache__`/`node_modules`/`.venv`, temp files; 200 files and 5 MiB checked before any push),
  pushes each through workspace sync, then sends the frame. kobe-tools registers the tool only
  with `KOBE_TOOLS_SKILL_DRAFTS=1` (the agent announces `skill_drafts` exactly when it announces
  `files`: tools channel plus workspace sync). The tool result adds a `next` line telling the model
  what the member does in the Workbench.
- **Server:** `sandbox-wire/skill-draft-save.ts` (capability, lease, the allowed call with the same
  input hash, as `share_file`), then `skills/drafts/tool.ts`: run active (DB), team role allows
  drafts, the `skill-upload` rate, then `saveWorkspaceSkill` with `pinned` files and
  `via: "tool"` under the member as audit actor. `from-workspace.ts` now takes `pinned`: every
  listed path must be under `skills/<folder>/` and its live manifest row must match rev, sha256
  and size; only those objects are read (each checked against its hash). From there it is the
  KOBE-322 path: upload validation (`validateZipBundle`), draft limits, `createDraft` (author cap)
  with `started_from: thread`, `from_thread_id` = the run's thread, or `replaceDraftFiles` for
  this conversation's draft of the same name.
- **Policy:** `save_skill_draft` joins `PROMPT_EXEMPT_KOBE_TOOLS` (no risk-class prompt in
  ask-on-write; reason "saves a private draft in your Workbench"); deny and ask rules, `ask-all`,
  and the strict input schema apply. Auto mode and scheduled runs treat it like other Kobe writes.
- **Audit:** `skill.draft.created` gains `via?: tool`; new `skill.draft.updated` (`draftId`,
  `fromThreadId?`, `via?`) for every re-save, the REST Save to Workbench too; new
  `sandbox.skill_draft_refused` (throttled, no names or paths). `docs/audit-log.md` updated.
- **Web:** `components/chat/skill-draft-card.tsx` under a `save_skill_draft` tool card: "Skill
  draft saved|updated: <name>" and **Open in Workbench** (`/me/skills/drafts/<id>`), read from the
  tool result, so it shows on a recorded thread too. "Make a skill from this" now asks
  skill-creator to save the draft itself.
- **skill-creator 1.2.0** (new hashes in `kobe-packages.test.ts`): step 5 validates then calls
  `save_skill_draft`; step 6 hands over to the Workbench (test pane, Run evals on
  `evals/cases.yaml`, Save version); `/saveskill` named as the fallback; no My skills / admin
  console / New skill text anywhere in the package (tested); ad-hoc test prompts moved to
  `NAME-tests/prompts.json` so only `cases.yaml` is saved with the skill; `package.py` no longer
  prints the old editor steps.

## Decisions

- **Pinned files, not "whatever is live".** The frame names exactly what the agent pushed and the
  server verifies each row (share_file's evidence, per file). A file deleted in the sandbox but
  still live on the server is not saved; a file changed after its push is `not_synced`.
- **Card from the tool result, not a new run event.** The result already carries the draft id;
  this needs no event type, survives reload, and matches `ReopenArtifact`.
- **No idempotency table.** The agent never re-sends a frame; a replay would only add a revision
  to the same draft (the existing `(from_thread_id, name)` lookup).
- **"Same scan as an upload"**: an upload start runs no scan at creation (KOBE-322); the scan runs
  at preview and Save version. The tool does the same.
- **Role check kept** (`team.personal.create`, as REST `mayStart`) though every role has it today.

## Departures

- `save_skill_draft` is registered for any agent with the capability (like `share_file`), not
  only the Kobe agent; an agent with an explicit tool list must name it.

## Open questions (for Chris or the coordinator)

- Exempting the tool from the ask-on-write prompt is my reading of "allowed by default"; say if it
  should prompt like `share_file`.
- KOBE-322 review N2 (same-conversation race needs a unique index) still open; the tool makes two
  concurrent saves a little likelier (one in flight per thread on the agent side).
- Gate1 needs a new sandbox image (kobe-tools, agent) and server for the browser spec.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/skill-draft-tool.db.test.ts` "creates the draft from the pushed
  files, then updates it" (private, `started_from thread`, `from_thread_id`, same id on re-save);
  browser `e2e/browser/tests/skill-creator-workbench.spec.ts` (gate1, not yet run).
- **ac-2** same DB file: unlisted live file left out, stale/never-pushed `not_synced`, outside the
  folder refused, invalid SKILL.md `invalid_skill`; no `team_skill_versions`, `team_skill_reviews`
  or `skill_eval_runs` rows. Limits pinned in `skills/drafts/tool.test.ts`.
- **ac-3** DB "decided by the server": capability, no allowed call, other input, run ended, all
  audited; cross-team: another team's pushed file is `not_synced`, no draft. Policy:
  `policy/evaluate.test.ts` (not prompted, team deny, bad input). Card:
  `apps/web/components/chat/skill-draft-card.test.tsx`. Probe suite 648/648.
- **ac-4** `services/server/src/skills/kobe-packages.test.ts` (1.2.0 hashes, Workbench text, no
  removed screens, no build litter); seed + fork DB tests pass with 1.2.0.
- **ac-5** sandbox: `tools/skill-draft-broker.test.ts`, `kobe-tools/skill-draft-tool.test.ts`,
  `pi/pi-launch.test.ts`, `kobe-tools.skill-draft.real-pi.test.ts` (real Pi, CI only).
- Runs: build, typecheck, lint, format:check, license:check, all unit tests (model-gateway
  `budget-gate` flaked once under load, passes alone); DB: skill-draft-tool, skill-drafts,
  skill-drafts-starts, file-share, policy, sandbox-wire, project-propose; db probe suite.
