# KOBE-191: Model image capability and native_media on run.start

- **Status:** in progress (migration PR first, then feature PR)
- **Branch / worktree:** `kobe-191-model-image-capability` in `../Kobe-wt191`
- **Depends on:** KOBE-144

## Plan

PR 1 (migration only): `model_catalog.input_modalities`. PR 2: admin API and UI, discovery, server sets
`native_media`, one path-confinement helper, drop `WorkspaceSync.shareFile`.

## Decisions

- **`input_modalities text[] NOT NULL DEFAULT '{text}'`** over `supports_images boolean`: providers
  report modalities as a list (audio/video/pdf later need no new migration); the check allows only
  known values and requires `text`. Today's allowed set: `text`, `image`.
- `model_catalog` is install-wide (`tenancy/models.ts` `installWide`): no `team_id`, no RLS change; the
  probe suite is unaffected.

## Open questions (for Chris or the coordinator)

## Evidence (acceptance criteria → test or command output)

- DB: `models.db.test.ts` "input modalities default to text...".
