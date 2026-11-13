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
- **Provenance:** `source_thread_id` / `source_entry_ids` only on versions the person wrote, the
  item store's `detailOf` rule (ids only, no text). A `user` item may cite a thread another member
  shared (KOBE-378 L-2); the id is kept, its text is not.
- **Evidence quotes:** the evidence JSON contract is not fixed yet (Phase B, KOBE-389/390). The
  reader (`quotesOf`) accepts an array of `{ entry_id, quote, thread_id? }` or `{ quotes: [...] }`
  and drops anything else. A quote is kept only when its entry is a `user` message
  (`payload.message.role = 'user'`) in a conversation the person owns in this Workspace and it
  cites the version's own source thread. So assistant text, tool output, quotes from a shared
  thread of someone else and quotes of missing entries never reach the zip. The check reads only
  the stored row: an offloaded entry (body in object storage) whose row lacks `message.role`
  counts as not the person's message, so its quotes are dropped (safe side).
- **Legal holds:** no effect on what is exported (nothing in the path reads holds).
- **Size / streaming:** items 100 per page, one short `withTeam` transaction per page (versions
  for the page in one query, own-message check in one query), pushed into the zip page by page;
  a person has at most ~1,000 items per scope (SM21) and versions are capped by the Site.
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
  missing entry and wrong-thread quotes dropped. Unit: `memory/items-export.test.ts`.
- **ac-3** "is audited with the number of memories": `thread.exported` target
  `{ threads, entries, memoryItems }`, no text.
- **ac-4** `docs/guide/chat/threads-panel.md` body + summary (→ `/llms.txt`), export README in
  the zip, `docs/audit-log.md`.
- Verify: see the commit report.
