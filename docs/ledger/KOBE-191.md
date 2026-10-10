# KOBE-191: Model image capability and native_media on run.start

- **Status:** in review (migration PR #162, feature PR below)
- **Branch / worktree:** `kobe-191-model-image-capability` in `../Kobe-wt191`
- **Depends on:** KOBE-144

## Plan

PR 1 (#162, migration only): `model_catalog.input_modalities`. PR 2: admin API and UI, discovery, server sets
`native_media`, one path-confinement helper, drop `WorkspaceSync.shareFile`.

## Decisions

- **`input_modalities text[] NOT NULL DEFAULT '{text}'`** over `supports_images boolean`: providers
  report modalities as a list (audio/video/pdf later need no new migration); the check allows only
  known values and requires `text`. Today's allowed set: `text`, `image`.
- `model_catalog` is install-wide (`tenancy/models.ts` `installWide`): no `team_id`, no RLS change; the
  probe suite is unaffected.
- **Admin API:** `input_modalities` on POST/PATCH `/v1/install/models/catalog`; `text` is implied (`["image"]`
  is stored as `["text","image"]`); unknown values are 400. Audit `models.catalog.changed` gets
  `imageSupportChanged`. UI: "Accepts images" checkbox in the add and edit forms, "Input" column.
- **Discovery:** `BifrostAdmin.listModelInfo` reads `input_modalities` (top level or `architecture`) from
  Bifrost's `/api/models`; the provider models view gains `image_models`. The UI ticks the box when the
  picked model is listed there, unless the admin already clicked it. Providers that report nothing (Ollama
  often) leave it to the admin.
- **native_media:** `listRunAttachments(..., nativeImages)`; `modelAcceptsImages(tx, alias)` (runs/models.ts)
  reads the catalog for the run's resolved model, at start and on recovery restart. Marks png/jpeg/gif/webp
  only; PDFs and other files never. The agent still re-checks type, size and confinement.
- **Confinement:** `services/sandbox-agent/src/workspace-confine.ts` (`confineFile`: realpath equality, no
  symlink, regular file, `allowMissing`) is the single physical check; `share-path.ts` and
  `threads/attachments.ts` keep their lexical rules, error classes and tests.
- `WorkspaceSync.shareFile`/`SharedFile` removed (unused since `share_file` goes through the sandbox
  broker, KOBE-149); its db test removed. `sharedKey` and the `workspace.file_shared` audit action stay.

## Open questions (for Chris or the coordinator)

- Bifrost's `/api/models` field name for input modalities is assumed (`input_modalities`); unverified against
  a live Bifrost. If absent, discovery just reports no image models.

## Evidence (acceptance criteria → test or command output)

- ac-1: `runs-attachments.db.test.ts` "native media" (image marked for a vision model, none for text-only,
  PDF/text never); `workspace-confine.test.ts` plus the unchanged `share-path` and `attachments` tests;
  `models.db.test.ts`, `models-discovery.db.test.ts`, `models-pages.test.tsx`; packages/db `models.db.test.ts`.
