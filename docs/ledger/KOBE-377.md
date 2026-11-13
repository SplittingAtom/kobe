# KOBE-377: SMA2: Contract — run.start.memory.semantic, item API, audit events, notification kinds

- **Status:** in review (local commit; coordinator opens the PR)
- **Branch / worktree:** `kobe-377-sm-contract` in `../Kobe-wt377` (on `kobe-376-sm-schema`, PR #531)
- **Depends on:** KOBE-376 (schema). v1.3 wave A2. No migration, no feature code.

## Plan

Contract only, in `packages/protocol/src/semantic-memory/` (items, errors, transfer, run-context,
governance) with golden fixtures in `fixtures/`; `run.start.memory.semantic` added to
`runMemoryContextSchema` (memory.ts); context-viewer lane labels (context-viewer.ts); Phase A audit
events in `packages/db/src/audit/events.ts` + `docs/audit-log.md`; OpenAPI in
`services/server/src/openapi/semantic-memory.ts` (+ regenerated `openapi.json`); a server test
keeping the contract equal to the KOBE-376 schema (`services/server/src/memory/semantic-contract.test.ts`).

## Decisions

- **Wire scopes** `user|portable|team|site` (= DB `SEMANTIC_MEMORY_SCOPE_VALUES`); people read
  `SEMANTIC_MEMORY_SCOPE_LABELS`, the one label map (`picker`: "Me in this workspace", "All my
  workspaces", "This workspace", "Site"; `section`: "... memories", also the context-viewer lane
  labels) (Q1). Steward `level` uses the wire names `team|site`. Lengths count code points, as
  `char_length` (statement ≤ 500, tag ≤ 40); statements refuse control characters except newline;
  tags are trimmed. Enums, statement/tag/source-entry limits equal the schema (server test).
  Actor kinds on the wire = union of Workspace/portable (`user|import|pass`) and Site (`proposal`).
- **`run.start.memory.semantic`** = `{items[], omitted_count}`; item `{id, version, scope, kind,
statement, policy, pinned, provenance{actor_kind, as_of, saved_on}}`. No thread links, evidence or
  names reach the sandbox. Schema checks: stable-first order (Policy, pinned, per-message picks;
  Q6), Policy only on Site, portable = preference without `as_of`, no duplicates, ≤ 100 items,
  Policy ≤ 25 items / 2 KiB of statements, Policy never pinned. The 8 KiB budget is the **rendered
  block**: `semanticMemoryRenderedBytes()` = 256 B block + 160 B per lane (Policy or scope) + 96 B
  per item + statement bytes; 382 fills to it, 383 must render within those overheads (review M2).
  New capability `semantic_memory` (implies `memory`: `semantic` travels inside `run.start.memory`):
  the server sends `semantic` only to agents that list it (old agents parse run.start strictly). With Notes switched off, `scopes`/`indexes` are empty.
- **Item API** (`/v1/memory/semantic/items`, so no Notes route `/v1/memory/:id` can answer it —
  review M1, request-level test in `document.test.ts`; one surface over the three tables; scope in the path for item
  routes because ids live in different tables): list (status default active, kind, pinned, policy,
  q, cursor, limit ≤ 100), create (`supersedes_id`, source links for user/team only, `overrides`
  `{lint, policy_conflict}`), get (versions newest first), patch (`expected_version` required),
  archive, restore (= un-archive), revert (Undo = new version copying an earlier one), pin
  `{pinned}`. List carries `usage {count, max, policy_count?, policy_bytes?}` for the 80% notice.
  Evidence quotes are not exposed yet (Phase B, KOBE-390). Responses enforce the DB rules (owner
  exactly for user/portable, portable preference without `as_of`, Policy only Site and unpinned,
  `superseded_by` exactly when superseded) and the walls (review M6): portable/Site versions carry
  no thread links; Workspace links go to the author and curators only (null otherwise); Site items
  shown in a Workspace carry no author ids (`updated_by`/`actor_user_id` null except for Site admins
  and stewards). Stored-item rules a body can't see (portable kind/`as_of`, `policy` off Site) are
  `invalid_request`.
- **Import/export** (`/v1/memory/semantic/{import/preview,import/commit,export}`): JSON and CSV
  carry the same columns `ref,kind,statement,tags,pinned,as_of,policy,status,superseded_by` (tags
  `;`-joined), so status and supersession round-trip (`ref` = item id, links supersession inside the
  file; import makes new ids). CSV export prefixes `'` to cells starting `= + - @ TAB CR`; import
  strips it (`neutraliseCsvCell`/`restoreCsvCell`, `semanticMemoryExportToCsv`, golden
  `fixtures/export.csv`). > 1,000 rows or 1 MiB: `memory_import_too_large` (413), nothing read.
  Preview rows carry `policy`; statuses `new|duplicate|warning|invalid|blocked`. Commit is
  all-or-nothing: `memory_import_stale` (rows named), `memory_scope_full` (with `capacity`) or
  `memory_policy_budget_full` saves nothing; the answer is `{created, item_ids}`. No model check
  (Q10). JSON export `format: "kobe.memory.v1"` is also an import file; no authors/links.
- **Errors:** the six from the brief plus `memory_lint_warning`, `memory_version_conflict`,
  `memory_item_not_found`, `memory_not_allowed`, `memory_item_inactive`, `memory_import_invalid`,
  `memory_import_too_large`, `memory_import_stale`, `memory_policy_not_pinnable`, each with an
  HTTP status (`memory_disabled` 403, as the Notes routes); details `warnings[]`,
  `policy_conflicts[]`, `capacity`, `current_version`, `import_rows[]`.
- **Stewards:** `MEMORY_STEWARD_SITE_GRANT = "memory_steward"` (not in `SITE_GRANTS` yet: a server
  test keeps that equal to the DB enum, so KOBE-380 adds it with its migration). Workspace
  steward routes `/v1/team/memory/stewards[/{userId}]`, Site list `/v1/site/memory/stewards`;
  grants go through the existing site-roles grant route.
- **Agent-version setting** `all|notes_only|off` (`agentVersionMemoryFieldSchema`, absent = `all`);
  KOBE-646 adds the column and the field to the agent version shapes.
- **Audit (registered now, scope `any`: team for Workspace items, site for portable/Site):**
  `memory.item.{created,updated,reverted,archived,restored,pinned,unpinned,superseded}`,
  `memory.items.{imported,exported}`, `memory.policy.set` (site), `memory.policy.override`,
  `memory.lint.override`, `memory.steward.{granted,revoked}` (team). Ids/scopes/kinds/counts only.
  `memory.item.created` carries `pinned` and `policy` (no extra pin/policy.set row at creation).
  Names keep the brief's SM28 pattern; the SM28 text was not available to check them (M5).
  **Reserved** (`RESERVED_MEMORY_AUDIT_ACTIONS`, not registered): `memory.pass.*`,
  `memory.candidate.*`, `memory.proposal.*`, `memory.suggestion.*` (readers' Suggest, Q2),
  `memory.site_proposal.*`.
- **Notification kinds** (`MEMORY_NOTIFICATION_KINDS`, the list KOBE-645 spreads into the DB
  CHECK and protocol `NOTIFICATION_KINDS`, all phases at once so B/C need no migration):
  `memory.scope.near_full`, `memory.review.{reminder,digest}`,
  `memory.proposal.{received,accepted,dismissed}`, `memory.suggestion.{received,accepted,dismissed}`,
  `memory.site_proposal.{received,accepted,dismissed}`. Not in `NOTIFICATION_KINDS` yet (the
  notification refine and DB CHECK would refuse them).
- **Context viewer:** `CONTEXT_MEMORY_LANES` / `CONTEXT_MEMORY_SECTION_LABELS` for the existing
  `memory` kind: Saved memory (Notes, unchanged label), Policy, Site memories, Workspace memories,
  My memories in all my workspaces, My memories in this workspace. KOBE-383 teaches the splitter.
- Server test `semantic-contract.test.ts` asserts the kinds/grant are not in the DB yet;
  KOBE-645/380 flip those to `toContain`.

## Docs (no user-facing feature yet)

Guide pages later tickets must write: `docs/guide/memory.md` (Workspace memory, scopes and labels,
pin/archive/Undo — KOBE-384), import/export and Policy for admins in `docs/guide/admin/` (KOBE-385),
stewards (KOBE-380), agent-version memory setting in `docs/guide/agents/` (KOBE-646), context viewer
memory sections (KOBE-382/383), notifications (KOBE-645); `/llms.txt` follows the guide.

## Open questions (for Chris or the coordinator)

1. SM28's exact audit names were not available offline; kept the brief's pattern (coordinator
   2026-11-13). Rename before KOBE-378 writes rows if SM28 differs.
2. Resolved 2026-11-13 (coordinator): Policy items are never pinned (always in context); refused with `memory_policy_not_pinnable` (409); schemas refuse `policy && pinned`.

3. Review L10 (open): portable item events are `site` events, so Site admins see that a person
   has a portable preference and its kind (never the statement); the Workspace steward events are
   registered ahead of KOBE-380. Both kept; confirm.
4. Review L7 (not done, optional): archive/restore/pin take no `expected_version`.
5. Review L8: `openapi.json` has no reflow. `git diff --histogram` (or `--patience`) shows pure
   insertions (2,611 lines); git's default diff misaligns repeated JSON lines.

## Evidence (acceptance criteria → test or command output)

- Review fixes: `packages/protocol/src/semantic-memory/review-rules.test.ts` (M2-M6, lows).
- ac-1: `packages/protocol/src/semantic-memory/semantic-memory.test.ts` — 27 golden fixtures
  parse and round-trip (run.start, every item endpoint, import/export, errors, stewards, agent
  setting) plus rule tests.
- ac-2: same file, "run.start.memory.semantic is additive": `fixtures/run-start-legacy.json`
  validates with `runStartFrameSchema` and `decodeServerFrame`.
- ac-3: `services/server/openapi.json` regenerated (`document.test.ts` KOBE-377 case); audit names
  `packages/db/src/audit/events.test.ts` (KOBE-377 case, docs list); notification kinds and labels
  in the protocol test; schema parity `services/server/src/memory/semantic-contract.test.ts`.
- `pnpm verify` (flock, no DB URL): exit 0, all turbo tasks green, hygiene and site wording ok.
