# KOBE-647: SMA11a: Site-wide legal hold for Site memories

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** phase 1 (migration, 03fa6e6d, PR #543) and phase 2 (server, console, docs) committed
  separately on `kobe-647-sm-site-hold`
- **Branch / worktree:** `kobe-647-sm-site-hold` in `../Kobe-wt647` (based on `kobe-646-sm-migration`)
- **Depends on:** KOBE-378, KOBE-646 (migration 0223)

## Plan

1. Migration alone: `0224_site_legal_holds` (generated table) + `0225_site_legal_hold_guard` (custom SQL:
   lifecycle trigger, KH001 guards on the Site memory tables). Upgrade test.
2. Server: sweeps / version cap / purge skip held Site rows (hold lock first, as `retention/memory.ts`);
   Site console create/release; `governance.site_legal_hold.*` audit events; guide + `/llms.txt`.

## Decisions

- **Separate site-wide table `site_legal_holds`, not a nullable `legal_holds.team_id`.** `legal_holds`
  rows are read by `legal_hold_covers`, `memory_legal_hold_covers`, `audit_log_pii_held`,
  `legal_hold_refuse_truncate`, `legalHoldsForTeam`/`isUnderLegalHold` and the server store, all of
  which assume a team; a team-less row would silently change some of them (e.g. "any active hold"
  truncate refusal, the console list joining teams) and make `teamId` nullable across the server.
  The new table has no team_id (site-wide like `site_settings`, no RLS), grants SELECT/INSERT/UPDATE
  only (never deleted), reuses the `legal_hold_status` enum and the same CHECKs minus the subject.
- **Guard is a copy of `legal_holds_guard()` without subject checks**
  (`legal_hold_other_admin_exists(who, NULL)`); `legal_holds_guard()` is untouched. Approval takes the same exclusive advisory lock
  (`kobe.legal_hold`), so `legal_hold_lock_shared()` orders Site purges too. Release does not reset the
  audit PII sweep (a Site hold covers no audit rows).
- **Scope of the hold:** any active Site hold refuses every DELETE on `site_memory_items` and
  `site_memory_item_versions` (statement-level AFTER DELETE, transition table) — purge, version-cap
  pruning and item cascades alike — and TRUNCATE of both (owner backstop). UPDATEs (archive, supersede)
  stay allowed. `run_site_memory_items` is Workspace data: it follows its run under Workspace holds
  (0217); its only Site-side removal path (item/version delete) is refused in the same statement.
- Two migration files (generated + custom) because `db:rebase` regenerates generated files and would
  drop hand-added SQL (same split as 0216/0217).

- **Phase 2 shape.** Own route `/v1/site/site-legal-hold` (store `legal-hold/site-store.ts`), not a
  third scope on `/v1/site/legal-hold`: the Workspace hold API, its body and its confidentiality
  rules stay untouched. Several Site holds may be open at once (one per matter, like Workspace holds).
  Console: a "Site memory (Site-wide hold)" section on the Legal hold page reusing the hold table
  parts (`legal-hold-parts.tsx`).
- **M1:** `pruneVersions` asks `siteMemoryHeld()` (hold lock, then `site_legal_hold_active()`) before
  any delete; Site pruning no longer looks at team-wide Workspace holds (the old stand-in "any active hold").
- **L2:** `siteMemoryHeld()` refuses outside READ COMMITTED; `withSiteMemoryPurge()` is the wrapper
  for Site sweeps/purges (READ COMMITTED, hold lock first, skips when held). No Site sweep or purge
  exists on main yet: KOBE-386 (sweeps) and any Site item delete must use it.
- **L3:** `patchItem` on a Site item under a Site hold adds `memory.item.changed_under_hold` (kind,
  tag count + HMAC-SHA-256 (key derived from the auth secret, purpose `memory.audit.tag-fingerprint`) of the sorted lowercased tag list, policy, asOf before/after; never tag values — coordinator decision 2026-11-13).
  Pin/archive/restore are not recorded beyond their existing events.

- **Phase-2 review (review-647.md):** P2-L2 guide/console copy say tags are a count + fingerprint;
  P2-L3 keyed HMAC (`memory/items/tag-fingerprint.ts`); P2-L4 static test
  `legal-hold/site-memory-deletes.test.ts` fails on any Site memory delete outside the prune path or
  `withSiteMemoryPurge`/`siteMemoryHeld`. P2-L1 decided by Chris 2026-11-13: a hold on a person
  (`legal_holds.user_id`) keeps every version of any Site item they wrote a version of; pruning skips
  the item and `withSiteMemoryPurge` hands purges a `siteItemAuthorsUnheld` filter they must apply.
  Team-wide holds name no person and still don't reach the Site (interpretation; flag if wrong).

## Open questions (for Chris or the coordinator)

- KOBE-386 must route its Site sweeps through `withSiteMemoryPurge()`.

- Phase C: Site memory proposals (KOBE-653) should add the same guard to `site_memory_proposals`.

## Evidence (acceptance criteria → test or command output)

- ac-1: `packages/db/src/site-legal-hold-upgrade.db.test.ts` (9 tests; review L1 added the run-record paths: lifecycle, two-person rule,
  self-approval, withdraw/deny, no DELETE grant, KH001 on purge/prune/truncate incl. pre-upgrade items,
  Workspace memory unaffected, approval waits for purges, invoker + pinned search_path). catalog, probe,
  drizzle-privileges, app-role-capabilities, legal-hold, memory-version-prune-upgrade, semantic-memory,
  migrate: 1150 passed. `db:check` clean after commit.

- ac-2, ac-3: `services/server/src/site-legal-hold.db.test.ts` (8 tests: two-person place/release,
  deny/withdraw, Site-log audit without reason, edit past cap under hold prunes nothing and logs no
  refused delete (RED without the `versions.ts` change), team-wide hold no longer stops Site pruning, a held author's Site item keeps every version, purges skip it,
  purge skipped under hold + KH001 backstop, RR refused, L3 audit). Web:
  `apps/web/components/admin/legal-hold-page.test.tsx` (Site-wide request + place).
- ac-4: `docs/guide/memory.md#legal-hold-on-site-memory`, `docs/guide/admin/site-admin.md` (summary
  feeds `/llms.txt`), `docs/audit-log.md`.

## Phase 2 reminders (review of 65b6f027)

- M1: check the Site hold before pruning and skip the prune (an edit past the cap must not fail KH001).
- L2: sweeps run in READ COMMITTED (the guard reads holds with a fresh statement snapshot).
- L3: metadata changes on held Site items audited with before/after.
