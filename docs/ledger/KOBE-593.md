# KOBE-593: PC-6 Browser spec and docs for projects in conversations

- **Status:** in review (coordinator runs the spec on gate1)
- **Branch / worktree:** `kobe-593-browser-spec-docs` in `../Kobe-wt593`
- **Depends on:** KOBE-586..591 (merged into this branch); KOBE-592 (proposal card, parallel)

## Plan

`e2e/browser/tests/projects-in-conversations.spec.ts` (three tests) and docs.

## Decisions

- Test 1 (owner): two projects made through the API (A has `notes.md`, B has `readme.md`). Draft from
  `?project=A`, switch to B, Remove project, Add to a project, A again, send; title, tab title,
  project menu; Files list (dot on A, B described "Not in this conversation", read-only expand);
  `propose_file_edit` via `toolTurn` (works with the fake model and a real one); Accept; History.
- Accept depends on KOBE-592: if the card has an `Accept` button the spec clicks it, otherwise it
  calls `POST /v1/projects/{id}/commits/from-proposal` with the proposal id read from
  `GET /v1/threads/{id}/file-edit-proposals`. Remove the fallback once 592 is on gate1.
- Test 2: My files folder promoted from its row menu; checked via `/v1/projects`, the project's
  files, the folder gone from My files, and the project offered by the draft control.
- Test 3 (member2, skipped without KOBE_USER2/PW2): both projects listed, role "reader", reader's
  proposal refused (no proposal recorded, no commit, forged accept refused). The refusal text on
  screen is a soft assertion because the tool-call details may be collapsed.
- Docs: new section 3h and bullets in `docs/file-editing.md`; stale "selected-members" wording in
  `docs/approvals.md`. There is no `docs/files.md`; audit-log already marks restricted retired.

## Open questions

- Card selector `[data-kobe-file-edit*="<slug>/notes.md"]` assumes the stored path is
  `projects/<slug>/notes.md` (no `/workspace` prefix), as the existing spec does for My files.

## Evidence

- `tsc --noEmit -p e2e/browser`, prettier, eslint, `scripts/check-public-hygiene.sh`: clean.
- Playwright not run (no gate1 access here).
