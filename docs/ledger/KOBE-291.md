# KOBE-291: Console sections still "coming soon" although their tickets are done

- **Status:** done on branch, awaiting review (group 7, not pushed)
- **Branch / worktree:** `group-7-consoles` in `../Kobe-g7`, on top of KOBE-294..296
- **Depends on:** KOBE-15/17 (audit API, chain v2), KOBE-11 (backup CLI), KOBE-86/94/180 (inventory)

## What was built

- **Site Audit log** (`/admin/site/audit`, `components/admin/site/audit-{page,filters,events,integrity}.tsx`,
  `lib/admin/api/site/audit.ts`): read-only view of `GET /v1/site/audit`, newest first, "Load more"
  paging (`before` = `nextCursor`) that keeps the filters the page was read with. Filters, all
  applied by the server: action (exact name, checked against a name pattern before sending),
  category, actor (site users), team (site teams), From/To (`datetime-local` → ISO). Columns: seq,
  time, actor (name, email; "Kobe (system)"), team ("Site" for null), action, details, client.
  Chain status from `GET /v1/site/audit/integrity`, only on **Verify chain** (coordinator,
  2026-10-16): "Not verified yet" until then (the API keeps no last result), then verified (count, head `seq:hash`, attestation MAC to record off the box), broken
  (first bad event and what it means, as an error), or the server's 3/min refusal (a warning).
- **Site Backup and restore** (`/admin/site/backup`, `components/admin/site/backup-page.tsx`,
  `lib/admin/api/site/backup.ts`): status (last `platform.restore.completed` from the audit log:
  when, backup time, operator, rows/tables, restored audit head; whether the deleting jobs are
  paused, from `GET /v1/site/retention`), then the back-up and restore steps with placeholders only
  and a pointer to `docs/backup-restore.md`. Nav label "Backup status" became "Backup and restore".
- **Team Inventory** (`/admin/team/inventory`, `components/admin/team/inventory-page.tsx`): the
  KOBE-86 agent inventory (owner, scope, status, versions, runs, last run, tokens, schedules, Orbit
  score; suspend/reactivate with confirm; Orbit export) moved here from the Team agents page, plus
  the team's skills (`/v1/skills?scope=team`: slug, description, latest version, updated, link) and
  its enabled connectors (`/v1/team/connectors`: site status, exposure, tool count, tools awaiting
  re-approval). The Agents page links team admins to it. Its tests moved to
  `team-inventory-page.test.tsx`.
- **Guard** (`lib/admin/nav/registry.test.ts`): a placeholder must name a ticket listed in
  `OPEN_PLACEHOLDER_TICKETS` (with why it is open) **and** without a ledger in `docs/ledger`
  (a ledger means work started or finished: build the page or drop the entry); a listed ticket no
  placeholder names fails too. Proven by pointing web search at KOBE-15 (fails on both counts).
  Hadron isn't reachable from unit tests, so the ledger stands in for "done".
- **Web search on hold:** `onHold(ticket, reason)` (types.ts) marks a placeholder paused on purpose;
  Site web search (KOBE-63) shows "on hold" in the nav, the overview and its page, with the reason.

## Decisions

- **Backup: kept, not removed.** Spec §6.1 lists `backup-status` under the site API and the
  registry's §6.1 test lists `backup`. The server can't know a backup's status (the CLI uses a
  read-only `BYPASSRLS` role and writes elsewhere), but it does know the last restore (an audit
  event) and the retention pause, both of which matter during a restore. So the page shows those,
  says plainly that backups are invisible to the site, and gives the steps. No server change.
- **Inventory: kept** (spec D19 "agent inventory", D32 "schedules appear in the team inventory").
  Schedules are shown per agent (as the API returns them), not as a separate table: the
  Schedules page already lists and pauses them, and the inventory links there. Skills and
  connectors are compact read-only lists linking to their own pages (no per-skill usage calls).
- **No server change.** The audit API already has every filter (action, category, actorId,
  teamId, since, until); permissions are unchanged (site.audit.read, team.agents.suspend).
- **IP and user agent:** shown only while `now - at < auditPiiRetentionHours` (from
  `GET /v1/site/settings`; default 12 if the field is absent), even if the server still returned
  them (the sweep runs periodically, and held rows keep values: the export has those). If the
  setting can't be read, none are shown and the page says why.
- **Plain text and redaction:** the client keeps only the fields it shows (`pick()` in the API
  client), so `prevHash`/`hash` or anything the server adds later never renders; target values
  render as text nodes (strings as-is, others as JSON), never as markup or links. Tests cover
  `<img onerror>`, `javascript:` and extra fields.
- **Integrity on demand** (coordinator, 2026-10-16): no check on open; "Verify chain" runs it
  and the latest result stays with when it ran (the attestation time). The API stores no last
  result, so a fresh page says "Not verified yet". A 429 shows "Try again in a minute" as a
  warning and keeps the previous result.

## Tests and evidence

- `components/admin/site-audit-page.test.tsx` (12): section gating (admin/owner yes, user no),
  rows and columns, read-only (GET only), no chain check on open, Verify chain verified/broken
  with time, 429 keeps the last result, all six filters in
  the query, Clear, client-side validation (no request), paging keeps filters, 5xx hidden,
  erasure window, unknown erasure period, plain text and dropped fields, helpers.
- `components/admin/site-backup-page.test.tsx` (4): ready section, last restore, never restored,
  paused, steps and docs pointer, no host/IP/URL on the page, refused audit read shown.
- `components/admin/team-inventory-page.test.tsx` (9): the moved KOBE-86/94/180 tests plus skills,
  connectors (enabled only, disabled by site, custom count, drift), empty and failed lists, links.
- `team-pages.test.tsx`: Agents page no longer requests the inventory and links to it.
- `overview.test.tsx`, `console-shell.test.tsx`: on-hold text in the overview, nav and page.
- e2e (gate1, later): `e2e/browser/tests/console-sections.spec.ts` opens the three pages (chain
  status, a category filter checked against the rows, Clear; backup status and steps; inventory
  regions). `consoles.spec.ts` shoots them in light/dark (FIXED_PAGES) and audit + inventory at
  390 px: new screenshots, no baseline yet (`--update-snapshots` on first run).
- Checks (2026-10-16): `format:check` ok, web lint ok, web typecheck ok, web unit tests 162 files /
  1599 tests green, `next build` ok (routes `/admin/site/audit`, `/admin/site/backup`,
  `/admin/team/inventory`), public hygiene ok. No server change, so no `test:db`.

## Acceptance criteria

- [x] ac-1 Site Audit log: paged, filterable (action, actor, team, time; plus category), chain
      status, read-only, site admins only, tests.
- [x] ac-2 Team Inventory per D19/D32; Site Backup with instructions and the status the server has.
- [x] ac-3 Registry guard against placeholders for started/done tickets; web search on hold.

## Open questions

- The browser spec and the new screenshots need a gate1 run after deploy.
