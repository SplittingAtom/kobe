# KOBE-378: SMA3: Item store — versions, Undo, archive, supersede, pins, limits, Policy byte cap

- **Status:** in review (local commits; coordinator opens the PR)
- **Branch / worktree:** `kobe-378-sm-item-store` in `../Kobe-wt378` (on KOBE-381 + a local merge
  of KOBE-645; only the KOBE-378 commits are kept on rebase)
- **Depends on:** KOBE-376 (tables), KOBE-377 (contract), KOBE-380 (permissions), KOBE-381
  (switches, Site settings), KOBE-645 (`notifyMemory`). v1.3 wave A4.

## Plan

Three commits: (1) migration `0222_memory_version_prune` alone (coordinator 2026-11-13: the
immutability trigger refused every direct DELETE, so the version cap needed one); (2) contract
additions (protocol + OpenAPI); (3) the store (`services/server/src/memory/items/`), routes
(`routes/memory-items.ts`, mounted at `/v1/memory/semantic/items`), tests, docs.

## Decisions

- **0222** (custom): `semantic_memory_versions_immutable()` lets a direct DELETE through only for a
  version that is not its item's `current_version` and that no visible run record uses. Run records
  of the portable/Site lanes in other Workspaces are invisible under FORCE RLS (invoker rights, no
  SECURITY DEFINER), so a statement guard `run_memory_items_prune_guard` on the three run-record
  tables refuses (55000) a cascade that removes a run record whose version is gone while its item
  still exists (item, team and run deletes pass; a Workspace record whose team is gone passes, since
  the team cascade order is not fixed). KH001 hold guards unchanged. App role gets DELETE on the
  site-wide version tables (grants matrix). Tests: `packages/db/src/memory-version-prune-upgrade.db.test.ts`.
- **Contract additions (own commit, so it can land first):** `confirm_portable: true` required
  exactly for a portable create; `memory_lint_warning` carries warning `near_duplicate` with
  `duplicates[{id, version, similarity}]` (≤ 5); new code `memory_pin_limit` (409); constant
  `SEMANTIC_MEMORY_PINS_MAX = 10`. Fixtures `error-near-duplicate`, `error-pin-limit`.
- **Scopes → tables** (`items/location.ts`): every query goes through one location: `user` =
  Workspace table, `scope='user' AND owner = caller`; `team` = Workspace table, scope `team`;
  `portable` = `owner_user_id = caller`; `site` = all. Everything runs in one `withTeam()` of the
  active Workspace, so another person's personal item or another Workspace's item is a 404.
- **Rights** (`items/who.ts`): personal scopes: owner only; `team`: `teamMemoryAllows(curate)`
  (Team admins + Workspace stewards); `site`: `siteMemoryWriteAllows` on every write, with
  `policyField` = body names `policy` and `targetIsPolicy` = stored item is Policy (KOBE-380 M-1).
  Superseding a Policy item needs Policy rights too. Members read `team` and Site items.
- **Switches:** a scope must be on (`effective.memory.scopes`); a Policy item follows the Site
  master alone, so with Site memories off a Workspace's Site list shows Policy only.
- **Versions:** a statement change (patch, Undo) appends a version; kind/tags/`as_of`/`policy`
  change the item (contract). Undo copies an earlier statement into a new version.
