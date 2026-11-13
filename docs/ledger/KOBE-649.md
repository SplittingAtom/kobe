# KOBE-649: SMA11d: Semantic memories in the personal data export

- **Status:** in review (committed locally on the branch; coordinator opens the PR)
- **Branch / worktree:** `kobe-649-sm-export` in `../Kobe-wt649`
- **Depends on:** KOBE-378 (item store), KOBE-376 (tables). No migration.

## Plan

- `services/server/src/memory/items-export.ts`: page through the person's `user` items in the
  exported Workspace, then their portable items, each with every kept version.
- `retention/export.ts`: stream them as `memory-items.json` next to `memory/` (same streamed
  JSON shape as `feedback.json` / `eval-cases.json`), README line; `recordExport` counts them.
- Audit: `thread.exported` gains an optional `memoryItems` count (`packages/db` audit events,
  `docs/audit-log.md`). No new action: the memories are part of the same download.
- Guide: `docs/guide/chat/threads-panel.md` (the page that documents **Export my
  conversations**); its summary feeds `/llms.txt`, so both change.

## Decisions

- **Scope follows the export's existing rule.** The personal export is per active Workspace
  (threads, Notes, projects, feedback all name `viewer.teamId`), so the Workspace part is the
  person's `user` items in that Workspace, read inside `withTeam(viewer.teamId)`, and the person
  exports each Workspace they belong to from that Workspace. I did not loop over every
  membership: that would make one Workspace's export carry another's content and break the
  "one team per archive" rule of the README. Portable items follow the person and are in every
  Workspace's export (rows confined by `owner_user_id`, the item store's `locate()` filter).
- **Workspaces the person left:** like Notes, not exported. The route needs a current membership
  (`c.get("team")`), so a left Workspace's `user` items can't be exported by the person; they stay
  under that Workspace's retention / offboarding (KOBE-386). Portable items still export.
- **What's in an item:** id, scope (`user`|`portable`), kind, status (all statuses, archived and
  superseded too: it is the person's data), current statement, tags, pinned, `as_of`,
  `superseded_by`, current version number, created/updated, and `versions` oldest first
  (statement, actor_kind, lint/policy overrides, created_at, provenance, evidence). Versions
  pruned past the Site cap are simply absent.
- **Excluded:** `team` (Workspace) and Site items, other people's items, author ids (always the
  person), `pass_id`.

### Privacy review fixes (`docs/ledger/review-649.md`, kept untracked)

- **H-1 forks:** a cited entry counts as the person's only in a thread they own, as a `user`
  message, and in a fork only when written after the fork: `created_at > thread.created_at`
  (copies keep the source's time) **and** `seq >` the seq of `forked_at_entry_id` (the fork point;
  kept even when the source is purged). The person's own messages copied into a fork are dropped
  too (safe side). Test: fork of another member's shared thread.
- **M-1 quote text:** a quote is kept only if, normalised, it is a substring of the cited entry's
  normalised text (Pi content string or text parts). KOBE-379's shared normaliser is not on main
  yet, so `normaliseQuote` (NFKC, typographic quotes/dashes, whitespace, lower case) stands in;
  swap it in when it lands. Offloaded entries with no stored content: quote dropped.
- **M-2 bounds:** items 100 per page; versions read 1,000 per transaction with a keyset on
  `(item_id, version)`; cited pairs checked 500 per query, source threads 500 per query; each item
  yielded as soon as its last version is read. Failure mode: `memory-items.json` comes after the
  threads, so a DB error there errors the response stream (`trackedDownload` without a tail,
  `export-stream.test.ts`): the zip has no central directory and the download fails visibly;
  it is never closed as a valid but short archive. Test: one item with 2,101 versions, each with a
  quote (2,100 pairs), plus a following item.
- **L-1 authors:** only versions whose `actor_user_id` is the person, whatever `actor_kind`
  (`user`, `import`, `pass` are all the person's own action: the store writes the caller). Others
  are left out and counted in the item's `notes`; when someone else wrote the current version,
  `statement` is null. Portable versions are bound to the owner by key already.
- **L-2 thread ids:** `source_thread_id`/`source_entry_ids` only when the source thread is one the
  person owns in this Workspace; a shared thread of another member is not named at all.
- **L-3 replacements:** `superseded_by` kept only when it is one of the person's items of the same
  scope (so in the archive); otherwise null with a note.
- **Legal holds:** no effect on what is exported (nothing in the path reads holds).
- **Audit:** `thread.exported.memoryItems` = the person's `user` items in the Workspace plus their
  portable items, counted in the same transaction as the thread counts. Optional in the schema so
  older rows still validate.

## Open questions (for Chris or the coordinator)

- KOBE-390 must keep `quotesOf` in step when it fixes the evidence shape (or move the reader
  next to the contract). Flagged in a comment on `quotesOf`.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `services/server/src/memory-items-export.db.test.ts` "holds the person's Workspace and
  portable items with versions…": user fact with 2 versions (archived), portable preference;
  portable item also in the export from Workspace B.
- **ac-2** same test: other person's user/portable items, Workspace item, Site item and the
  person's Workspace-B item absent (text checked against the raw JSON); "keeps evidence quotes
  only from the person's own messages": assistant entry, another person's shared-thread message,
  missing entry, wrong-thread and paraphrased quotes dropped, fork copies dropped; "leaves out
  versions someone else wrote and replacements outside the archive"; "streams items with more
  versions than one batch". Unit: `memory/items-export.test.ts`.
- **ac-3** "is audited with the number of memories": `thread.exported` target
  `{ threads, entries, memoryItems }`, no text.
- **ac-4** `docs/guide/chat/threads-panel.md` body + summary (→ `/llms.txt`), export README in
  the zip, `docs/audit-log.md`.
- Verify: see the commit report.
