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
- **Guard** (`lib/admin/nav/types.ts`, `registry.test.ts`; reworked after review): see
  "Review fixes" below.
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

- `components/admin/site-audit-page.test.tsx` (18): section gating (admin/owner yes, user no),
  rows and columns, read-only (GET only), no chain check on open, Verify chain verified/broken
  with time and announcements, 429 keeps the last result, the Load more race, loading state,
  live-region messages and focus, seconds and zone, the inclusive To bound, 400 and 403, all six filters in
  the query, Clear, client-side validation (no request), paging keeps filters, 5xx hidden,
  erasure window, unknown erasure period, plain text and dropped fields, helpers.
- `components/admin/site-backup-page.test.tsx` (4): ready section, last restore, never restored,
  paused, steps and docs pointer, no host/IP/URL on the page, refused audit read shown.
- `components/admin/team-inventory-page.test.tsx` (11): the moved KOBE-86/94/180 tests plus skills,
  connectors (enabled only, disabled by site, custom count, drift), empty and failed lists, links.
- `team-pages.test.tsx`: Agents page no longer requests the inventory and links to it.
- `overview.test.tsx`, `console-shell.test.tsx`: on-hold text in the overview, nav and page.
- e2e (gate1, later): `e2e/browser/tests/console-sections.spec.ts` opens the three pages (chain
  status, a category filter checked against the rows, Clear; backup status and steps; inventory
  regions). `consoles.spec.ts` shoots them in light/dark (FIXED_PAGES) and audit + inventory at
  390 px: new screenshots, no baseline yet (`--update-snapshots` on first run).
- Checks (2026-10-16, after the review fixes): `format:check`, web lint and typecheck ok; web unit tests 163 files /
  1611 tests green, `next build` ok (routes `/admin/site/audit`, `/admin/site/backup`,
  `/admin/team/inventory`), public hygiene ok. No server change, so no `test:db`.

## Review fixes (coordinator review, 2026-10-16)

- **Must: category list.** `AUDIT_CATEGORIES` now has all 21 categories the server accepts (adds
  mcp, memory, project, retention, schedule, skill). `lib/admin/api/site/audit-categories.test.ts`
  reads `AUDIT_EVENTS` in `packages/db/src/audit/events.ts` (the web app can't import @kobe/db)
  and fails when the list differs from the actions' first segments. `docs/audit-log.md` updated.
- **Load more / filters:** `use-audit-view.ts` owns the first page per applied filters: each
  apply starts a new view id, shows "Loading audit events…" (old rows leave the screen, Apply and
  Clear disabled), and drops late answers for older views. The table is keyed by view id and
  ignores a "Load more" page that lands after it unmounted. One polite live region in Events
  says what each load brought ("Showing 50 events; more can be loaded.", "Loaded 2 events more:
  3 events shown, the whole log for these filters."); when the last page is in, focus moves to
  the Events heading. A 400 with an action filter says the name is unknown.
- **Chain announcements:** a status region mounted from the start announces verifying, verified
  (with time and count), broken (the Notice is now a note, not a second alert), the rate limit and
  failures. After a later failure the old result is labelled "Previous result, checked …".
- **Times:** `DateTime precise` (seconds and time zone) in the audit table and "Last checked"; the
  From hint names the viewer's time zone; **To** includes its whole minute (`+59 999 ms`).
- **Inventory access tests:** section visible only with `team.agents.suspend` (member, builder,
  admin without it, site owner: no); a 403 renders as an error; the Agents page shows no Inventory
  link to builders or admins without the permission. Agents page link uses `consoleHref`.
- **Backup restore snippet:** adds the S3 variables and the new Secret names
  (`auth.existingSecret`, `envelope.keySecret`), placeholders only; tested.
- **Guard approach:** the open list moved into `types.ts` as `OPEN_PLACEHOLDER_TICKETS`, and
  `comingIn()`/`onHold()` accept only its ids, so naming any other ticket is a type error. For
  each listed ticket the test checks: it has a reason; no `docs/ledger/<ticket>.md` exists; it is
  not recorded as finished in `docs/RUN-LEDGER.md` (named exactly in "## Done", or on a line that
  says done or merged; line-level on purpose, so a false match fails loudly); and a placeholder
  still names it. A self-test proves the run-ledger matcher finds KOBE-6 and doesn't confuse
  KOBE-6 with KOBE-63. Deterministic (files only). **Limit:** Hadron is the source of truth but
  unit tests can't reach it, so a ticket closed in Hadron with neither a ledger nor a run-ledger
  entry still passes; the list is one line per ticket and is reviewed whenever it is touched.
- Nits: "Last checked" label; "hidden here" wording for erased IPs; code comments name the
  product owner, not a person.

## Acceptance criteria

- [x] ac-1 Site Audit log: paged, filterable (action, actor, team, time; plus category), chain
      status, read-only, site admins only, tests.
- [x] ac-2 Team Inventory per D19/D32; Site Backup with instructions and the status the server has.
- [x] ac-3 Registry guard against placeholders for started/done tickets; web search on hold.

## Open questions

- The browser spec and the new screenshots need a gate1 run after deploy.