- **Version cap:** after each appended version, prune the oldest versions past `version_cap`
  (default 50), skipping the current one and any version a run used; each delete in a savepoint (a
  run in another Workspace → 55000 → kept). Skipped entirely under a hold: Workspace items by
  `memory_legal_hold_covers`; portable by any active hold on the owner or any team-wide hold; Site
  by any active hold anywhere (conservative until KOBE-647's Site-wide hold).
- **Limits:** per-scope advisory lock, then count active items; create (+1, 0 when superseding)
  and restore (+1) block at 100% with `memory_scope_full` + `capacity`; nothing is evicted.
  Defaults changed in `site-settings.ts` to the brief's 300 user / 50 portable / 1,000 team /
  1,000 Site (KOBE-381 had 1,000 everywhere).
- **80% notice:** when a write takes the count from below `ceil(0.8 × max)` to at/above it,
  `notifyMemory(memory.scope.near_full)` once per crossing. `team`: Team admins + stewards, in the
  write's transaction. `site`: Site owner/admins + Site stewards; members of the active Workspace
  in-transaction, others after commit in their `user_last_teams` Workspace (best effort, logged).
  Personal scopes: list `usage` only (the notice kind is `team|site`).
- **Pins:** ≤ 10 pinned active items per scope; archiving unpins (so restore never breaks the
  cap); Policy never pinnable.
- **Policy budget:** active Policy ≤ 25 items and ≤ 2,048 UTF-8 bytes, checked on create, patch
  (statement or `policy: true`), Undo and restore, under a global advisory lock.
- **Near-duplicates:** `findNearDuplicates()` (pg_trgm `similarity ≥ 0.6`, current statements
  of active items in the same location, ≤ 5) on create, statement edit and Undo; Save anyway =
  `overrides.lint`, stored as `lint_override` and audited `memory.lint.override
{warnings:["near_duplicate"]}`. Import/candidate/approval (KOBE-385/396/398) must call
  `saveChecks()` / `findNearDuplicates()`. Restore does not re-check (no override in its body).
- **Tags** trimmed, lowercased, de-duplicated. `as_of` stored as a date (`null` clears).
- **Source thread** must be a thread of the active Workspace (400 otherwise).
- **Audit:** KOBE-377 names; Workspace items in the team log, portable/Site in the site log;
  ids/versions/counts only. `memory.policy.set` when `policy` flips.
- `overrides.policy_conflict` accepted and ignored until KOBE-379's checks exist.

- **Review 2026-11-13 (`docs/ledger/review-378.md`, untracked):** M-1 pruning takes
  `legal_hold_lock_shared()` before the hold check (portable/Site versions have no DB guard). L-1:
  run records in other Workspaces are invisible (RLS, no SECURITY DEFINER), so the prune query can
  exclude only visible run-used versions; a refused delete is kept and at most 2 refusals are tried
  per write (logged). Excluding them entirely needs a "used" marker (migration) — propose with the
  run-record writer (KOBE-382). L-2 source thread must pass `findThread` (own or shared). L-3 role
  refusal is `memory_not_allowed`; team-resolution codes documented in OpenAPI. L-4 both sides of
  a Policy flip must be enabled. L-5 concurrency tests. L-6 `supersedes_expected_version`
  (contract field, 409 `memory_version_conflict`). I-1: without a Workspace any signed-in user
  reads Site memories and Policy (Site = organisation); confirm with Chris.

## Docs

API behaviour: OpenAPI descriptions (`openapi/semantic-memory.ts`, `openapi.json`), upgrade note in
`docs/install.md`, Site settings defaults/behaviour in `docs/guide/admin/site-admin.md`.
**Guide pages owed by KOBE-384 (editor UI):** `docs/guide/memory.md` — saving to each scope (portable
confirmation), versions and Undo, archive/restore, supersede, pins (10 per scope, archiving unpins),
tags lowercased, `as_of`, the near-duplicate warning and Save anyway, the 80% warning and "full"
(archive to make room, nothing is removed). KOBE-385: Policy limits for Site admins.

## Open questions (answered by the coordinator 2026-11-13)

1. No `memory.item.updated` on the thread stream for API saves (no run, not in the contract);
   a ticket that saves from a thread adds it with its contract event.
2. Fixed: `user`/`team` routes need the active Workspace; `portable` and `site` routes don't
   (Site admins/stewards may belong to none). With an active Workspace (or team header or admin
   delegation) it is resolved as `requireTeam` does and its switches apply; without one only the
   Site switches apply, and the Site 80% notice goes to every curator after commit.
3. Site pruning stays suspended while any legal hold is active, until KOBE-647.
4. `NEAR_DUPLICATE_SIMILARITY = 0.6` (`memory/items/duplicates.ts`); KOBE-387's harness tunes it.

## Evidence (acceptance criteria → test or command output)

- **ac-1:** `services/server/src/memory-items.db.test.ts` "item lifecycle on all three tables"
  (user, portable, team, site: versions, conflict, Undo, pin, archive, restore, supersede, audit
  rows and log placement); walls: cross-user 404s (user, portable, also into another Workspace),
  cross-team 404s, curator-only writes, thread links hidden from non-authors.
- **ac-2:** `memory-items-limits.db.test.ts` "scope limits": notice to Team admins + stewards at
  4/5, none at 5, 409 `memory_scope_full` with capacity, nothing evicted, supersede at the limit,
  re-crossing notifies again, restore blocked when full; Site notice in this Workspace and in the
  steward's last Workspace; personal caps; pins.
- **ac-3:** `memory-items.db.test.ts` "Site items and Policy": stewards can't set/clear/edit
  Policy (403), Policy never pinnable, `memory.policy.set` audited, 4 × 499 B + 60 B and 26th item
  refused (`memory_policy_budget_full`), restore counts; `confirm_portable` required.
- **ac-4:** limits test "near-duplicates" (create, edit, Undo, other scope not compared, Save
  anyway audited), "stores as_of and lowercase tags", "version cap" (run-used version kept,
  portable/Site pruned, hold keeps all, release prunes). Migration: `memory-version-prune-upgrade.db.test.ts`.
- Unit: `services/server/src/memory/items/items.test.ts`. Review fixes:
  `services/server/src/memory-items-review.db.test.ts` (hold lock, thread access, Policy flip, supersede
  version, parallel creates/pins/Policy saves: exactly the room wins, one notice).
