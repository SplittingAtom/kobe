# KOBE-623: KA-6 web (approval card, switches, audit via agent, shared-thread redaction)

- **Status:** committed on `kobe-623-admin-web` (from group branch `kobe-admin-mcp` at 7115a94a)
- **Branch / worktree:** `kobe-623-admin-web` in `../Kobe-wt623`
- **Depends on:** KOBE-619 (host, guard), KOBE-620 (docs tools), KOBE-621 (team tools); spec
  `docs/specs/kobe-admin-mcp.md` §6, §7, §8, §11 KA-6, decisions KA5, KA6, KA7

## What landed

- **Admin change card** (ac-1, ac-2): `approval.requested` gains optional `admin: {scope,
scope_label, summary}` (`@kobe/protocol` `kobeAdminApprovalSchema`, additive). The broker builds
  it in the approval's own team transaction for a `kobe_admin_write` ask
  (`kobe-mcp/approval-card.ts`): the tool's catalog `summary(input)` with ids replaced by names
  (`user_id`, `connector_id`, `team_id`, `invitation_id`, `request_id`; agents, schedules and
  skills keep ids), scope `Team <name>` or `Whole site`. The web card
  (`components/chat/approval-card.tsx`) shows "Admin change:", scope, summary, a before → after
  table read from the input (`lib/chat/admin-change.ts`) and the exact input; it never asks for
  remember options, never shows remember controls or "Approve all waiting".
- **Team console › Connectors** (`components/admin/team/kobe-connector-card.tsx`): Kobe card with
  Docs only / Read / Read and write (default docs), editable with `team.connectors.manage`,
  read-only otherwise, warning while the site switch is `docs`, hidden while `off`. Server:
  `GET/PUT /v1/team/connectors/kobe` (`team.read` / `team.connectors.manage`, `expected_level`
  → 409 `changed_since_approval`), audited `mcp.kobe.team_level_changed {from,to}` (new action).
- **Site console › Settings**: `kobeMcpMode` (off / docs / admin) on `GET/PUT /v1/site/settings`
  (`site.settings.manage`), audited `site.settings.updated {setting: kobe_mcp_mode}` (enum
  value added); form hidden on servers that predate it.
- **Audit via agent** (`audit/via-agent.ts`, both `/v1/team/audit` and `/v1/site/audit`): events
  with `target.viaAgent` get `viaAgent {threadId, runId, toolCallId, threadOpen}`; `threadOpen` only
  for an active member of the event's team who may read the thread (`findThreads`, owner or
  shared). Web: "via agent", "open the thread" link only when `threadOpen`, run and tool call ids.
- **Shared-thread redaction, server-side** (`threads/admin-redaction.ts`): a reader (not the
  owner) without the tool's permission now (team role / site role; unknown Kobe tool names hidden,
  docs tools never) gets "Admin result hidden" in place of content and `details`: entry list
  (`GET /v1/threads/:id`, `/entries`, flag `admin_result_hidden`), full output route, the run event
  stream (`tool.result` preview; gate re-read at each revalidation) and a reader's fork (copied
  payload redacted). `openapi.json` regenerated.
- **Composer / creator** (ac-6): `/v1/threads/connectors` lists the built-in first with
  `builtin {kind: kobe, admin: off|read|read_write}` (what the member would get now); it has no
  toggle (409 `connector_always_on`; `connectors_off` at creation refused 422). The + menu shows
  it as "Docs always on" plus the admin line. The agent creator offers `kobe` by name (team console
  and My Agents; not gallery): choosing it adds Kobe's admin tool names; whenever the allow list
  narrows anything, the docs tools are named too (`withKobeDocs`), and leave when nothing else is.

## Decisions / deviations

- The thread toggle cannot turn Kobe off (docs always on, KA7); admin tools follow the site/team
  switches and the person's role, not a per-thread switch.
- The team level stays console-only (KA-4 left it out of the tools); the site switch likewise.
- Redaction blind spot: an _offloaded_ entry body (blob, none written today) is not inspected when
  a reader forks; the output route does redact offloaded outputs (it reads the body first).
- Base fix: removed an unused `routeCaller` import in `kobe-mcp.db.test.ts` (lint was red).
- Server typecheck needs `NODE_OPTIONS=--max-old-space-size=6144` on the 7 GB GSD box (baseline
  without this ticket OOMs too).

## Security review fixes (KA-4/5/6 review, after merging `kobe-admin-mcp`)

- HIGH: `entry.committed` events carry the stored entry (≤ 64 KB): `redactEvent` now redacts their
  payload too (live and replayed `/runs/:id/events`). Other entry carriers checked: entry list,
  output route and fork (redacted), export, context viewer and eval-case copies (owner only),
  thread search, cards and message reads (user/assistant text only), notifications (no entries).
- MEDIUM: conditional suspension reads the team roster entry first: a proposal is never suspended
  (`roster_entry_not_found`, as the console) nor approved by a resume (409).
- LOW: card names via `team_members` for team tools, `team_id` only for site tools, shown quoted
  with a short id; `setTeamModel` insert-if-absent and `setMemberBudget` insert answer 409 on a
  concurrent insert; Registry claim/decide/reject-and-block (`expectedState` / `expected_state`)
  and site invite revoke (`expectedEmail`) checked by the routes under their lock; team audit
  target stripped of IP/UA at any depth; connector URLs as origin + path; branding before-state
  compared key-order independently (tool and route).

## Residual (for KA-7's guide page)

- Compaction and branch summaries, and the assistant's own prose, can restate an admin result;
  they are not redacted and are copied into a reader's fork.

## For KA-7 (guide pages to update for this ticket)

- New `admin/admin-from-a-conversation.md`: the Admin change card (scope, summary, before →
  after, exact input; never remembered or bulk-approved), the two switches and where they live,
  audit "via agent" with the thread link rule, shared threads showing "Admin result hidden".
- `admin/team-admin.md` (Connectors section: the Kobe card and its three levels),
  `admin/site-admin.md` (Settings: Kobe connector off / docs / admin, default docs).
- `connectors-and-apps.md`: the built-in Kobe row in the + menu (always on, admin line) and in the
  agent creator (docs tools kept named when the allow list narrows).
- `internet-and-approvals/*` (approvals page): admin approvals are never remembered nor in
  Approve all.
- Sharing page (`conversations/sharing` or equivalent): admin results hidden from teammates
  without the permission, also in their copies; the owner sees everything.
- `reference`: audit `viaAgent` on team/site audit responses; events `mcp.kobe.team_level_changed`,
  `site.settings.updated` `kobe_mcp_mode`; `approval.requested.admin`; entry `admin_result_hidden`.

## Evidence

- Server db: `services/server/src/kobe-mcp-web.db.test.ts` (card with names; level and site
  switch round trips + audit + 403/409/400; via agent for owner, other admin, shared, outside site
  admin; redaction in entries/thread/output/fork/event stream, owner and permitted reader see all;
  composer Kobe row, no toggle, gone when `off`).
- Server unit: `kobe-mcp/approval-card.test.ts`, `threads/admin-redaction.test.ts`; protocol
  `events.test.ts` (admin card schema).
- Web: `approvals.test.tsx` (Admin change), `team-connectors-page.test.tsx`, `site-pages.test.tsx`,
  `via-agent.test.tsx`, `plus-menu.test.tsx`, `agent-creator.test.tsx`,
  `lib/chat/admin-change.test.ts`, `lib/admin/agent-builder/tool-lists.test.ts`.
