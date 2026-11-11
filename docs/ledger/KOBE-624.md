# KOBE-624: KA-7 browser spec and guide (Kobe admin MCP)

- **Status:** committed on `kobe-624-admin-spec` (from group branch `kobe-admin-mcp` at f15893ae)
- **Branch / worktree:** `kobe-624-admin-spec` in `../Kobe-wt624`
- **Depends on:** KOBE-618..623; spec `docs/specs/kobe-admin-mcp.md` §11 KA-7, §12

## Browser spec (`e2e/browser/tests/kobe-admin-mcp.spec.ts`, not run here; coordinator on gate1)

Each test sets the site switch (`PUT /v1/site/settings {kobeMcpMode}`) and the team level
(`PUT /v1/team/connectors/kobe {level}`) and restores both in `finally`. Preconditions checked via
`GET /v1/threads/connectors` (the Kobe row's `builtin.admin`).

- (a) owner → member2 member → contributor: "Admin change" card (Scope `Team <name>`, summary with
  member2's name and `Member → Contributor`, Before and after row role member/contributor, no
  Remember checkbox, no Approve all), Allow, role via `GET /v1/team/members`, a
  `team_members_set_role` call in the thread entries, `GET /v1/team/audit?action=identity.member.role_changed`
  event with `viaAgent.threadId`, Team console › Audit `[data-kobe-via-agent]` with "open the
  thread" → `/?thread=<id>`; member2 restored to member (`PATCH /v1/team/members/:id`).
- (b) member2 (second browser): Kobe row `admin: off`, no admin card, no `mcp__kobe__` non-docs
  call in `GET /v1/threads/:id/entries`, owner's role unchanged.
- (c) how-to: a `docs_*` call in the entries, no non-Kobe tool call whose args mention llms.txt or
  `/docs/`, answer text or links contain `/docs/<slug>`.
- (d) team level docs: Kobe row `admin: off`, no admin call, member2's role unchanged.
- Assumes Team1's default agent uses the kobe connector (gallery agent Kobe: `connectors: all`).

## Guide

- New `admin/admin-from-a-conversation.md` (spec §12 name; section Team admin, audience admin):
  who the agent acts as, the two switches and defaults, what can be done (team and site), what
  stays console-only (KA8 + ledgers' left-out lists), the Admin change card, limits 60/min 30/h,
  audit "via agent", shared-thread redaction and the residual (prose, compaction and branch
  summaries restate results; copied into forks).
- Updated: `for-agents/working-in-a-sandbox.md` (new section "The kobe connector": docs always,
  admin only when listed, act as the person, writes ask, before-state, paging, error meanings),
  `for-agents/concepts.md`, `for-agents/reading-the-docs.md` (link only; KA-3 rewrote it),
  `internet-and-approvals/approvals.md` (Admin changes; never remembered),
  `internet-and-approvals/internet-access.md`, `agents/skills.md` (kobe-guide, review from a
  conversation), `admin/team-admin.md`, `admin/site-admin.md`, `connectors-and-apps.md`,
  `chat/sharing-and-branches.md`, `reference/troubleshooting.md`, `glossary.md`.
- Not done: no audit/events reference page exists in the guide, so `viaAgent`, reason codes and
  `admin_result_hidden` are not documented as a reference (the agent page lists the reason codes).

## Checks

`pnpm run build` (guide frontmatter and links), `pnpm run format:check`,
`scripts/check-public-hygiene.sh`, `node scripts/check-site-wording.mjs`, `@kobe/guide` tests,
web `lib/docs` tests, server `kobe-mcp/docs` tests; spec: `tsc -p e2e/browser`, eslint, prettier.

## Run on gate1 (2026-11-11, coordinator)

Pre-migration dump kept: compute1 ~/kobe-gate1/backups/kobe-pre-admin-mcp-2026-11-11.sql.gz. Group branch
deployed as local-f15893aef8b7 (migrations 0207, 0208: kobe connector row, kobe-guide active).
kobe-admin-mcp spec passed twice (4 tests); docs, share, remember-approvals specs pass (remember-approvals
had one model-side timeout in a combined run, passed alone). The spec restored the switches (site docs,
Team1 docs) and member2's role; audit shows identity.member.role_changed with viaAgent.
