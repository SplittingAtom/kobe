# KOBE-127: 55a Contract: artifacts (tool inputs, wire frames, kobe-tools channel, API types)

- **Status:** in review
- **Branch / worktree:** `kobe-127-artifacts-contract` in `../Kobe-wt127`
- **Depends on:** none. Blocks KOBE-128..130. Design: [KOBE-55](KOBE-55.md) D-1, D-2, D-4, D-6 types.

## Plan

`packages/protocol` only, additive, tests first.

## Decisions

- New `packages/protocol/src/artifacts.ts` (exported from the index): `CAPABILITY_ARTIFACTS = "artifacts"`,
  kinds, `createArtifactInputSchema` / `updateArtifactInputSchema` (strict; content cap 512 KiB measured in
  UTF-8 bytes; title 1-200; `language` only for `code`), `artifactToolInputSchema` map by tool name,
  `KOBE_TOOLS_FD = 4`, `kobeToolsRequestSchema` / `kobeToolsResponseSchema`, REST schemas
  `artifactSummarySchema`, `artifactListResponseSchema`, `artifactDetailSchema`.
- Frames in `sandbox-wire/frames.ts`: `artifact.put` (sandbox -> server; union of two shapes so `input`
  must match `tool`) and `artifact.result` (server -> sandbox, open error code via the same pattern as
  `OPEN_CODE_PATTERN`). `artifact.put` has its own 1 MiB entry in `SANDBOX_FRAME_MAX_BYTES_BY_TYPE`.
- Capability and frames are documented in `connection.ts` and `artifacts.ts`.
- `artifacts.ts` keeps its own copy of the open-code regex to avoid a cycle with `frames.ts`.
- 512 KiB of content with heavy JSON escaping can exceed 1 MiB; the cap on the frame and
  `policy.check` is the real limit, and kobe-tools (55b) must refuse such a call up front (noted in docs).

## Open questions (for Chris or the coordinator)

- None blocking. Server-side `artifact.put` checks (D-3) are for 55c; the frame schema only validates shape.

## Evidence (acceptance criteria -> test or command output)

- ac-1 additive, own PR, schema tests: `packages/protocol/src/artifacts.test.ts`, updated cap test in `sandbox-wire/frames.test.ts`.
- ac-2 512 KiB cap and six kinds: `artifacts.test.ts` ("create_artifact input").
- ac-3 documented: `artifacts.ts`, `sandbox-wire/connection.ts` header.
- `pnpm verify` green (see the PR's CI).
