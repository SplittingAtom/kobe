# KOBE-280: Model markers polish: "Model: X" at a thread's start, no same-model "Model changed", aligned gateway-model limits

<!-- Keep under ~150 lines: decisions and links to evidence, not pasted logs. -->

- **Status:** committed on `group-1-fixes` (group G1; no PR of its own)
- **Branch / worktree:** `group-1-fixes` in `../Kobe-g1`
- **Depends on:** KOBE-209 (markers), KOBE-217 (Regenerate with…), KOBE-279 (model_change on real Pi)

## Plan

1. Reproduce the real-Pi entry orders behind the markers (review-286 LOW 1–2, the KOBE-285 double marker).
2. Tests first: real-Pi tests pin the orders, web unit and component tests use copies of them.
3. Web: judge each `model_change` against the model its branch already records.
4. ac-3: one gateway-model pattern in `@kobe/protocol`, pinned by the kobe-models copy.

## Decisions

1. **The two "Model changed to" markers after Regenerate with… (KOBE-285) are two entries, each
   rendered once.** Real Pi 1.0.0 writes a new session's setup as `model_change A →
thinking_level_change → system`. Regenerating the first answer branches at `system` (the prompt's
   parent), so version 2 is `kobe.branch → model_change B → user → assistant`. The root
   `model_change A` sits above the fork, so the web carries its marker down to the first message of
   every version (KOBE-209 placement), where it read "Model changed to A". Version 2 therefore showed
   A (Pi's session setup) and B (the real switch). Nothing was rendered twice, and the branch has one
   switch entry.
2. **Fix (web only):** the tree projection tracks the model each branch records, the way Pi's
   `getBranchSelection` resolves it: the latest `model_change`, or the latest answer's `model`.
   - A `model_change` with no recorded model above it is the branch's first: "Model: A".
   - A `model_change` to the model already recorded shows nothing. This covers ac-2, review LOW 1
     (a Pi started without a model, then reused) and LOW 2 (a KOBE-259 limits re-select).
   - Anything else still reads "Model changed to B".
   - The `first` flag is in the marker's deps, so a projection rebuilt after older entries load
     re-renders it.
3. **No change in the sandbox agent for LOW 1/LOW 2.** The entries stay, since Pi needs them for
   its own branch model. The web hides them, which is the fix review-286 offered for LOW 2.
4. **ac-3:** `GATEWAY_MODEL_PATTERN` (provider ≤ 64, model ≤ 191) and `GATEWAY_MODEL_MAX_LENGTH`
   (256) live in `packages/protocol/src/sandbox-wire/frames.ts`, and `gatewayModelSchema` uses
   them. The kobe-models extension ships on its own and may import only builtins and its own files
   (its own test enforces this), so `kobe-models/protocol.ts` keeps its `GATEWAY_MODEL` copy, like
   its other protocol constants. `protocol.test.ts` pins the copy to the contract's pattern and checks
   that both sides accept and refuse the same ids at the 191/192 edge. A 192-character model part is
   now refused at `run.start`, before Pi starts. LOW 4: the stale "model alias → KOBE-41" comment is
   gone from `pi-launch.ts`.
5. **e2e:** `e2e/browser/tests/regenerate-with.spec.ts` now asserts exactly one "Model changed to"
   marker, before and after a reload. On gate1 it fails until a build with this fix is deployed,
   because gate1 runs main.

6. **Chains of model markers net out (coordinator decision, second commit).** Regenerating
   version 2 branches below its `model_change`, so version 3 used to show "Model: A · Model changed to
   B · Model changed to A". Now model markers with no message between them show only the net model
   for the next message (`netModelMarkers` in `marker-placement.ts`).
   - The net model is judged against the model in effect where the row starts (`from`): after the
     message above, or at the fork the row is carried from.
   - When it equals that model, the row shows nothing. Otherwise it shows one "Model changed to X".
   - The branch's first model always shows as "Model: X" (ac-1) and is the base for the changes
     after it. So version 3 back on A shows only "Model: A", version 3 on C shows "Model: A · Model
     changed to C", and the first Regenerate with… still shows exactly one "Model changed to".
   - Same-model entries are now dropped by the same rule instead of at creation.

## Open questions (for Chris or the coordinator)

- none

## Evidence (acceptance criteria → test or command output)

- **Real-Pi orders:** `services/sandbox-agent/src/kobe-models.model-change.real-pi.test.ts`. "regenerating the first answer on another model branches below the session's setup entries"
  pins the whole sequence. "a limits re-select on the same model records a same-model model_change"
  pins LOW 2. Copies are in `apps/web/lib/chat/testing/pi-sequences.ts`.
- **ac-1:** `apps/web/components/chat/markers.test.tsx` › "Regenerate with… another model shows the
  thread's model and one change on version 2" shows `Model: openai/gpt-fake` and then one
  `Model changed to anthropic/claude-fake`. Version 1 shows only the first.
  `lib/chat/tree-model-markers.test.ts` covers the projection, and `regenerate-with.test.tsx` covers
  the flow (`Model: kimi`, `Model changed to glm`).
- **ac-2:** `markers.test.tsx` › "a same-model model_change shows no marker" (real LOW 2 order);
  `tree-model-markers.test.ts` (repeat, switch back, an answer's model as the record, branches,
  and chains: back on A, on C, mid-thread, below a fork); `regenerate-with.test.tsx` ac-3.
- **ac-3:** `packages/protocol/src/sandbox-wire/gateway-model.test.ts`;
  `services/sandbox-agent/src/kobe-models/protocol.test.ts` (pin and 191/192 agreement).
- Without the web fix, the new web tests fail (8 failed). With it: `pnpm verify` passes, and so
  does the sandbox-agent suite with real Pi (92 files, 910 tests). Two exceptions are local only:
  `@kobe/cli` test:db needs `pg_dump`, which is not installed on the Mac, and `license:check` needs
  pnpm 12 (run as `npx pnpm@12.8.1`).
