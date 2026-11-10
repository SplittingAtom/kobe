# KOBE-592: PC-5 proposal card for project files; Accept commits

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** in review (built on waves 1-2, KOBE-591)
- **Branch / worktree:** `kobe-592-proposal-card` in `../Kobe-wt592`
- **Depends on:** KOBE-591 (server routes and event fields)

## Plan

Spec `docs/specs/projects-in-conversations.md` PE4, PE5, section 11. Web only (`apps/web`).

## What changed

- `components/files/file-edit-card.tsx`: a proposal with `project_id` or no base (a new file) is
  "inline": the card reviews it itself (no editor tab). Names: "Proposed edit to <file> in
  <Project>", "Proposed new file <file> in <Project>", "Proposed new file <file>" (My files).
  Ordinary My files edits keep the editor path and its diff (unchanged).
- `components/files/proposal-inline-review.tsx` (new): line diff against the project head, the
  commit message field (prefilled from the summary, max 500), Accept, Reject, Close, and the
  outcomes: "Committed as #<seq>" + "Open History" link, stale text, not-allowed reasons in words.
- `lib/files/line-diff.ts` (new): small LCS line diff (head/tail trimmed, size-capped fallback).
- `lib/projects/commits-api.ts`: `commitFromProposal`. `lib/chat/session.ts`: `commits()`.
- `lib/files/editor-state.ts`, `lib/chat/api.ts`: `ProposalView` gains `proposalId`, `projectId`,
  `baseCommitSeq`, `isNew`; the proposals list keeps them. `FileReviewStore.record` ends a
  proposal without the editor.
- `lib/api/client.ts`: `ApiError.reason` (the 409 body's `reason`, <= 64 chars).
- `components/projects/project-detail-page.tsx`: `#history` opens the History tab.
- FakeKobe: project heads, history/file-at-head reads, from-proposal route, create-only save.

## Decisions (spec silent)

- The diff base is the project's current head (history page 1, then the file at that seq), not
  the proposal's `base_commit_seq`; the server decides staleness at Accept. A missing file reads
  as empty.
- Not-allowed wording: moved "This conversation is no longer in that project, so the edit cannot
  be committed there."; no_edit_access "You no longer have edit access to this project.";
  archived "This project is archived and read-only."; not_a_project_proposal "This proposal is
  for your own files, not a project."
- New-file proposals in My files use the existing save route without a base (409 -> "A file with
  that name now exists. Ask the agent to propose again."). No commit message field there.
- Inline proposals are never auto-opened by "Open edits automatically" (no editor to open).
- The History link is `/me/projects/<id>#history` (hash, client-read; no query param).
- Events recorded before KOBE-591 have no `proposal_id`: Accept says the proposal is too old.

## Evidence

- ac-1..ac-3: `components/files/file-edit-project-card.test.tsx` (11 tests), `lib/files/line-diff.test.ts`.
- ac-4: `vitest` on components/files, components/chat, lib/projects, lib/files, lib/chat;
  `tsc --noEmit -p apps/web`, eslint, prettier on changed files. `pnpm verify` not run here.

## Open questions

- Reject is still client-only: a rejected proposal stays acceptable through the API (KOBE-591 note).
- Reviewing a project proposal in the artifact panel (editor diff) is not offered; the card is the
  only place.
