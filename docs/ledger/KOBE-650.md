# KOBE-650: SMA15 — Kobe admin MCP read-only memory item tools

- **Status:** committed locally (not pushed; coordinator reviews and opens the PR)
- **Branch / worktree:** `kobe-650-sm-admin-mcp` in `../Kobe-wt650`
- **Depends on:** KOBE-378 (item store), KOBE-380 (stewards), KOBE-381 (switches) — all on main
- **Migrations:** none

## What was built

Four read tools in `services/server/src/kobe-mcp/tools/memory-items.ts` on the KOBE-619
framework, each calling the Memory editor's own route (`/v1/memory/semantic/items`, KOBE-378) in
process as the delegated person:

| Tool                     | Scope / permission          | Route                                   |
| ------------------------ | --------------------------- | --------------------------------------- |
| `team_memory_items_list` | team / `team.memory.curate` | `GET /memory/semantic/items?scope=team` |
| `team_memory_item_get`   | team / `team.memory.curate` | `GET /memory/semantic/items/team/:id`   |
| `site_memory_items_list` | site / `site.memory.curate` | `GET /memory/semantic/items?scope=site` |
| `site_memory_item_get`   | site / `site.memory.curate` | `GET /memory/semantic/items/site/:id`   |

- **Permissions as in the console.** `personAllows` now uses `teamMemoryAllows` /
  `siteMemoryAllows` (plain role checks for every non-memory permission, so nothing else moves);
  `KobeAccess` gained `memorySteward` (a `memory_stewards` row, read under `withTeam` with the role).
  Workspace stewards of any role get the team tools; the `memory_steward` site grant the site tools.
- **Never personal.** The input has no scope; each tool fixes `team` or `site`, and `reduce`
  throws on a body of another scope. Defence in depth at the route: `assertAgentRead`
  (`memory/items/who.ts`), called by `routes/memory-items.ts` for every delegated request, refuses
  (403 `memory_not_allowed`) any non-GET, any `user`/`portable` scope, and a scope the person does
  not curate. So even a future tool cannot write items or read personal ones.
- **Wall M6.** Site results drop `updated_by` and version `actor_user_id` for everyone (the answer
  lands in a Workspace thread, so even Site curators get none through the tool). Site versions have
  no thread links by contract; nothing carries evidence (Phase B). Policy items are listed (filter
  `policy`).
- **Switches.** The store's own checks apply: Workspace memories off → `memory_disabled`; Site
  memories off for the Workspace → Site list holds Policy only. The Kobe MCP site/team levels apply
  as for every read tool (`read` or `read_write`).
- **Bounded.** ≤ 20 items a page (route cursor passed through), ≤ 10 newest versions plus
  `more_versions`, statements ≤ 500 code points: worst case well under 64 KiB.
- `requestNamesTeam` moved the session's active-team read out of `routes/memory-items.ts` into
  `authz/middleware.ts` (exempt in `session-contract.test.ts`), so the item routes are
  session-independent for delegations as KOBE-619 requires. Behaviour unchanged.

## Decisions

- **Four tools, not two.** The brief named `memory_items_list` / `memory_item_get` with a scope
  input; the catalog has one scope and one console permission per tool (`catalog.test.ts`:
  permission prefix = scope) and per-tool listing/redaction (`person-guard.ts`), so a Workspace
  steward and a Site steward each see exactly the tools they may use. Names follow `<area>_<verb>`.
- **Tag filter per page.** The route has no tag filter and `packages/protocol` contracts change
  only in their own PR (parallel-work.md), so `tag` filters each route page (a page may hold fewer
  rows; the cursor stays exact). A protocol `tag` query param can replace it later.
- **No `stale` filter yet.** "Stale" (`stale_after_days`, default 90) is defined by the sweeps of
  KOBE-386, which are not on main. Add `stale` here when 386 defines it (open question below).
- Guide: `docs/guide/admin/admin-from-a-conversation.md` (table row, "Memories (read only)"
  section, summary, which feeds /llms.txt). Admin MCP spec §5 unchanged (spec lives outside the
  repo; holds/break-glass still out of scope per `kobe-admin-mcp.md` §9).

