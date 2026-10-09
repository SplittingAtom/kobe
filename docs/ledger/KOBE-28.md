# KOBE-28: Offboarding: sandbox destroy and 30-day volume retention

- **Status:** in review
- **Branch / worktree:** `kobe-28-offboarding` in `../Kobe-wt28`
- **Depends on:** KOBE-22 (provider), KOBE-13 (membership, `deps.lifecycle`), KOBE-17 (legal hold),
  KOBE-27 (workspace S3 copy), KOBE-18 (`purgeDepartedMember` is a separate step, see below)

## Plan

`services/server/src/offboarding/`: `destroy.ts` (destroy + retain), `purge.ts` (sweep step),
`export.ts` + `zip.ts` (team-admin zip), `reinstate.ts` (returning member), `index.ts` (service,
sweep timer). Provider gets `destroySandbox` / `deleteVolume`. Hooks: member removal
(`routes/team.ts`), deactivation (`deps.lifecycle` hook `sandbox-offboarding`), `offboardTeam()`.

## Decisions

- **No migration.** `sandboxes` already has state `destroyed`, `pvc` and `retain_until` (KOBE-25
  reserved them for this ticket, check `sandboxes_retain_until`), and team tables get full CRUD grants.
  So no retention table, no separate migration PR. Three new audit actions only (code, no schema).
- **Destroy order.** Kubernetes first: the PVC's ownerReference is removed (PATCH) before the claim is
  deleted, otherwise agent-sandbox's cascade would delete the volume (KOBE-22 note). A failed patch
  throws before anything is deleted. Then one team transaction: row -> `destroyed`, `retain_until =
now() + 30 d`, connection row closed, `sandbox.offboarded` audited. The row is kept, never deleted
  (KOBE-40: a missing row counts as a live sandbox in the gateway check).
- **Removal still succeeds if Kubernetes is down** (the membership change is committed first); the
  failure is logged and the **sweep** (every 10 min, one replica via advisory lock
  `kobe.offboarding-sweep`) finds sandboxes of non-members / deactivated users (`reconciled`).
- **Export (ac-2):** `GET /v1/team/offboarded` (list) and `/:userId/export` (zip), permission
  `team.members.manage` (team admin). Built from the durable S3 copy (manifest `workspace_files` +
  `blob_key`), not the PVC (nothing mounts it). fflate streaming deflate, one chunk in memory, a missing
  object aborts the stream (no silently truncated zip). Allowed only while `destroyed` and
  `retain_until > now()`. Audited (`sandbox.export_downloaded`, counts) before the first byte.
- **Purge (ac-3), per member, resumable steps**, each in a short transaction that takes
  `lockLegalHolds`, checks `isUnderLegalHold(teamId, userId)` (user or team-wide hold) and re-locks the
  sandbox row: (1) delete PVC (Kubernetes) and clear `pvc`, (2) manifest rows + server-written objects
  under the member's own key tree, (3) content-addressed blobs, (4) `workspace_sync` row,
  `retain_until = NULL`, `sandbox.volume_deleted` (counts). Held: nothing is deleted, the next sweep
  looks again (logged, not audited every 10 min). `retain_until` stays set until step 4, so a crash resumes.
- **Returning member (KOBE-25 open question 2):** a wake that finds a `destroyed` row calls
  `reinstate` (new `LifecycleOptions.reinstate`): under a legal hold it is refused; otherwise the old
  retained volume is deleted, the row dropped and the wake is a first start that restores from S3.
  Chosen over a separate retention table: one row per (team, user) stays the single record.
- **Team removal:** there is no team-deletion feature yet (and `sandboxes.team_id` cascades, which
  would destroy the retention record). `offboardTeam(teamId)` exists and is tested; whoever adds team
  deletion must call it first and keep the team row for 30 days.
- **Provider/RBAC:** manager role gets `persistentvolumeclaims` get/patch/delete (chart test).
  `deleteVolume` only accepts `workspace-u-<uuid>` names.
- **fake-kube fix:** `patch` now applies metadata changes (it ignored them).
- Audit events live under the existing `sandbox` category: `sandbox.offboarded`,
  `sandbox.export_downloaded`, `sandbox.volume_deleted` (docs/audit-log.md).

## Open questions (for Chris or the coordinator)

1. Thread data of a departed member (KOBE-18 `purgeDepartedMember`) is a separate step; it is not
   called from this sweep. Should the same sweep call it after the 30 days (same hold rule)?
2. `shared/` objects (KOBE-54 `share_file` copies) are durable by design and are not purged here.
3. A deactivated user who is reactivated keeps the destroyed sandbox until their next wake (then
   reinstated); their volume is deleted after 30 d from deactivation if they never come back.

## Evidence (acceptance criteria -> test or command output)

| AC   | Evidence                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ac-1 | `offboarding.db.test.ts` "removal destroys the sandbox at once...", deactivation, team removal, Kubernetes-down + sweep; `sandbox/provider-offboarding.test.ts` (volume detached before claim delete, retry) |
| ac-2 | `offboarding.db.test.ts` "the team admin can export...": zip contents, audit, 403 for members, 404 after 30 d, other team                                                                                    |
| ac-3 | `offboarding.db.test.ts` "the sweep deletes the volume after 30 days...": deletion + audit, user hold, team hold, release, Kubernetes failure retry; returning member (hold refuses)                         |
