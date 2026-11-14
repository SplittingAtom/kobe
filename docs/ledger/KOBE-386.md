# KOBE-386: SMA11: semantic memory retention sweeps, offboarding and SSO/SCIM deactivation

- **Status:** in review (local commit; coordinator opens the PR)
- **Branch / worktree:** `kobe-386-sm-sweeps` in `../Kobe-wt386`, based on `kobe-647-sm-site-hold`
- **Depends on:** KOBE-378, KOBE-647 (`withSiteMemoryPurge`), KOBE-648
- **Migration:** none. The 0217/0222 retention scrub and delete guards were enough.

## What it does (SM28 rows)

| Row                                   | Where                                                                                                                | Rule                                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace archived/superseded items   | `retention/semantic-memory.ts` (nightly team pass, step `semantic_memory`)                                           | gone with every version once unchanged longer than the team window; nothing while the team keeps forever; an item another item supersedes into waits for it |
| Workspace earlier versions            | same                                                                                                                 | gone once replaced longer ago than the window; never the current one or one a run used                                                                      |
| Evidence of a purged conversation     | `purgeBatchInTx` (same transaction as the thread delete) + the sweep (every other path, and held rows once released) | `evidence`, `source_thread_id`, `source_entry_ids` set to NULL (the scrub 0222 allows); the statement stays ("source deleted")                              |
| Site items and versions               | `retention/site-semantic-memory.ts`, once per new pass before the teams                                              | as above against the Site window (`retention_days`, default 365, KOBE-381); only through `withSiteMemoryPurge`                                              |
| Portable items and versions           | same file, own READ COMMITTED transaction, hold lock first                                                           | as above against the Site window                                                                                                                            |
| Departed member's `user` items        | `offboarding/purge.ts` step 4a (`purgeDepartedSemanticInTx`)                                                         | after the 30-day window (`sandboxes.retain_until`), unless the person is an active member again or held                                                     |
| Workspace/Site items the person wrote | (nothing)                                                                                                            | stay ("former member")                                                                                                                                      |
| Portable items on deactivation        | `purgePortableForUser`, `POST /v1/site/users/:id/portable-memory/purge`, Site console › Users › **Purge memories**   | kept until a site admin purges; refused for an active account (409 `user_active`) and under a hold (409 `legal_hold`); reactivation finds them unchanged    |

Holds: Workspace rows use `memory_legal_hold_covers` (owner's hold; any hold in the team for
`team` items) after `lockLegalHolds`. Site rows: `withSiteMemoryPurge` (Site-wide hold → nothing;
`unheld(item)` skips items a held person wrote). Portable rows (Q2, coordinator 2026-11-13): an active
hold on the owner, or a Workspace-wide hold on a Workspace the owner is a member of (members read
per held Workspace with `withTeam`, inside the locked transaction). The version cap's prune
(`memory/items/versions.ts`) uses the same rule (`legal-hold/portable-hold.ts`; `Op.db` added for
the per-Workspace reads); Site and Workspace items keep their KOBE-647/376 rules.

Run records of the portable/Site lanes are in Workspace tables the site-wide transaction cannot
see, so each portable/Site delete runs in a savepoint: a delete the 0217/0222 guards refuse (a run
used the version; an item with run records in a held Workspace) is kept and counted (`kept`), and
not retried in the same pass (bounded: 5,000 tries per lane per pass).

Audit (counts only, in `docs/audit-log.md`): `retention.semantic_memory_purged` (team; reason
retention|offboarding, items, versions, scrubbed, userId?) and `retention.site_memory_purged`
(site; lane site|portable, reason retention|offboarding, items, versions, kept, userId?; actor =
the admin for a purge).

## Decisions

1. **Departure without a sandbox.** The 30-day record is the `sandboxes` row (as for volumes and
   personal Notes). `offboardSandbox` now also records it when the member owns `user` items but
   never had a sandbox, and restarts it when a member came back without waking one and left
   again (row `destroyed`, `retain_until` NULL, items present). The offboarding sweep catches
   departed owners with no open record (`departedMemoryOwners`). Such a member shows in the team's
   Offboarded list like any other.
2. **Deactivation counts as leaving each Workspace** for `user` items (as for volumes, Notes and
   Workbench drafts): they go 30 days after deactivation unless reactivated first. Portable items
   are the only ones kept until an admin purge (Q7).
3. **A return keeps the items:** the offboarding delete re-checks active membership, so a member
   re-added before the purge keeps their memories even if the old record is due.
4. **Superseded items** are purged with archived ones (both are inactive history); the brief
   names "archived items".
5. **Admin purge path:** the brief says "through offboarding (offboardMember)"; leaving one
   Workspace must not touch portable items, so the purge is a site-wide `Offboarding.purgePortable`
   behind a site-admin route (same who-may-act rules as deactivation), not `offboardMember`.
   Respects `KOBE_RETENTION_PAUSED` (503 `retention_paused`).
6. **Stale** (coordinator 2026-11-13; `memory/items/stale.ts`): an active item whose `updated_at`
   and `as_of` (when set) are both older than the Site's `stale_after_days` (default 90; UTC,
   `as_of` fresh on the cutoff day). Computed `stale` flag on every item response (list, get,
   create/edit) and `stale=true|false` list filter; both optional in the contract, openapi.json
   regenerated. A review label: nothing archives or deletes by it.
7. **JIT duplicate:** portable items are keyed on `users.id`; a new account starts empty with no
   code change. Tested with a second account (not through the OIDC flow).

## Resolved questions (coordinator 2026-11-13)

1. "Source deleted" / "former member" stay UI inferences (after the scrub a version has no
   evidence and no thread; `actor_kind = 'pass'` always had a source). Accepted, with the other
   decisions above.
2. Workspace-wide holds freeze only portable items of that Workspace's members (done, tested).

## Docs

Guide: `docs/guide/memory.md` new section "How long memories are kept"; `admin/site-admin.md`
(Users › Purge memories), `admin/team-admin.md` (removed member's memories),
`admin/single-sign-on.md` (SCIM deactivation/reactivation, JIT). `/llms.txt` is generated from
the guide. Audit names in `docs/audit-log.md`.

## Evidence (acceptance criteria → test or command output)

- ac-1: `semantic-memory-retention.db.test.ts` › Workspace sweep (archived/superseded chain,
  versions, forever, held owner + Workspace-wide hold, hold-lock race, evidence scrub on thread
  purge incl. held-until-released) and Site and portable sweep (window, Site-wide hold, held
  author, held portable owner).
- ac-2: › offboarding (30-day purge, former-member item stays, portable stays; inside window /
  hold / returned member keep; no-sandbox owner gets the window) and › deactivation (admin purge:
  active 409, held 409, purge + audit as admin).
- Q2: › Workspace-wide holds and portable items (sweep + admin purge, member vs non-member);
  `memory-items-limits.db.test.ts` › version cap (prune kept for a held Workspace's member only).
- Stale: › stale (flags, `stale=true|false`, threshold setting); `memory/items/stale.test.ts`;
  protocol `semantic-memory.test.ts`.
- ac-3: › deactivation (SCIM deactivate → sweeps → refused by another source → reactivated by the
  same source: rows and versions byte-identical, listed again; JIT duplicate empty).
- ac-4: guide pages above; `site-pages.test.tsx` covers the Purge memories button.
- ac-5: Site deletes only in `site-semantic-memory.ts` through `withSiteMemoryPurge`;
  `legal-hold/site-memory-deletes.test.ts` green.
