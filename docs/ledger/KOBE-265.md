# KOBE-265: Bifrost ignores customer_id on team update: the kobe-install → kobe-site move never converges

- **Status:** in review (PR pending)
- **Branch / worktree:** `kobe-265-bifrost-customer` in `../Kobe-wt265`
- **Depends on:** KOBE-256 (done)

## Plan

Rename the legacy customer in place instead of create-and-move (fix option 1 of the ticket).

## Decisions

- **Why the move never converged (Bifrost v2.2.5 source, tag `transports/v2.2.5`):**
  `handlers/governance.go` `updateTeam` sets `team.CustomerID` from the request, but the team comes
  from `configstore.GetTeam`, which `Preload("Customer")`s; `RDBConfigStore.UpdateTeam` then
  `Save(team)`s, and GORM writes the belongs-to foreign key from the preloaded `Customer`, so the old
  customer wins. The PUT answers 200 with the old `customer_id`. A team **without** a customer can be
  attached (no preloaded association).
- **Customer update accepts `name`:** `UpdateCustomerRequest.Name` → `customer.Name`; teams keep
  `customer_id` (it is the id, not the name). Names are unique (`uniqueIndex`): renaming onto a taken
  name answers 500 "Failed to update customer", so an empty stray `kobe-site` is deleted first.
- **Deleting a customer detaches its teams** (200; teams stay with `customer_id: null`). The M2
  guard (never delete a customer that still owns teams) stays.
- **Reconcile (`services/server/src/models/reconcile.ts`):** `siteCustomer` picks the site customer:
  a legacy customer (`LEGACY_CUSTOMERS = ["kobe-install"]`) that holds the teams is renamed in
  place (stray `kobe-site` deleted first when it owns no teams). Nothing is created, renamed or
  deleted unless both customers and teams were listed. Teams: one without a customer is attached
  (`updateTeam`, supported); one under another customer is left alone with a warning (Bifrost cannot
  move it; it keeps working). Virtual keys are never touched by any of this.
- **Fake Bifrost** now matches v2.2.5: unique customer names, rename keeps teams, delete detaches
  teams, `updateTeam` leaves a team that has a customer unchanged.
- **Limits:** the rename sends `desired.customer.limits` (none are configured today; the server
  wires no customer limits).

## Open questions (for Chris or the coordinator)

- kobe-gate1 (ac-4): the first pass after deploy should log `changes 2` (delete stray
  `kobe-site`, rename `kobe-install`), then nothing; GET customers shows one `kobe-site` with the old
  `kobe-install` id and all 5 teams; 18 VKs unchanged. No manual cleanup needed.

## Evidence (acceptance criteria → test or command output)

- **Real Bifrost (pinned digest of v2.2.5, container on the remote Docker host), 2026-10-12:**
  reproduced the bug (PUT team `customer_id` → 200, team stays on `kobe-install`); then the fixed
  reconcile on an install synced under `kobe-install` with KOBE-256's stray `kobe-site`:
  pass 1 `changes 2, errors []` → one customer `kobe-site` (old id), all teams on it; pass 2
  `changes 0`; 10 virtual keys, ids and values unchanged.
- **ac-1/ac-2:** `reconcile.test.ts` "KOBE-265: renames kobe-install …", "after KOBE-256's
  create-and-move …" (second pass 0 changes, same VKs, no VK writes); opt-in real-Bifrost
  `bifrost.int.test.ts` "KOBE-265: an install synced under kobe-install converges"; k3d e2e
  (`e2e/run.sh`, suite shard) recreates the gate1 state on the real Bifrost and checks the rename,
  unchanged VK hash, and no Bifrost writes on the next pass.
- **ac-3:** `reconcile.test.ts` "Bifrost keeps a team's customer on update (the fake matches
  v2.2.5)"; failure paths: rename fails, stray delete fails, new team during rename, detached and
  foreign-customer teams.
- **ac-4:** coordinator, after deploy.
