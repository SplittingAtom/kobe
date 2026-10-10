# KOBE-195: chart s3.prefix

- `s3.prefix` (default "") in values.yaml and values.schema.json; pattern mirrors the server rule
  (`services/server/src/workspace-sync/s3.ts`): relative, ends in `/`. Not normalized: invalid values fail the render.
- Wired through `kobe.s3Env` (templates/_helpers.tpl) as `KOBE_S3_PREFIX`: server and scheduler. No other chart
  consumer reads S3; sandboxes hold no S3 settings. `kobe` CLI already reads `KOBE_S3_PREFIX` (documented).
- Test: `charts/kobe/tests/s3-prefix.test.ts`. Docs: docs/install.md (Object storage).
