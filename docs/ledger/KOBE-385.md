# KOBE-385: SMA10: Workspace and Site Memories consoles — editors, Policy, import, export

- **Status:** in review (local commit; coordinator opens the PR)
- **Branch / worktree:** `kobe-385-sm-consoles` in `../Kobe-wt385`, on `kobe-384-sm-panel`
  (KOBE-384 on KOBE-379; neither merged yet; rebase keeps only the KOBE-385 commit)
- **Depends on:** KOBE-379, KOBE-380, KOBE-384. v1.3 wave A7. No migration, no contract change.

## Plan

One commit: the import/export routes (the KOBE-377 contract had them documented but nothing
served them), the two console pages, guide, browser spec.

## Decisions

- **Server routes** (`routes/memory-transfer.ts`, mounted at `/v1/memory/semantic`):
  `POST import/preview`, `POST import/commit`, `GET export`, exactly the KOBE-377 contract
  (`transfer.ts`) and its existing OpenAPI. The item routes' Workspace resolution and refusal
  mapping moved into `memoryRouteKit()` (memory-items.ts) and are shared.
- **Reading files** (`memory/transfer/parse.ts`): JSON = an export document whose item fields
  other than `kind`/`statement` may be left out; CSV = header row naming any subset of the
  contract columns (`statement` required), so `statement,kind,tags,pinned` reads; tags split on
  `;` (or `,` inside a quoted cell). A bad row is kept as `invalid` with its reason; an unreadable
  file is `memory_import_invalid`; > 1,000 rows or > 1 MiB is `memory_import_too_large` (413).
- **Markdown** (`- [kind] statement #tag`) is turned into a JSON export in the browser
  (`lib/memory/import-file.ts`): the contract's formats stay json|csv. Tags only at the end of a
  line, so "#1 priority" mid-text stays text. The UI caps at 200 rows before sending.
- **Classification** (`memory/items/import.ts`, `classify`): scope rules first (Policy off the
  Site, pinned Policy, Policy by a non-Site-admin, portable kind/as_of, repeated ref, dangling
  `superseded_by`), then the running Policy budget down the file, then THE KOBE-379 checks
  (`evaluateMemoryWrite` + `importRowStatus`); repeats inside the file are near-duplicates. No
  model call (Q10). Extra issue codes: `invalid_row`, `secret`, `policy_conflict`,
  `policy_off_site`, `policy_pinned`, `policy_not_allowed`, `policy_budget`, `portable_kind`,
  `portable_as_of`, `ref_repeated`, `superseded_by`. A blocked row's statement is replaced
  (`[withheld: looks like …]`), never echoed.
- **UI classes** (`rowClass`): new; near-duplicate (`duplicate`); conflicts with Policy
  (`warning` + `policy_conflict`); flagged by checks (other `warning`); secret (`blocked`);
  blocked by Policy rules (`invalid` with a `policy_*` code); can't be read (other `invalid`).
  The console commits **new rows only** ("commit clean rows").
- **Commit** is all or nothing under the scope lock (and the Policy lock when Policy rows are
  accepted): rows classified again; an accepted row that is invalid/blocked, a warning without
  overrides, or a duplicate without `overrides.lint` → `memory_import_stale` with `import_rows`
  (so "became a duplicate since the preview" is caught: the console never sends overrides). Then
  room (`assertRoom`), pins (≤ 10 pinned active), Policy budget (`memory_policy_budget_full`),
  inserts with `actor_kind='import'`, overrides recorded/audited like a save, superseded rows
  linked to their accepted target, near-full notice, audit `memory.item.created` per row and
  `memory.items.imported {created, skipped}`. `items/write-paths.test.ts` lists `import.ts` as a
  writer and checks both paths run `classify`.
- **Export**: personal scopes the owner's own; Workspace/Site only for curators (`curates()`),
  else `memory_not_allowed`. Audited `memory.items.exported`. Attachment, `no-store`.
- **Who sees what (web)**: Team console Memory section now needs `team.memory.curate` (Team
  admins and Workspace stewards; stewards see only it); tabs Memories / Import and export
  (curators) / Settings (`team.memory.manage`). Without curate a row has no actions. Site memories
  in the Workspace console are read-only; **Site Policy** is listed read-only for Team admins.
  New Site console section **Memory** (Governance; `minRole: admin`, grant `memory_steward`):
  curators act; only Site admins/Owner get the **Policy** toggle, the add form's Policy box and
  actions on Policy items (server guard `site.memory.policy` unchanged). Policy budget meters
  (items/25, bytes/2,048) warn from 80% using the list's `policy_count`/`policy_bytes`.
