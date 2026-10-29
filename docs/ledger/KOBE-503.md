# KOBE-503: Theming T7: chart-seeded branding defaults

- **Status:** in review (group branch `group-theming-2`; not pushed)
- **Branch / worktree:** `kobe-503-chart-branding-defaults` in `../Kobe-wt503`
- **Depends on:** KOBE-499 (branding API, settings keys, cache)

## Plan

Chart values `branding.appName` / `branding.preset` / `branding.showName` → server env
`KOBE_BRANDING_*` → validated in `config.ts` → start-up seed `seedBrandingDefaults` in
`seedAtStart` (after the gallery) writes each key only while unset → registered in
`@kobe/db` STARTUP_SEEDED_ROWS.

## Decisions

- **Only while unset, per key:** `INSERT … ON CONFLICT (key) DO NOTHING RETURNING key` in one
  transaction; two replicas starting together seed once. A second start writes and audits nothing.
- **Audited:** one `site.branding.updated` per written key, actor system, no team, same labels as
  the admin route (`theme:<preset>`, the name, `true`/`false`), as the gallery seed audits its
  agents. Cache: `brandingCache(db).invalidate()` after a write (this replica; others' 10 s TTL).
- **Config:** schema in `services/server/src/branding/defaults-config.ts` (protocol
  `appNameSchema`, `PRESET_IDS`); blank = unset; API server only (the scheduler never reads it).
  Invalid → `Invalid configuration: KOBE_BRANDING_…: <message>`.
- **Chart:** env only for set values; `showName` rendered only when `false` (true is the built-in
  default, so seeding it would only add a row). Schema enum of the six ids plus `""`; appName ≤ 40.
- **Restore registry:** `site_settings` rows with a branding key count as seeds only while no
  person's `site.branding.updated` event exists for that setting (the admin route audits in the
  same transaction as its write, so such an event marks the admin's choice: real data).
  `audit_log`: system `site.branding.updated` events (only this seed writes them as the system).
- A reset on the Appearance page unsets the key, so the next start seeds the chart value again
  (documented in values.yaml and docs/install.md: clear the chart value to keep the default).

## Open questions (for Chris or the coordinator)

- After an admin set then reset a key, a later re-seed of that key makes `kobe restore` refuse the
  target (the admin event still exists). Conservative; acceptable for a fresh-install restore?
- Chart render test `charts/kobe/tests/branding.test.ts` not run locally (no helm); CI runs it.

## Evidence (acceptance criteria → test or command output)

- ac-1: `services/server/src/branding/defaults.db.test.ts` (fresh seed, second run no-op, admin
  value survives, cache dropped and `GET /v1/site/branding` shows the seeded name/preset);
  `config.test.ts` (valid/blank/invalid/scheduler); chart test for the env block.
- ac-2: `services/server/src/startup-seeds.db.test.ts` now starts with all three values set
  (seeded once across two starts); `packages/cli/src/restore-target.db.test.ts` accepts a target
  seeded this way and refuses one an admin changed.