## ac-3: what KOBE-406's wall probe must cover

ac-3 is satisfied when KOBE-406 adds these cases (406 owns the wall probe; nothing here blocks it):

1. Team A's curator calling `team_memory_items_list` / `team_memory_item_get` with a Team B item
   id gets `memory_item_not_found` (RLS; the delegation cannot name another team: `requireTeam`).
2. No tool output ever contains a `user` or `portable` item (list or get by id, own or others'),
   and delegated GETs with `scope=user|portable` answer 403 `memory_not_allowed`.
3. `site_memory_*` output carries no author user id (`updated_by`, `actor_user_id`) and no thread
   link / evidence / rationale, for any caller including the Site admin who wrote the item.
4. Every delegated non-GET on `/v1/memory/semantic/items/**` answers 403 (no agent write path),
   malformed bodies included.
5. `team_memory_item_get` never names a source conversation the caller cannot open.
6. A Workspace curator without Site rights gets 403 on delegated Site reads.

Today `kobe-mcp-memory.db.test.ts` already asserts 2–5 and the not-found half of 1 for personal
ids; 406 should fold them into its cross-team probe so they run with every migration.

## Review fixes (`review-650.md`, coordinator 2026-11-13)

Coordinator answers: four tools OK; `stale` → note for KOBE-386 (add the filter there once 386
defines stale); page-wise `tag` filter OK (documented above).

- **L1** statements (item and every version) are fenced as untrusted data with the sandbox's
  memory markers and a per-answer nonce (`kobe-mcp/untrusted.ts`, a server copy of
  `sandbox-agent/src/kobe-tools/memory-fence.ts`; packages can't share it today), plus
  `untrusted_notice`. **Other admin tools:** none fences free text today. Candidates that return
  text written by others: `team_skill_reviews_list`/`site_skill_reviews_list` (notes, comments),
  `team_egress_requests_list`/`site_egress_requests_list` (reasons), `team_audit_list`/
  `site_audit_list` (targets), `team_agents_list` (names). Suggest a follow-up ticket to move the
  fence to a shared package and apply it catalog-wide (output schema marker per free-text field).
- **L2** a Workspace version shows `source_thread_id` only when the caller curates the scope **and**
  can open that conversation (`findThreads`, the thread routes' predicate); else the field is
  absent. Console behaviour unchanged (`DetailView` in `memory/items/rows.ts`, only delegations
  pass `openableLinksOnly`).
- **I1** `app.use("*")` in `routes/memory-items.ts` refuses every delegated non-GET/HEAD before the
  path or body is parsed: always 403 `memory_not_allowed` (db test sends malformed bodies).
- **I2** a delegated get loads `LIMIT 11` versions; the tool shows 10 and `more_versions`.
  Deviation: no total count — the item detail contract is strict and protocol changes need their
  own PR; `more_versions` is exact without one.
- **I3** `memory-items.test.ts` maps every catalog tool (Team samples moved to
  `testing/kobe-team-samples.ts`) to its route: the ones reaching `/memory/semantic/items` are
  exactly the four reads, all GET, no body.

## Evidence (acceptance criteria → test or command output)

- **ac-1:** `kobe-mcp-memory.db.test.ts` (who lists: admin, Workspace steward, Site steward, Site
  admin, member/contributor none, revoke at once; personal/portable never returned or found;
  Policy readable; no Site author ids; switches → `memory_disabled` / Policy only; pages of 20 with
  cursor); `kobe-mcp-team.db.test.ts` and `kobe-mcp-site.db.test.ts` contract cases;
  `tools/memory-items.test.ts` (listing by access, routes, reduce walls, version cap).
- **ac-2:** `tools/memory-items.test.ts` "the memory item tool set is read-only": exactly four
  tools, none a write, every route GET, no other catalog tool named `*memory_item*`.
- **ac-3:** see above (KOBE-406).
- **ac-4:** guide page updated in the same commit (served at /docs and /llms.txt).