- **Reuse**: KOBE-384's `ItemRow` (+ `readOnly`, `canSetPolicy`, Policy badge/toggle; superseded
  rows have no actions), `UndoBar`, `UsageNotice`, `CheckProblem`, `DraftFields`, the one scope
  label map. Filters: scope, kind, status, Policy (server); tag on the loaded rows (no tag query
  in the contract; changing it needs its own contract PR).
- **Site console and the team header**: writes in a session with an active Workspace need
  `X-Kobe-Team`, so the Site page sends the session's active Workspace (`/v1/me/teams`).
- **Curation vs switches (coordinator 2026-11-13):** Site curators curating Site items use the
  Site's switches only, never their active Workspace's (`items/context.ts` `inStore`); switches
  govern what reaches runs. Supersedes KOBE-378 review L-4 (test updated). Workspace items never
  depended on the Workspace's Site memories switch. Test: transfer db test "curation ignores…".
  Rebased on main with KOBE-650: a Kobe admin tool's call (`MemoryWho.viaAgent`) keeps the
  Workspace's switches (it reads what that Workspace's runs see), and `refuseAgentWrites` (403
  before the body) also guards import, commit and export (kobe-mcp-memory db test).
- **TODO (KOBE-386)**: the status filter has no "stale" yet — KOBE-386 defines staleness; add it
  to `STATUS_LABELS` in `components/memory/curator-memories.tsx` (or a separate filter) then.

## Security review fixes (review-385, untracked; no C/H)

- **M-1** `bodyLimit` on `/import/*` (2 MiB + 64 KiB, 413 `memory_import_too_large`).
- **M-2** per-person rate limits (preview 20/min, commit 10/min, export 20/min; 429
  `rate_limited`); near-duplicates and Policy lexemes prefetched in one query each
  (`findNearDuplicatesMany`, `readPolicyAndLexemesMany`, `CheckMemo` in `checks.ts`), egress model
  read once; every accepted row (archived/superseded too) needs room under the scope cap.
- **L-1** secret scan (statement + tags) runs first on every row; a blocked row's text and tags
  are withheld. **L-2** Policy rows follow the Policy switch (`policy_disabled`), others the
  scope's (`scope_disabled`); a Site import of Policy alone works while Site memories are off.
  **L-3** in-file repeats carry `near_duplicate` in their findings (lint override recorded and
  audited). **L-4** export is `POST /export` (body = the query's fields; OpenAPI + web updated).
- **Info** JSON BOM stripped, JSON row count checked before mapping, CSV formula leads include
  full-width forms and leads after spaces (protocol `FORMULA_LEAD`), conflict wording.

## Open questions (for Chris or the coordinator)

- Rows left out of an import (near-duplicates, warnings) are added one by one with Save anyway;
  the commit API supports `overrides` for a bulk "save anyway" if wanted later.

## Evidence (acceptance criteria → test or command output)

- **ac-1** `apps/web/components/admin/memory-consoles.test.tsx` (curator acts with Undo; steward
  no Settings; member read-only; Site memories read-only in the Workspace; Policy text read-only;
  Site steward gets no Policy toggle and no actions on Policy); nav
  `lib/admin/nav/registry.test.ts` (stewards see only Memory).
- **ac-2** `services/server/src/memory-transfer.db.test.ts` (seeded file → new, near_duplicate,
  lint, policy_conflict, secret, policy_off_site, invalid_row; commit only accepted clean rows;
  stale on a blocked or became-duplicate row; JSON re-import); `memory/transfer/parse.test.ts`;
  web `lib/memory/import-file.test.ts` and the Import tests (only preview + commit are sent).
- **ac-3** db test "export" (JSON/CSV, curators only, audited; Policy rows only for Site admins);
  web Site page tests (Policy toggle for admins only; export).
- **ac-4** guide: `docs/guide/admin/team-admin.md` (Workspace memories section, summary → llms.txt),
  `docs/guide/admin/site-admin.md` (Memory page, steward wording, summary), `docs/guide/memory.md`.
- Browser spec: `e2e/browser/tests/memory-consoles.spec.ts` (curator import + Policy toggle; to
  run on gate1 after deploy).
